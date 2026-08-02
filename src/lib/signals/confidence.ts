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
