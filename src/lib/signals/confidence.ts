/**
 * The single definition of "confidence" used across the decision engine.
 *
 * Confidence here scores EVIDENCE QUALITY, never the likelihood of a price
 * move. See MetricVerdict's doc comment in ./types.ts for why that
 * distinction is load-bearing in this codebase.
 *
 * Three independent inputs, multiplied rather than averaged:
 *
 *   completeness — how much of the data this read wants actually arrived.
 *   agreement    — how well the independent sources behind it line up.
 *   backtested   — whether historical evidence covers this reading at all.
 *
 * Multiplied because these are conjunctive: a reading built on one venue
 * out of twenty is weak NO MATTER how internally consistent it looks, and
 * averaging would let a perfect agreement score paper over that. Any single
 * input near zero should collapse the result, which is exactly what a
 * product does and a mean does not.
 */

export interface ConfidenceInputs {
  /** 0-1. Fraction of the desired inputs that reported. */
  completeness: number;
  /** 0-1. 1 = every source agrees, 0.5 = evenly split, 0 = direct contradiction. */
  agreement: number;
  /**
   * Whether a real backtest covers this metric. Absence is NOT penalized to
   * zero — most metrics here have no historical coverage and that shouldn't
   * make them worthless, it should just cap how confident they can look.
   */
  backtested?: boolean;
}

/** Ceiling on confidence for a metric with no historical validation behind it. */
const UNBACKTESTED_CEILING = 0.85;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function scoreConfidence({ completeness, agreement, backtested = false }: ConfidenceInputs): number {
  const raw = clamp01(completeness) * clamp01(agreement);
  const ceiling = backtested ? 1 : UNBACKTESTED_CEILING;
  return Math.round(clamp01(raw) * ceiling * 100);
}

/**
 * The human-readable "why this confidence" line. Written to be legible to
 * someone who will never read this file — it names the actual limiting
 * factor rather than restating the score.
 */
export function describeConfidence({ completeness, agreement, backtested = false }: ConfidenceInputs): string {
  const parts: string[] = [];

  if (completeness >= 0.9) parts.push("full data coverage");
  else if (completeness >= 0.6) parts.push("partial data coverage");
  else parts.push("thin data coverage");

  if (agreement >= 0.85) parts.push("sources agree closely");
  else if (agreement >= 0.6) parts.push("sources mostly agree");
  else parts.push("sources disagree");

  parts.push(backtested ? "backed by backtested history" : "no backtest covers this metric");

  return `${parts.join("; ")}.`;
}

/**
 * Agreement across a set of directional readings, as the fraction siding
 * with the majority, rescaled so an even split reads as 0 rather than 0.5.
 *
 * Neutral readings are excluded rather than counted as agreement — a metric
 * where three of four sources have no opinion is not a strong consensus,
 * and treating "no view" as concurrence would systematically overstate
 * confidence on quiet data.
 */
export function agreementOf(directions: Array<"bullish" | "bearish" | "neutral">): number {
  const directional = directions.filter((d) => d !== "neutral");
  if (directional.length === 0) return 0.5; // nothing to agree or disagree about
  const bull = directional.filter((d) => d === "bullish").length;
  const majority = Math.max(bull, directional.length - bull);
  const ratio = majority / directional.length; // 0.5 (split) .. 1 (unanimous)
  return clamp01((ratio - 0.5) * 2);
}

/**
 * One named category/metric pulling the overall MarketBias.confidence
 * number up or down — the AI Confidence Gauge's "what's actually driving
 * this" explanation. Cites the real numbers already on CategoryScore/
 * MetricVerdict (categories.ts's combineCategoryScores already weights the
 * overall figure by these same per-category confidences), never a new
 * computation of its own.
 */
export interface ConfidenceDriver {
  categoryLabel: string;
  categoryConfidence: number;
  /** categories.ts's CATEGORY_WEIGHTS for this category, as a whole percent — how much its confidence pulls on the overall number. */
  weightPct: number;
  metricLabel: string;
  metricConfidenceBasis: string;
}

/**
 * The highest- and lowest-confidence categories, each paired with their own
 * strongest/weakest metric as the concrete "why." Returns null with fewer
 * than 2 categories or when every category reads identical confidence —
 * nothing to honestly contrast in either case. Callers pass `weight`
 * (categories.ts's CATEGORY_WEIGHTS for that category) directly rather than
 * this function looking it up by name — keyed lookups by display label are
 * one rename away from silently breaking.
 */
export function findConfidenceDrivers(
  categories: Array<{
    label: string;
    confidence: number;
    weight: number;
    metrics: Array<{ label: string; confidence: number; confidenceBasis: string }>;
  }>
): { booster: ConfidenceDriver; drag: ConfidenceDriver } | null {
  if (categories.length < 2) return null;
  const withMetrics = categories.filter((c) => c.metrics.length > 0);
  if (withMetrics.length < 2) return null;

  const sorted = [...withMetrics].sort((a, b) => b.confidence - a.confidence);
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];
  if (highest.confidence === lowest.confidence) return null;

  const strongestIn = (c: (typeof withMetrics)[number]) =>
    [...c.metrics].sort((a, b) => b.confidence - a.confidence)[0];
  const weakestIn = (c: (typeof withMetrics)[number]) =>
    [...c.metrics].sort((a, b) => a.confidence - b.confidence)[0];

  const boosterMetric = strongestIn(highest);
  const dragMetric = weakestIn(lowest);

  return {
    booster: {
      categoryLabel: highest.label,
      categoryConfidence: highest.confidence,
      weightPct: Math.round(highest.weight * 100),
      metricLabel: boosterMetric.label,
      metricConfidenceBasis: boosterMetric.confidenceBasis,
    },
    drag: {
      categoryLabel: lowest.label,
      categoryConfidence: lowest.confidence,
      weightPct: Math.round(lowest.weight * 100),
      metricLabel: dragMetric.label,
      metricConfidenceBasis: dragMetric.confidenceBasis,
    },
  };
}
