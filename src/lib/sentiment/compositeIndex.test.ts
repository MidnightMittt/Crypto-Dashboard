import { describe, it, expect } from "vitest";
import {
  clamp,
  computeCompositeSentiment,
  computeLeverageHeat,
  computeOiPercentile,
} from "./compositeIndex";
import { ExchangeSnapshot } from "@/types/market";

function snapshot(overrides: Partial<ExchangeSnapshot>): ExchangeSnapshot {
  return {
    exchangeId: "test",
    asset: "BTC",
    fundingRatePct: 0,
    fundingIntervalHours: 8,
    nextFundingAt: 0,
    openInterestUsd: 0,
    openInterestChange24hPct: null,
    volume24hUsd: 0,
    longShortRatio: null,
    price: 0,
    priceChange24hPct: 0,
    sparkline: [],
    fundingHistory: [],
    updatedAt: 0,
    ...overrides,
  };
}

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

describe("computeCompositeSentiment", () => {
  it("returns exactly 50 (neutral) for perfectly neutral inputs", () => {
    // Funding 0 -> midpoint of [-0.2, 0.2] -> 50.
    // Price change 0 -> midpoint of [-10, 10] -> 50.
    // No OI or long/short data supplied, so only funding + price contribute,
    // both at 50 -> weighted average is still 50 regardless of weights.
    const score = computeCompositeSentiment({
      weightedFundingRatePct: 0,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [],
    });
    expect(score).toBe(50);
  });

  it("scores maximally bullish at the top of every input's range", () => {
    const score = computeCompositeSentiment({
      weightedFundingRatePct: 0.2,
      oiChange24hPct: 25,
      oiPercentile: 100,
      longShortRatio: 1.8,
      priceChange24hPct: 10,
      exchanges: [],
    });
    expect(score).toBe(100);
  });

  it("scores maximally bearish at the bottom of every input's range", () => {
    const score = computeCompositeSentiment({
      weightedFundingRatePct: -0.2,
      oiChange24hPct: -15,
      oiPercentile: 0,
      longShortRatio: 0.5,
      priceChange24hPct: -10,
      exchanges: [],
    });
    expect(score).toBe(0);
  });

  it("clamps inputs beyond the defined range rather than extrapolating", () => {
    // Funding far outside [-0.2, 0.2] must still land at the 100 ceiling,
    // not an out-of-bounds score.
    const score = computeCompositeSentiment({
      weightedFundingRatePct: 5, // absurdly high, e.g. a unit-conversion bug
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [],
    });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("renormalizes weights rather than dragging the score toward 50 when inputs are missing", () => {
    // Only funding supplied (fully bullish), nothing else. If the missing
    // components were silently scored as neutral-50 rather than dropped, the
    // result would sit well below 100.
    const score = computeCompositeSentiment({
      weightedFundingRatePct: 0.2,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 10,
      exchanges: [],
    });
    expect(score).toBe(100);
  });

  it("only counts turnover from venues reporting BOTH volume and OI", () => {
    // A venue with OI but no volume must not dilute the turnover ratio by
    // inflating the denominator alone (this was a real, fixed bug).
    const withPartialVenue = computeCompositeSentiment({
      weightedFundingRatePct: 0,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [
        snapshot({ exchangeId: "a", openInterestUsd: 1_000_000, volume24hUsd: 2_000_000 }),
        // No volume reported (e.g. Coinalyze) - must be excluded entirely,
        // not counted with volume=0.
        snapshot({ exchangeId: "b", openInterestUsd: 5_000_000, volume24hUsd: 0 }),
      ],
    });
    const withOnlyCompleteVenue = computeCompositeSentiment({
      weightedFundingRatePct: 0,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [snapshot({ exchangeId: "a", openInterestUsd: 1_000_000, volume24hUsd: 2_000_000 })],
    });
    expect(withPartialVenue).toBe(withOnlyCompleteVenue);
  });

  it("uses only oiChange (scaled) when oiPercentile is unavailable but oiChange is present", () => {
    const score = computeCompositeSentiment({
      weightedFundingRatePct: 0,
      oiChange24hPct: 25, // scale(25,-15,25) = 100
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [],
    });
    // funding=50 (w .3), price=50 (w .2), OI=100 (w .25) -> (50*.3+50*.2+100*.25)/0.75
    // = (15+10+25)/0.75 = 50/0.75 = 66.67 -> rounds to 67.
    expect(score).toBe(67);
  });

  it("is monotonic in funding: higher funding never produces a lower score, all else equal", () => {
    const low = computeCompositeSentiment({
      weightedFundingRatePct: -0.1,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [],
    });
    const high = computeCompositeSentiment({
      weightedFundingRatePct: 0.1,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      priceChange24hPct: 0,
      exchanges: [],
    });
    expect(high).toBeGreaterThan(low);
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
