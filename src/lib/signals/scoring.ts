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
 *  - `state`   DESCRIBES. Structure, trend character, regime, POSITIONING.
 *              Real, useful, rendered — and NEVER a vote: describing where
 *              the market is carries no claim about where it goes, and the
 *              census agreed (marketStructure @7d is BH-significant in the
 *              WRONG direction; technicals' 13-vote blob sits at 48% @24h).
 *              State's jobs are to condition which Edge statistics apply,
 *              gate the planner, and set stop context.
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
  etfFlows: "edge",
  stablecoins: "edge",
  macroLiquidity: "edge",

  /*
   * POSITIONING IS A DESCRIPTION. `longShort` was an Edge voter at 0.08 until
   * the module-breadth read measured what it actually is — see the block
   * comment on EDGE_CLUSTERS below for the full arithmetic. In one line: its
   * only input, the long/short ratio, is also the input that decides
   * `squeezeRisk`'s direction, and the two map it to OPPOSITE verdicts
   * (crowd-long reads bullish here, bearish there). On all 1181 replay
   * observations where both took a position they took opposite ones, so they
   * were never two opinions.
   *
   * Which of the two directions is right is not a matter of taste, and it is
   * not settled: over those 1181 observations the fade reading returns t=0.04
   * at 24h and the trend reading t=-0.04, on nEff=49. The mirror is exact
   * because the observations are the same observations.
   *
   * So the ratio keeps exactly one predictive claim — squeezeRisk's fade,
   * which is the better-informed of the two (it requires funding to confirm
   * the crowded side, and it has the historical source). `longShort` keeps
   * the reading it can actually support: the crowd IS positioned this way.
   * That sentence is true; "and therefore price rises" was the part nothing
   * measured.
   */
  longShort: "state",

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

  /*
   * A DEMOTED SIGNAL WAS VOTING THROUGH A WRAPPER. `spotPerpVolume` was an
   * Edge voter at 0.05 whose verdict was `ctx.technicals.direction`, gated on
   * spot-led turnover — see evaluateSpotPerpVolume's comment for the full
   * account. `technicals` sits two blocks up in "state" precisely because the
   * census measured it below the base rate, and this wrapper carried its
   * direction into the composite anyway, on 417 of 2896 replayed days even
   * when `technicals` had declared the trend too weak to call.
   *
   * "context" rather than "state", for one specific reason: the verdict is now
   * PERMANENTLY neutral, and a permanently-neutral read must not vote in ANY
   * basis. State metrics carry weight 1 under `stateWeight`, so classifying it
   * there would leave a always-neutral vote waiting to drag a state composite
   * to 50 the first time some caller emitted it. `liquidations` is the same
   * shape — backward-looking, permanently neutral — and sits in the same
   * place.
   *
   * The ratio itself is not discarded. It moved to the row it describes:
   * evaluateTechnicals now raises the leverage-led warning as a conflict on
   * Price Action, which is the read whose durability it was always about.
   */
  spotPerpVolume: "context",
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
  etfFlows: 0.08,
  stablecoins: 0.04,
  macroLiquidity: 0.04, // market-wide macro backdrop signal, same weight class as stablecoins — genuinely backtestable (FRED has real history)
};

/**
 * WHICH QUESTION a composite answers — and therefore which metrics vote.
 *
 * "edge": the predictive composite. Only Edge-role metrics vote, at their
 * METRIC_WEIGHTS; State and Context describe but never move the score.
 * This is the only basis with any backtested record behind it.
 *
 * "state": a CONDITIONS read — what the market currently is (trending,
 * broad, risk-on), never a claim about what happens next. Only State-role
 * metrics vote, at EQUAL weight: no measured record differentiates them,
 * and unequal weights would imply a calibration that does not exist. This
 * is what the equity surfaces present, since every equity module is State;
 * it replaced (and deleted) the old TRANSITIONAL_STATE_VOTERS exception
 * under which those five modules voted in the edge composite at 0.05 each.
 * Equal weights then, equal weights now — the numbers are identical, but
 * the claim is finally labelled as the description it always was.
 */
export type ScoreBasis = "edge" | "state";

/**
 * Vote weight for a metric under a given basis. See ScoreBasis. Anything
 * that is not exactly "state" falls back to edge weighting — a MarketBias
 * persisted before the basis field existed is a crypto edge read, and
 * treating an undefined basis as state would silently rescore it.
 */
export function weightForBasis(basis: ScoreBasis | undefined): (id: string) => number {
  return basis === "state" ? stateWeight : metricWeight;
}

function stateWeight(id: string): number {
  return METRIC_ROLES[id] === "state" ? 1 : 0;
}

/**
 * CORRELATION CLUSTERS among the Edge voters — the redesign's §4
 * double-counting map, made executable. funding, basis and squeezeRisk all
 * read the same leveraged-demand phenomenon; when they agree it is ONE
 * cluster agreeing, and any statistic that counts them as three independent
 * opinions inflates exactly when a user most needs it honest. Every edge
 * voter not named here is its own cluster. Used by marketBias.ts's agreement
 * figure; the SCORE still weights metrics individually — clustering fixes
 * the concurrence claim, not the vote.
 *
 * ── Why longShort is no longer in this map ──────────────────────────────
 *
 * Because clustering was the wrong instrument for it. Clustering says "these
 * read one phenomenon, so count their concurrence once". longShort and
 * squeezeRisk were not two correlated reads of one phenomenon — they were
 * one input under two opposite sign conventions, and no amount of
 * concurrence-counting repairs that.
 *
 * The arithmetic the clustering could not reach, all of it measured on the
 * replay rather than assumed:
 *
 *   1. THE SCORE. Both voted at full weight, squeezeRisk 0.14 and longShort
 *      0.08, and they are opposed on 1181 of 1181 shared observations. That
 *      is not a double vote — it is a deterministic 57% CANCELLATION, the
 *      composite quietly running squeezeRisk at 0.06 whenever both fired.
 *      Nobody chose 0.06. It was the residue of subtracting two weights that
 *      were each set for a different reason.
 *
 *   2. THE SAME IDEA AT THREE WEIGHTS. Worse than a wrong weight: the
 *      leveraged-positioning idea voted at 0.06 on the 1181 observations
 *      where both wrappers fired, at 0.14 on the 1167 where only squeezeRisk
 *      did, and at 0.08 — IN THE OPPOSITE DIRECTION — on the 91 where only
 *      longShort did. The weight on an idea moved with which wrapper
 *      happened to clear its own threshold.
 *
 *   3. THE AGREEMENT FIGURE, which clustering was supposed to protect, was
 *      the thing clustering broke. marketBias.ts counts a cluster whose
 *      members point both ways as a disagreement — correctly, since two
 *      reads of one phenomenon conflicting is real news. But these two could
 *      not do anything else. The leverage cluster was FORCED to split on all
 *      1181 observations, so the statistic reported a conflict that was a
 *      property of the sign conventions and never of the market.
 *
 * Removing the metric from the Edge roster fixes all three at once: the
 * marketBias loop skips anything with zero weight, so longShort leaves the
 * cluster arithmetic by the same act that stops it voting.
 */
export const EDGE_CLUSTERS: Record<string, string> = {
  funding: "leverage",
  basis: "leverage",
  squeezeRisk: "leverage",
};

export function clusterOf(id: string): string {
  return EDGE_CLUSTERS[id] ?? id;
}

/** Score distance from 50 beyond which a roll-up reads as directional rather than balanced. */
export const DIRECTIONAL_THRESHOLD = 6;

export function metricWeight(id: string): number {
  return METRIC_ROLES[id] === "edge" ? (METRIC_WEIGHTS[id] ?? 0) : 0;
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
export function rankMetric(m: MetricVerdict, weightFn: (id: string) => number = metricWeight): number {
  return weightFn(m.id) * (m.confidence / 100);
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
