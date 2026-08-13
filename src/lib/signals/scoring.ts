import { MetricVerdict, Verdict } from "./types";

/**
 * The one weighted-scoring implementation, shared by the overall market
 * bias (`marketBias.ts`) and the category rollups (`categories.ts`).
 *
 * Extracted because both need the EXACT same rule — weight each metric by
 * its own confidence, drop absent metrics, renormalize across whatever
 * actually reported — and a second hand-copied implementation is how a
 * category score and the overall score quietly drift apart over time.
 */

/**
 * THE ROLE TAXONOMY — the decision-engine redesign's central subtraction
 * (docs/DECISION_ENGINE_REDESIGN.md §5/§7/§12).
 *
 *  - `edge`    PREDICTS. Has a historical source in the census, so its claim
 *              to move the composite is falsifiable — and gets falsified
 *              (funding's own row is currently a measured anti-signal at 24h;
 *              its weight is a debt the census keeps visible).
 *  - `state`   DESCRIBES. Structure, trend character, regime. Real, useful,
 *              rendered — and NEVER a vote: describing where the market is
 *              carries no claim about where it goes, and the census agreed
 *              (marketStructure @7d is BH-significant in the WRONG direction;
 *              technicals' 13-vote blob sits at 48% @24h). State's jobs are
 *              to condition which Edge statistics apply, gate the planner,
 *              and set stop context.
 *  - `context` DISPLAYED ONLY. Either no historical source exists to test it
 *              (orderFlow, options, exchangeFlow, spotCvd, sectorBreadth,
 *              coinbasePremium), or it is backward-looking (liquidations), or
 *              its record failed the corrected census (fearGreed: nominal
 *              p≈0.048 at 24h that does not survive BH-FDR across the scan).
 *              An engine whose brand is statistical honesty cannot let an
 *              untestable reading move the score.
 *
 * Every id `evaluateAll()`/`buildEquityEvidence()` can emit MUST appear here;
 * `metricWeight` treats an undeclared id as 0, so a metric cannot vote by
 * default — it has to be classified first.
 */
export type MetricRole = "edge" | "state" | "context";

export const METRIC_ROLES: Record<string, MetricRole> = {
  funding: "edge",
  squeezeRisk: "edge",
  openInterest: "edge",
  basis: "edge",
  longShort: "edge",
  etfFlows: "edge",
  spotPerpVolume: "edge",
  stablecoins: "edge",
  macroLiquidity: "edge",

  technicals: "state",
  marketStructure: "state",
  equityRelativeStrength: "state",
  equityBreadth: "state",
  equityTrendQuality: "state",
  equityRiskAppetite: "state",
  equityVolatilityRegime: "state",

  orderFlow: "context",
  spotCvd: "context",
  options: "context",
  exchangeFlow: "context",
  coinbasePremium: "context",
  sectorBreadth: "context",
  fearGreed: "context",
  liquidations: "context",
};

export function metricRole(id: string): MetricRole | null {
  return METRIC_ROLES[id] ?? null;
}

/**
 * Relative importance per EDGE metric — only edge metrics appear, because
 * only edge metrics vote. The ratios for the survivors are unchanged from
 * the pre-taxonomy table (re-earning weights from measured performance is a
 * later step of the same redesign; this step is subtraction only).
 *
 * These do not need to sum to 1: only their ratios matter, since absent
 * metrics force a renormalization anyway.
 */
export const METRIC_WEIGHTS: Record<string, number> = {
  funding: 0.15,
  squeezeRisk: 0.14,
  openInterest: 0.09,
  basis: 0.08,
  longShort: 0.08,
  etfFlows: 0.08,
  spotPerpVolume: 0.05,
  stablecoins: 0.04,
  macroLiquidity: 0.04, // market-wide macro backdrop signal, same weight class as stablecoins — genuinely backtestable (FRED has real history)
};

/**
 * TRANSITIONAL, TRACKED EXCEPTION — the five equity evidence modules are
 * State by classification, but the Markets and Scanner surfaces currently
 * present nothing except the bias composite built from them; stripping
 * their vote today would null every equity read on the site without a
 * replacement presentation. They keep their old default weight until the
 * equity State-presentation redesign lands, at which point this table is
 * deleted. `marketStructure` is deliberately NOT here: it loses its vote
 * everywhere immediately, because its 7d record is BH-significant in the
 * wrong direction — an exception for a measured anti-signal would be
 * indefensible.
 */
const TRANSITIONAL_STATE_VOTERS: Record<string, number> = {
  equityRelativeStrength: 0.05,
  equityBreadth: 0.05,
  equityTrendQuality: 0.05,
  equityRiskAppetite: 0.05,
  equityVolatilityRegime: 0.05,
};

/**
 * CORRELATION CLUSTERS among the Edge voters — the redesign's §4
 * double-counting map, made executable. funding, basis, squeezeRisk and
 * longShort all read the same leveraged-demand phenomenon; when they agree
 * it is ONE cluster agreeing, and any statistic that counts them as four
 * independent opinions inflates exactly when a user most needs it honest.
 * Every edge voter not named here is its own cluster. Used by
 * marketBias.ts's agreement figure; the SCORE still weights metrics
 * individually — clustering fixes the concurrence claim, not the vote.
 */
export const EDGE_CLUSTERS: Record<string, string> = {
  funding: "leverage",
  basis: "leverage",
  squeezeRisk: "leverage",
  longShort: "leverage",
};

export function clusterOf(id: string): string {
  return EDGE_CLUSTERS[id] ?? id;
}

/** Score distance from 50 beyond which a roll-up reads as directional rather than balanced. */
export const DIRECTIONAL_THRESHOLD = 6;

export function metricWeight(id: string): number {
  if (METRIC_ROLES[id] === "edge") return METRIC_WEIGHTS[id] ?? 0;
  return TRANSITIONAL_STATE_VOTERS[id] ?? 0;
}

/** Signed contribution: +1 bullish, -1 bearish, 0 neutral. */
export function directionSign(verdict: Verdict): number {
  return verdict === "bullish" ? 1 : verdict === "bearish" ? -1 : 0;
}

export function verdictFromScore(score: number): Verdict {
  if (score >= 50 + DIRECTIONAL_THRESHOLD) return "bullish";
  if (score <= 50 - DIRECTIONAL_THRESHOLD) return "bearish";
  return "neutral";
}

export interface WeightedScoreResult {
  /** 0-100, 50 exactly neutral. A weighted sum of opinions — not a probability. */
  score: number;
  verdict: Verdict;
  /** Weighted-average evidence quality across the contributing metrics. */
  confidence: number;
  /** Sum of weight actually used — callers can tell "nothing reported" from a real neutral. */
  totalWeight: number;
}

/**
 * Weight each metric by `weightFn(id) x confidence/100`, drop anything with
 * zero weight, renormalize across the rest. Returns null when nothing
 * contributed at all — the caller's job to decide what that means (an
 * absent category vs. a genuinely neutral one are different states).
 */
export function computeWeightedScore(
  metrics: MetricVerdict[],
  weightFn: (id: string) => number
): WeightedScoreResult | null {
  let weightedSum = 0;
  let totalWeight = 0;
  let confidenceWeightTotal = 0;
  let confidenceWeightedSum = 0;

  for (const m of metrics) {
    const baseWeight = weightFn(m.id);
    if (baseWeight <= 0) continue;

    confidenceWeightTotal += baseWeight;
    confidenceWeightedSum += m.confidence * baseWeight;

    const w = baseWeight * (m.confidence / 100);
    if (w <= 0) continue;
    totalWeight += w;
    weightedSum += directionSign(m.verdict) * w;
  }

  if (totalWeight <= 0) return null;

  /*
   * SHRINKAGE TOWARD 50 BY EVIDENCE MASS.
   *
   * `weightedSum / totalWeight` is the direction the evidence points, on
   * -1..1. It is a RATIO, so it reaches ±1 whenever the contributing metrics
   * agree — even if there is only one of them and it is barely confident.
   * That produced the reading this fixes: SPY's leadingDrivers category
   * scored 100 off a single 45%-confidence metric, and the composite printed
   * "STRONGLY BULLISH 92" directly above a sentence admitting the evidence
   * was thin.
   *
   * Neutral metrics were already damping correctly — they add to
   * `totalWeight` and contribute 0 to `weightedSum`. The missing piece was
   * that CONFIDENCE only decided how metrics were weighted against each
   * other, never how extreme their conclusion was allowed to be.
   *
   * `evidenceMass` is the confidence-weighted share of the available weight,
   * arithmetically the mean confidence of the contributors. As a multiplier
   * it says: a direction is only as extreme as the evidence behind it is
   * good. Unanimous metrics at 100% confidence still reach 0 or 100; the
   * same unanimity at 45% reaches 73. No magic constant, nothing clamped —
   * the two terms are already the two things a score should depend on.
   */
  const evidenceMass = confidenceWeightTotal > 0 ? totalWeight / confidenceWeightTotal : 0;
  const normalized = (weightedSum / totalWeight) * evidenceMass;
  const score = Math.round(50 + normalized * 50);

  return {
    score,
    verdict: verdictFromScore(score),
    confidence:
      confidenceWeightTotal > 0 ? Math.round(confidenceWeightedSum / confidenceWeightTotal) : 0,
    totalWeight,
  };
}

/** Rank used everywhere a "best-supported metric" needs picking — weight x confidence. */
export function rankMetric(m: MetricVerdict): number {
  return metricWeight(m.id) * (m.confidence / 100);
}

/**
 * "Strongly Bullish" vs "Bullish" vs "Leaning Bullish" vs "Neutral" — text
 * intensity from a 0-100 score, so a reading's magnitude is legible without
 * a second color. This is the resolution to a direct conflict between two
 * asks: a 6-hue color spec would have undone the prior session's explicit
 * reduction to a 3-color (bullish/neutral/bearish) vocabulary. Confirmed
 * with the user: keep exactly 3 colors, carry intensity in the label text
 * and a filled meter instead of new hues.
 */
export function intensityLabel(score: number): string {
  const distance = Math.abs(score - 50);
  const direction = score > 50 ? "Bullish" : "Bearish";
  if (distance < DIRECTIONAL_THRESHOLD) return "Neutral";
  if (distance < 15) return `Leaning ${direction}`;
  if (distance < 30) return direction;
  return `Strongly ${direction}`;
}
