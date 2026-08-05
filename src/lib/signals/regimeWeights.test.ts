import { describe, expect, it } from "vitest";
import { regimeAdjustedCategoryWeights } from "./regimeWeights";
import { Category } from "./types";

const BASE: Record<Category, number> = {
  leveragedPositioning: 0.35,
  spotDemand: 0.3,
  marketStress: 0.2,
  liquidityMap: 0.15,
};

function sum(weights: Record<Category, number>): number {
  return Object.values(weights).reduce((a, b) => a + b, 0);
}

describe("regimeAdjustedCategoryWeights", () => {
  it("returns base weights completely unchanged for a null regime", () => {
    expect(regimeAdjustedCategoryWeights(BASE, null)).toEqual(BASE);
  });

  it("returns base weights unchanged for normal volatility, not range-bound — no multiplier applies", () => {
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "normal", rangeBound: false });
    expect(result.leveragedPositioning).toBeCloseTo(0.35, 10);
    expect(result.spotDemand).toBeCloseTo(0.3, 10);
    expect(result.marketStress).toBeCloseTo(0.2, 10);
    expect(result.liquidityMap).toBeCloseTo(0.15, 10);
  });

  it("hand-computed: high volatility increases marketStress's share, renormalized", () => {
    // adjusted = { lp: .35, sd: .3, ms: .2*1.2=.24, lm: .15 }, total = 1.04
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "high", rangeBound: false });
    expect(result.leveragedPositioning).toBeCloseTo(0.35 / 1.04, 10);
    expect(result.spotDemand).toBeCloseTo(0.3 / 1.04, 10);
    expect(result.marketStress).toBeCloseTo(0.24 / 1.04, 10);
    expect(result.liquidityMap).toBeCloseTo(0.15 / 1.04, 10);
    expect(sum(result)).toBeCloseTo(1, 10);
  });

  it("hand-computed: range-bound increases liquidityMap and decreases leveragedPositioning, renormalized", () => {
    // adjusted = { lp: .35*.9=.315, sd: .3, ms: .2, lm: .15*1.15=.1725 }, total = 0.9875
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "normal", rangeBound: true });
    expect(result.leveragedPositioning).toBeCloseTo(0.315 / 0.9875, 10);
    expect(result.spotDemand).toBeCloseTo(0.3 / 0.9875, 10);
    expect(result.marketStress).toBeCloseTo(0.2 / 0.9875, 10);
    expect(result.liquidityMap).toBeCloseTo(0.1725 / 0.9875, 10);
    expect(sum(result)).toBeCloseTo(1, 10);
  });

  it("hand-computed: high volatility AND range-bound compose multiplicatively, not additively", () => {
    // adjusted = { lp: .35*.9=.315, sd: .3, ms: .2*1.2=.24, lm: .15*1.15=.1725 }, total = 1.0275
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "bull", volatility: "high", rangeBound: true });
    expect(result.leveragedPositioning).toBeCloseTo(0.315 / 1.0275, 10);
    expect(result.spotDemand).toBeCloseTo(0.3 / 1.0275, 10);
    expect(result.marketStress).toBeCloseTo(0.24 / 1.0275, 10);
    expect(result.liquidityMap).toBeCloseTo(0.1725 / 1.0275, 10);
    expect(sum(result)).toBeCloseTo(1, 10);
  });

  it("low volatility applies no multiplier, same as normal", () => {
    const low = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "low", rangeBound: false });
    const normal = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "normal", rangeBound: false });
    expect(low).toEqual(normal);
  });

  it("always renormalizes to sum to 1, regardless of regime combination", () => {
    const regimes: RegimeTagsInput[] = [
      { trend: "bull", volatility: "high", rangeBound: false },
      { trend: "bear", volatility: "low", rangeBound: true },
      { trend: "neutral", volatility: "normal", rangeBound: true },
    ];
    for (const regime of regimes) {
      expect(sum(regimeAdjustedCategoryWeights(BASE, regime))).toBeCloseTo(1, 10);
    }
  });
});

type RegimeTagsInput = { trend: "bull" | "bear" | "neutral"; volatility: "high" | "low" | "normal"; rangeBound: boolean };
