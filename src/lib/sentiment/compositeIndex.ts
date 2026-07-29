import { ExchangeSnapshot } from "@/types/market";

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function scale(v: number, inMin: number, inMax: number): number {
  return clamp(((v - inMin) / (inMax - inMin)) * 100, 0, 100);
}

interface CompositeInputs {
  weightedFundingRatePct: number;
  oiChange24hPct: number | null;
  oiPercentile: number | null;
  longShortRatio: number | null;
  priceChange24hPct: number;
  exchanges: ExchangeSnapshot[];
}

/**
 * 0-100 composite score.
 *
 * Components whose underlying data is unavailable are dropped and the
 * remaining weights renormalized, rather than being filled with a neutral
 * placeholder — a missing input shouldn't quietly drag the score toward 50.
 *
 * Weights are a defensible starting point, not settled science. Tune them
 * once you've watched the score behave against real markets.
 */
export function computeCompositeSentiment(inputs: CompositeInputs): number {
  const components: Array<{ score: number; weight: number }> = [];

  // Funding: the most direct read on positioning.
  components.push({ score: scale(inputs.weightedFundingRatePct, -0.2, 0.2), weight: 0.3 });

  // Price momentum.
  components.push({ score: scale(inputs.priceChange24hPct, -10, 10), weight: 0.2 });

  if (inputs.oiPercentile !== null || inputs.oiChange24hPct !== null) {
    const parts: number[] = [];
    if (inputs.oiPercentile !== null) parts.push(inputs.oiPercentile);
    if (inputs.oiChange24hPct !== null) parts.push(scale(inputs.oiChange24hPct, -15, 25));
    components.push({
      score: parts.reduce((s, v) => s + v, 0) / parts.length,
      weight: 0.25,
    });
  }

  if (inputs.longShortRatio !== null) {
    components.push({ score: scale(inputs.longShortRatio, 0.5, 1.8), weight: 0.15 });
  }

  // Volume turnover relative to open interest — how hot the churn is.
  //
  // Only count venues that report BOTH figures. Some sources (Coinalyze)
  // supply open interest but not volume, and including their OI in the
  // denominator while their volume is absent from the numerator deflates
  // turnover artificially — dragging the composite down by an amount that
  // varies per asset depending on which provider covers it. That produced a
  // spurious divergence between assets rather than a real one.
  const priced = inputs.exchanges.filter((e) => e.volume24hUsd > 0 && e.openInterestUsd > 0);
  const totalVolume = priced.reduce((s, e) => s + e.volume24hUsd, 0);
  const totalOi = priced.reduce((s, e) => s + e.openInterestUsd, 0);
  if (totalOi > 0 && totalVolume > 0) {
    components.push({ score: scale(totalVolume / totalOi, 0.5, 4), weight: 0.1 });
  }

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 50;

  const composite = components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
  return Math.round(clamp(composite, 0, 100));
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
