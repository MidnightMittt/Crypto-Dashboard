/**
 * The old flat-weighted "is the market bullish" composite score
 * (computeCompositeSentiment) lived here until it was retired in favor of
 * lib/signals/marketBias.ts's buildMarketBias — a category-weighted,
 * confidence-scaled, backtested engine reading all 15 scored metrics. Two
 * competing "is it bullish" numbers from two independent codepaths was
 * exactly the "each widget computes its own opinion" problem the project
 * charter (CLAUDE.md) rules out — one market, one truth. This file now only
 * holds computations that are still each the ONE source of truth for what
 * they measure: leverage-heat risk and OI percentile ranking.
 */

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function scale(v: number, inMin: number, inMax: number): number {
  return clamp(((v - inMin) / (inMax - inMin)) * 100, 0, 100);
}

interface LeverageHeatInputs {
  weightedFundingRatePct: number;
  oiChange24hPct: number | null;
  priceChange24hPct: number;
}

/**
 * "Is leverage increasing while price stalls?" — high OI growth plus high
 * funding magnitude plus a flat price is the combination that precedes a
 * liquidation cascade.
 *
 * Returns null without OI data: heat is fundamentally a statement about
 * leverage *building*, and there's no honest way to say that without
 * knowing whether open interest is rising.
 */
export function computeLeverageHeat(inputs: LeverageHeatInputs): number | null {
  if (inputs.oiChange24hPct === null) return null;

  const fundingMagnitude = scale(Math.abs(inputs.weightedFundingRatePct), 0, 0.2);
  const oiGrowth = scale(inputs.oiChange24hPct, -10, 30);
  const priceStall = scale(3 - Math.abs(inputs.priceChange24hPct), 0, 3);

  const heat = oiGrowth * 0.45 + priceStall * 0.25 + fundingMagnitude * 0.3;
  return Math.round(clamp(heat, 0, 100));
}

export function computeOiPercentile(
  currentOi: number,
  history: Array<{ openInterestUsd?: number }>
): number | null {
  const values = history.map((h) => h.openInterestUsd ?? 0).filter((v) => v > 0);
  if (values.length < 12) return null;
  const below = values.filter((v) => v <= currentOi).length;
  return Math.round((below / values.length) * 100);
}
