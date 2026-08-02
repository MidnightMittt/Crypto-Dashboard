import { BiasChange, MarketBias, MetricVerdict, RiskLevel, Verdict } from "./types";
import { TechnicalRead } from "@/types/market";

/**
 * Rolls every MetricVerdict into one answer: is the market leaning bullish,
 * bearish, or neither — and how much evidence stands behind that.
 *
 * `score` runs 0-100 with 50 exactly neutral. It is a WEIGHTED SUM OF
 * OPINIONS, not a probability and not a price target. Two things keep it
 * honest:
 *
 *   1. Each metric contributes its weight scaled by its own confidence, so
 *      a high-weight metric built on thin data can't dominate a
 *      well-evidenced one.
 *   2. Missing metrics are dropped and the remaining weights renormalized —
 *      never defaulted to neutral. Same rule as computeCompositeSentiment
 *      and buildMarketThesis; defaulting absent data to 50 would drag every
 *      reading toward the middle and make a data outage look like calm.
 */

/**
 * Relative importance per metric. Extends the scheme already used in
 * marketThesis.ts rather than inventing a second, competing one — the
 * ordering there (funding and squeeze heaviest, premium and flow lightest)
 * carries over, with the new sources slotted in by how much independent
 * information they add.
 *
 * These do not need to sum to 1: only their ratios matter, since absent
 * metrics force a renormalization anyway.
 */
const WEIGHTS: Record<string, number> = {
  funding: 0.15,
  squeezeRisk: 0.14,
  technicals: 0.13,
  orderFlow: 0.1,
  openInterest: 0.09,
  basis: 0.08,
  longShort: 0.08,
  etfFlows: 0.08,
  options: 0.06,
  exchangeFlow: 0.06,
  spotPerpVolume: 0.05,
  stablecoins: 0.04,
  coinbasePremium: 0.03,
  liquidations: 0, // backward-looking; shown for context, never scored
};

/** Score distance from 50 beyond which the roll-up reads as directional rather than balanced. */
const DIRECTIONAL_THRESHOLD = 6;

function weightFor(id: string): number {
  return WEIGHTS[id] ?? 0.05;
}

/** Signed contribution: +1 bullish, -1 bearish, 0 neutral. */
function directionSign(verdict: Verdict): number {
  return verdict === "bullish" ? 1 : verdict === "bearish" ? -1 : 0;
}

function verdictFromScore(score: number): Verdict {
  if (score >= 50 + DIRECTIONAL_THRESHOLD) return "bullish";
  if (score <= 50 - DIRECTIONAL_THRESHOLD) return "bearish";
  return "neutral";
}

/**
 * Risk is about how DANGEROUS conditions are, independent of direction —
 * a strongly bullish read in a crowded, volatile, conflicted market is a
 * high-risk bullish read, and collapsing those two ideas into one number
 * would hide exactly the thing worth knowing.
 */
function assessRisk(
  metrics: MetricVerdict[],
  technicals: TechnicalRead | null,
  squeezeScore: number | null
): { level: RiskLevel; rationale: string } {
  const reasons: string[] = [];
  let points = 0;

  const conflictCount = metrics.filter((m) => m.conflicts.length > 0).length;
  if (conflictCount >= 4) {
    points += 2;
    reasons.push(`${conflictCount} metrics carry internal contradictions`);
  } else if (conflictCount >= 2) {
    points += 1;
    reasons.push(`${conflictCount} metrics disagree with related signals`);
  }

  if (squeezeScore !== null && squeezeScore >= 70) {
    points += 2;
    reasons.push(`squeeze conditions are elevated (${squeezeScore}/100)`);
  } else if (squeezeScore !== null && squeezeScore >= 50) {
    points += 1;
    reasons.push(`squeeze conditions are building (${squeezeScore}/100)`);
  }

  if (technicals?.atrPct != null) {
    if (technicals.atrPct >= 4) {
      points += 2;
      reasons.push(`daily volatility is high (ATR ${technicals.atrPct.toFixed(1)}% of price)`);
    } else if (technicals.atrPct >= 2.5) {
      points += 1;
      reasons.push(`daily volatility is moderate (ATR ${technicals.atrPct.toFixed(1)}% of price)`);
    }
  }

  const level: RiskLevel = points >= 4 ? "high" : points >= 2 ? "medium" : "low";
  const rationale = reasons.length
    ? `${level === "high" ? "High" : level === "medium" ? "Medium" : "Low"} risk: ${reasons.join("; ")}.`
    : "Low risk: signals are consistent, volatility is contained, and no squeeze setup is building.";

  return { level, rationale };
}

function buildHeadline(verdict: Verdict, score: number, confidence: number, conflicted: boolean): string {
  const strength = Math.abs(score - 50);

  if (verdict === "neutral") {
    return conflicted
      ? "Signals are actively conflicting — there is no coherent directional read right now."
      : "Evidence is balanced between bullish and bearish — no directional edge right now.";
  }

  const direction = verdict === "bullish" ? "bullish" : "bearish";
  const qualifier =
    strength >= 20 ? "clearly" : strength >= 12 ? "moderately" : "modestly";
  const caveat =
    confidence < 40
      ? " — but the evidence behind it is thin, so treat it as a tilt rather than a setup"
      : conflicted
        ? " — though several metrics disagree, so conviction is limited"
        : "";

  return `Market is leaning ${qualifier} ${direction}${caveat}.`;
}

export interface MarketBiasInputs {
  asset: string;
  metrics: MetricVerdict[];
  technicals: TechnicalRead | null;
  squeezeScore: number | null;
  /** Verdicts from the previous reading, keyed by metric id. Null on first run. */
  previous: Record<string, Verdict> | null;
  now: number;
}

export function buildMarketBias(inputs: MarketBiasInputs): MarketBias | null {
  const { asset, metrics, technicals, squeezeScore, previous, now } = inputs;
  if (metrics.length === 0) return null;

  /*
   * Each metric's pull is weight x its own confidence. Without the
   * confidence term a heavily-weighted metric running on one venue would
   * carry the same force as one corroborated across twenty.
   */
  let weightedSum = 0;
  let totalWeight = 0;

  for (const m of metrics) {
    const w = weightFor(m.id) * (m.confidence / 100);
    if (w <= 0) continue;
    totalWeight += w;
    weightedSum += directionSign(m.verdict) * w;
  }

  if (totalWeight <= 0) return null;

  // -1..+1 renormalized across whatever actually reported, then mapped to 0-100.
  const normalized = weightedSum / totalWeight;
  const score = Math.round(50 + normalized * 50);
  const verdict = verdictFromScore(score);

  /*
   * Aggregate confidence is weighted by the same weights, so it answers
   * "how well-evidenced is the picture overall" rather than treating a
   * throwaway metric as equal to the heaviest one.
   */
  const confidenceWeightTotal = metrics.reduce((s, m) => s + weightFor(m.id), 0);
  const confidence =
    confidenceWeightTotal > 0
      ? Math.round(metrics.reduce((s, m) => s + m.confidence * weightFor(m.id), 0) / confidenceWeightTotal)
      : 0;

  // Ranked by weight x confidence so the best-supported reasons lead, not
  // merely the loudest-sounding ones.
  const rank = (m: MetricVerdict) => weightFor(m.id) * (m.confidence / 100);
  const topBullish = metrics
    .filter((m) => m.verdict === "bullish")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 5);
  const topBearish = metrics
    .filter((m) => m.verdict === "bearish")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 5);

  const changes: BiasChange[] = [];
  if (previous) {
    for (const m of metrics) {
      const before = previous[m.id];
      if (before && before !== m.verdict) {
        changes.push({ label: m.label, from: before, to: m.verdict });
      }
    }
  }

  const conflicted = metrics.filter((m) => m.conflicts.length > 0).length >= 3;
  const risk = assessRisk(metrics, technicals, squeezeScore);

  return {
    asset,
    score,
    verdict,
    confidence,
    headline: buildHeadline(verdict, score, confidence, conflicted),
    topBullish,
    topBearish,
    changes,
    isFirstReading: previous === null,
    riskLevel: risk.level,
    riskRationale: risk.rationale,
    metrics,
    updatedAt: now,
  };
}

/** Compact snapshot persisted between readings so "what changed" can be real. */
export function snapshotVerdicts(metrics: MetricVerdict[]): Record<string, Verdict> {
  return Object.fromEntries(metrics.map((m) => [m.id, m.verdict]));
}
