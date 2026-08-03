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
 * Relative importance per metric, reused for both the overall score and
 * for ranking metrics WITHIN a category. Extends the scheme already used in
 * marketThesis.ts rather than inventing a second, competing one — the
 * ordering there (funding and squeeze heaviest, premium and flow lightest)
 * carries over, with newer sources slotted in by how much independent
 * information they add.
 *
 * These do not need to sum to 1: only their ratios matter, since absent
 * metrics force a renormalization anyway.
 */
export const METRIC_WEIGHTS: Record<string, number> = {
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
  fearGreed: 0.03,
  liquidations: 0, // backward-looking; shown for context, never scored
};

/** Score distance from 50 beyond which a roll-up reads as directional rather than balanced. */
export const DIRECTIONAL_THRESHOLD = 6;

export function metricWeight(id: string): number {
  return METRIC_WEIGHTS[id] ?? 0.05;
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

  const normalized = weightedSum / totalWeight;
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
