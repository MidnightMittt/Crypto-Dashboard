import { describe, expect, it } from "vitest";
import { regimeAdjustedCategoryWeights, REGIME_WEIGHT_MULTIPLIERS, RegimeMultiplierTable } from "./regimeWeights";
import { Category } from "./types";

/**
 * The multipliers Phase 1 shipped and Phase 4's ablation retired. Kept here
 * as an explicit TEST table so the composition and renormalization
 * machinery stays fully covered even though the live table is now empty —
 * re-enabling regime weighting must remain a data decision, not a rewrite,
 * and that is only true if the mechanism is still proven to work.
 */
const RETIRED_TABLE: RegimeMultiplierTable = {
  volatility: { high: { risk: 1.2 }, low: {}, normal: {} },
  rangeBound: { marketStructure: 1.15, positioning: 0.9 },
};

const BASE: Record<Category, number> = {
  positioning: 0.35,
  marketStructure: 0.25,
  leadingDrivers: 0.2,
  risk: 0.2,
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
    expect(result.positioning).toBeCloseTo(0.35, 10);
    expect(result.marketStructure).toBeCloseTo(0.25, 10);
    expect(result.leadingDrivers).toBeCloseTo(0.2, 10);
    expect(result.risk).toBeCloseTo(0.2, 10);
  });

  it("hand-computed: high volatility increases risk's share, renormalized", () => {
    // adjusted = { positioning: .35, marketStructure: .25, leadingDrivers: .2, risk: .2*1.2=.24 }, total = 1.04
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "high", rangeBound: false }, RETIRED_TABLE);
    expect(result.positioning).toBeCloseTo(0.35 / 1.04, 10);
    expect(result.marketStructure).toBeCloseTo(0.25 / 1.04, 10);
    expect(result.leadingDrivers).toBeCloseTo(0.2 / 1.04, 10);
    expect(result.risk).toBeCloseTo(0.24 / 1.04, 10);
    expect(sum(result)).toBeCloseTo(1, 10);
  });

  it("hand-computed: range-bound increases marketStructure and decreases positioning, renormalized", () => {
    // adjusted = { positioning: .35*.9=.315, marketStructure: .25*1.15=.2875, leadingDrivers: .2, risk: .2 }, total = 1.0025
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "neutral", volatility: "normal", rangeBound: true }, RETIRED_TABLE);
    expect(result.positioning).toBeCloseTo(0.315 / 1.0025, 10);
    expect(result.marketStructure).toBeCloseTo(0.2875 / 1.0025, 10);
    expect(result.leadingDrivers).toBeCloseTo(0.2 / 1.0025, 10);
    expect(result.risk).toBeCloseTo(0.2 / 1.0025, 10);
    expect(sum(result)).toBeCloseTo(1, 10);
  });

  it("hand-computed: high volatility AND range-bound compose multiplicatively, not additively", () => {
    // adjusted = { positioning: .315, marketStructure: .2875, leadingDrivers: .2, risk: .2*1.2=.24 }, total = 1.0425
    const result = regimeAdjustedCategoryWeights(BASE, { trend: "bull", volatility: "high", rangeBound: true }, RETIRED_TABLE);
    expect(result.positioning).toBeCloseTo(0.315 / 1.0425, 10);
    expect(result.marketStructure).toBeCloseTo(0.2875 / 1.0425, 10);
    expect(result.leadingDrivers).toBeCloseTo(0.2 / 1.0425, 10);
    expect(result.risk).toBeCloseTo(0.24 / 1.0425, 10);
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

  it("the LIVE table is currently an identity — Phase 4 retired every multiplier", () => {
    // Pins the production state directly. If a multiplier is ever
    // reintroduced without a fresh ablation, this fails and asks why.
    for (const regime of [
      { trend: "bull", volatility: "high", rangeBound: true },
      { trend: "bear", volatility: "low", rangeBound: false },
      { trend: "neutral", volatility: "normal", rangeBound: true },
    ] as const) {
      const result = regimeAdjustedCategoryWeights(BASE, regime, REGIME_WEIGHT_MULTIPLIERS);
      expect(result.positioning).toBeCloseTo(BASE.positioning, 10);
      expect(result.marketStructure).toBeCloseTo(BASE.marketStructure, 10);
      expect(result.leadingDrivers).toBeCloseTo(BASE.leadingDrivers, 10);
      expect(result.risk).toBeCloseTo(BASE.risk, 10);
    }
  });
});

/** Structural mirror of RegimeTags, kept local so this test file doesn't depend on the technicals module just to name a literal. */
type RegimeTagsInput = { trend: "bull" | "bear" | "neutral"; volatility: "high" | "low" | "normal"; rangeBound: boolean };
