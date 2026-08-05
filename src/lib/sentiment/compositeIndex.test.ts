import { describe, it, expect } from "vitest";
import { clamp, computeLeverageHeat, computeOiPercentile } from "./compositeIndex";

describe("clamp", () => {
  it("passes values inside the range through unchanged", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });
  it("clamps below the minimum", () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });
  it("clamps above the maximum", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
  it("handles min === max without dividing by zero elsewhere relying on it", () => {
    expect(clamp(5, 10, 10)).toBe(10);
  });
});

describe("computeLeverageHeat", () => {
  it("returns null when OI change is unavailable, regardless of other inputs", () => {
    // Heat is fundamentally a statement about leverage BUILDING; without OI
    // there's no honest way to say that.
    const heat = computeLeverageHeat({
      weightedFundingRatePct: 0.15,
      oiChange24hPct: null,
      priceChange24hPct: 0,
    });
    expect(heat).toBeNull();
  });

  it("scores hottest when OI is surging, price is flat, and funding is extreme", () => {
    const heat = computeLeverageHeat({
      weightedFundingRatePct: 0.2,
      oiChange24hPct: 30,
      priceChange24hPct: 0,
    });
    expect(heat).toBe(100);
  });

  it("scores coldest when OI is falling hard and funding is at zero", () => {
    const heat = computeLeverageHeat({
      weightedFundingRatePct: 0,
      oiChange24hPct: -10,
      priceChange24hPct: 3, // priceStall scale(3-3,0,3) = 0
    });
    expect(heat).toBe(0);
  });

  it("uses the ABSOLUTE value of funding, so extreme-negative funding is just as hot as extreme-positive", () => {
    const heatPositive = computeLeverageHeat({
      weightedFundingRatePct: 0.2,
      oiChange24hPct: 0,
      priceChange24hPct: 5,
    });
    const heatNegative = computeLeverageHeat({
      weightedFundingRatePct: -0.2,
      oiChange24hPct: 0,
      priceChange24hPct: 5,
    });
    expect(heatPositive).toBe(heatNegative);
  });
});

describe("computeOiPercentile", () => {
  it("returns null below the 12-point minimum history requirement", () => {
    const history = Array.from({ length: 11 }, (_, i) => ({ openInterestUsd: 1_000 + i }));
    expect(computeOiPercentile(1_500, history)).toBeNull();
  });

  it("returns 100 when current OI exceeds every historical point", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ openInterestUsd: 100 + i }));
    expect(computeOiPercentile(1_000_000, history)).toBe(100);
  });

  it("returns 0 when current OI is below every historical point", () => {
    const history = Array.from({ length: 12 }, () => ({ openInterestUsd: 1_000_000 }));
    expect(computeOiPercentile(1, history)).toBe(0);
  });

  it("ignores zero/undefined OI entries in the history rather than counting them as valid low readings", () => {
    // If zeros counted, a history full of gaps would make any positive OI
    // look artificially high.
    const history = [
      { openInterestUsd: 0 },
      { openInterestUsd: undefined },
      { openInterestUsd: 100 },
      { openInterestUsd: 200 },
      { openInterestUsd: 300 },
      { openInterestUsd: 400 },
      { openInterestUsd: 500 },
      { openInterestUsd: 600 },
      { openInterestUsd: 700 },
      { openInterestUsd: 800 },
      { openInterestUsd: 900 },
      { openInterestUsd: 1000 },
    ];
    // Only 10 valid (non-zero, non-undefined) points -> below the 12 minimum
    // -> null, even though the array itself has 12 entries.
    expect(computeOiPercentile(500, history)).toBeNull();
  });
});
