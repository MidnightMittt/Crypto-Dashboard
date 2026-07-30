import { describe, it, expect } from "vitest";
import {
  computeFundingPercentile,
  computeFundingDivergence,
  computeCexDexSplit,
  computeSqueezeRisk,
} from "./positioning";
import { ExchangeSnapshot, LocalHistoryPoint } from "@/types/market";

function snapshot(overrides: Partial<ExchangeSnapshot>): ExchangeSnapshot {
  return {
    exchangeId: "binance",
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

function historyPoint(weightedFundingRatePct: number): LocalHistoryPoint {
  return {
    t: 0,
    totalOpenInterestUsd: 1,
    weightedFundingRatePct,
    price: 1,
    longShortRatio: null,
    venueCount: 1,
  };
}

describe("computeFundingPercentile", () => {
  it("returns null below the 12-point minimum, unlike the OI percentile's stricter venue-set rule", () => {
    const history = Array.from({ length: 11 }, () => historyPoint(0.01));
    expect(computeFundingPercentile(0.01, history)).toBeNull();
  });

  it("ranks current funding against exactly 12 prior points with no coverage requirement", () => {
    // Deliberately does NOT require an identical venue set per point - this
    // is the whole reason it's usable when the OI percentile isn't.
    const history = Array.from({ length: 12 }, (_, i) => historyPoint(i)); // 0..11
    // 12 is greater than all 12 prior values (0..11) -> 100th percentile.
    expect(computeFundingPercentile(12, history)).toBe(100);
  });

  it("returns 0 when current funding is below every historical point", () => {
    const history = Array.from({ length: 12 }, (_, i) => historyPoint(i + 1)); // 1..12
    expect(computeFundingPercentile(0, history)).toBe(0);
  });

  it("counts values equal to current as 'below or equal', matching the OI percentile's convention", () => {
    const history = Array.from({ length: 12 }, () => historyPoint(0.05));
    // Every point equals current -> all count as <=, so percentile is 100.
    expect(computeFundingPercentile(0.05, history)).toBe(100);
  });
});

describe("computeFundingDivergence", () => {
  it("returns null with fewer than 2 OI-weighted venues", () => {
    expect(computeFundingDivergence([snapshot({ openInterestUsd: 1_000_000, fundingRatePct: 0.01 })])).toBeNull();
  });

  it("returns null when no venue reports positive open interest", () => {
    expect(
      computeFundingDivergence([
        snapshot({ exchangeId: "a", openInterestUsd: 0 }),
        snapshot({ exchangeId: "b", openInterestUsd: 0 }),
      ])
    ).toBeNull();
  });

  it("reports zero dispersion when every venue agrees exactly", () => {
    const result = computeFundingDivergence([
      snapshot({ exchangeId: "a", openInterestUsd: 1_000_000, fundingRatePct: 0.01, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "b", openInterestUsd: 1_000_000, fundingRatePct: 0.01, fundingIntervalHours: 8 }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.dispersionBps).toBeCloseTo(0, 10);
    expect(result!.spreadBps).toBeCloseTo(0, 10);
  });

  it("normalizes an hourly venue to its 8h equivalent BEFORE comparing - the exact bug this module documents guarding against", () => {
    // Venue A: 8h venue at 0.08% per 8h.
    // Venue B: hourly venue at 0.01% per HOUR -> 0.08% per 8h equivalent.
    // If normalization were skipped, B's raw 0.01% would look 8x smaller than
    // A's, manufacturing false divergence between two venues that actually
    // agree perfectly once put on the same footing.
    const result = computeFundingDivergence([
      snapshot({ exchangeId: "a", openInterestUsd: 1_000_000, fundingRatePct: 0.08, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "b", openInterestUsd: 1_000_000, fundingRatePct: 0.01, fundingIntervalHours: 1 }),
    ]);
    expect(result!.dispersionBps).toBeCloseTo(0, 6);
  });

  it("weights dispersion by open interest, so a large venue's disagreement dominates a small one's", () => {
    // A $10B venue at 0% vs a $1M venue at 1% (wildly different) - dispersion
    // should sit close to the huge venue's value, not average naively toward
    // the middle of the two raw rates.
    const result = computeFundingDivergence([
      snapshot({ exchangeId: "whale", openInterestUsd: 10_000_000_000, fundingRatePct: 0, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "minnow", openInterestUsd: 1_000_000, fundingRatePct: 1, fundingIntervalHours: 8 }),
    ]);
    // Unweighted mean of {0, 1} would be 0.5% => 50bps dispersion-ish; the
    // weighted mean is pulled overwhelmingly toward 0 because of the whale's
    // dominant weight, so dispersion should be far below that unweighted case.
    expect(result!.dispersionBps).toBeLessThan(5);
  });

  it("identifies the correct highest and lowest venues by name", () => {
    const result = computeFundingDivergence([
      snapshot({ exchangeId: "binance", openInterestUsd: 1_000_000, fundingRatePct: 0.05, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "hyperliquid", openInterestUsd: 1_000_000, fundingRatePct: -0.05, fundingIntervalHours: 8 }),
    ]);
    expect(result!.highestVenue.id).toBe("binance");
    expect(result!.lowestVenue.id).toBe("hyperliquid");
    expect(result!.spreadBps).toBeCloseTo(10, 6); // 0.05 - (-0.05) = 0.10% = 10bps
  });

  it("excludes venues with zero or negative open interest from the weighted set", () => {
    const withZeroVenue = computeFundingDivergence([
      snapshot({ exchangeId: "a", openInterestUsd: 1_000_000, fundingRatePct: 0.01 }),
      snapshot({ exchangeId: "b", openInterestUsd: 1_000_000, fundingRatePct: 0.02 }),
      snapshot({ exchangeId: "c", openInterestUsd: 0, fundingRatePct: 999 }), // absurd rate but zero weight
    ]);
    expect(withZeroVenue!.venueCount).toBe(2);
  });
});

describe("computeCexDexSplit", () => {
  it("returns null when only CEX venues are present", () => {
    const result = computeCexDexSplit([
      snapshot({ exchangeId: "binance", openInterestUsd: 1_000_000 }),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when only DEX venues are present", () => {
    const result = computeCexDexSplit([
      snapshot({ exchangeId: "hyperliquid", openInterestUsd: 1_000_000 }),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when both types exist but neither has positive OI", () => {
    const result = computeCexDexSplit([
      snapshot({ exchangeId: "binance", openInterestUsd: 0 }),
      snapshot({ exchangeId: "hyperliquid", openInterestUsd: 0 }),
    ]);
    expect(result).toBeNull();
  });

  it("computes OI share correctly when both segments are present", () => {
    const result = computeCexDexSplit([
      snapshot({ exchangeId: "binance", openInterestUsd: 90_000_000, fundingRatePct: 0.01, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "hyperliquid", openInterestUsd: 10_000_000, fundingRatePct: 0.01, fundingIntervalHours: 8 }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.cexOiSharePct).toBeCloseTo(90, 6);
  });

  it("computes the funding gap as DEX minus CEX, positive meaning on-chain longs pay more", () => {
    const result = computeCexDexSplit([
      snapshot({ exchangeId: "binance", openInterestUsd: 1_000_000, fundingRatePct: 0.01, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "hyperliquid", openInterestUsd: 1_000_000, fundingRatePct: 0.03, fundingIntervalHours: 8 }),
    ]);
    // DEX (0.03% = 3bps) - CEX (0.01% = 1bps) = +2bps.
    expect(result!.fundingGapBps).toBeCloseTo(2, 6);
  });

  it("normalizes hourly venues within each segment before weighting", () => {
    // Hyperliquid is an hourly-settlement DEX; giving it a raw hourly rate
    // equal in magnitude to an 8h CEX rate should NOT produce equal segment
    // funding - it should read 8x higher once normalized.
    const cexOnly8h = computeCexDexSplit([
      snapshot({ exchangeId: "binance", openInterestUsd: 1_000_000, fundingRatePct: 0.01, fundingIntervalHours: 8 }),
      snapshot({ exchangeId: "hyperliquid", openInterestUsd: 1_000_000, fundingRatePct: 0.01, fundingIntervalHours: 1 }),
    ]);
    // dex.fundingBps should be ~8bps (0.01% * 8), not ~1bps.
    expect(cexOnly8h!.dex.fundingBps).toBeCloseTo(8, 6);
  });
});

describe("computeSqueezeRisk", () => {
  it("returns null only if total weight is zero (in practice: never, since price coiling always contributes)", () => {
    // Price coiling always pushes a component regardless of other inputs, so
    // totalWeight can never legitimately reach zero - documenting that
    // guarantee here.
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0,
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    expect(result).not.toBeNull();
  });

  it("scores low when everything is neutral and price is moving normally", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0,
      fundingPercentile: 50,
      oiPercentile: 50,
      oiChange24hPct: null,
      longShortRatio: 1,
      priceChange24hPct: 5, // beyond the 3% coiling window -> priceStall scores 0
    });
    expect(result!.score).toBeLessThan(50);
    expect(result!.side).toBe("balanced");
  });

  it("scores high when funding and OI are both at extremes and price is flat", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0.2, // far positive
      fundingPercentile: 100,
      oiPercentile: 100,
      oiChange24hPct: null,
      longShortRatio: 1.8,
      priceChange24hPct: 0, // fully coiled
    });
    expect(result!.score).toBeGreaterThan(80);
    expect(result!.side).toBe("long");
  });

  it("prefers the percentile over absolute funding magnitude when both are available", () => {
    // Same absolute funding, but different percentile context - the score's
    // crowding component should differ because percentile is what's used.
    const withHighPercentile = computeSqueezeRisk({
      weightedFundingRatePct: 0.01,
      fundingPercentile: 99,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    const withLowPercentile = computeSqueezeRisk({
      weightedFundingRatePct: 0.01,
      fundingPercentile: 51,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    expect(withHighPercentile!.score).toBeGreaterThan(withLowPercentile!.score);
  });

  it("falls back to absolute funding magnitude when no percentile history exists yet", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0.2, // 20bps/8h - historically extreme per the module's own comment
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    expect(result!.components[0].detail).toContain("no history yet");
  });

  it("falls back to OI CHANGE (not percentile) for the fuel component when no percentile history exists", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0,
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: 30, // no percentile, but a fresh OI build is visible
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    const fuelComponent = result!.components.find((c) => c.label === "Open interest building");
    expect(fuelComponent).toBeDefined();
    expect(fuelComponent!.detail).toContain("up");
  });

  it("labels the OI-building fallback 'down' when open interest is contracting", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0,
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: -12,
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    const fuelComponent = result!.components.find((c) => c.label === "Open interest building");
    expect(fuelComponent!.detail).toContain("down");
  });

  it("omits the OI component entirely when neither percentile nor change is available, rather than guessing", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0.1,
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: null,
      priceChange24hPct: 0,
    });
    const hasOiComponent = result!.components.some(
      (c) => c.label === "Open interest level" || c.label === "Open interest building"
    );
    expect(hasOiComponent).toBe(false);
  });

  it("reports 'balanced' when funding and long/short ratio disagree on direction", () => {
    // Funding says crowded long (positive, above the 0.5bps threshold);
    // long/short ratio says short-heavy. The two disagree, so the honest
    // answer is balanced rather than picking a winner.
    const result = computeSqueezeRisk({
      weightedFundingRatePct: 0.05, // well above the 0.5bps side-detection threshold
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: 0.5, // clearly short-heavy (< 0.87)
      priceChange24hPct: 0,
    });
    expect(result!.side).toBe("balanced");
  });

  it("reports 'short' when funding and long/short ratio agree on the short side", () => {
    const result = computeSqueezeRisk({
      weightedFundingRatePct: -0.05,
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: 0.5,
      priceChange24hPct: 0,
    });
    expect(result!.side).toBe("short");
  });

  it("falls back to whichever single signal is available when the other is absent", () => {
    const fundingOnly = computeSqueezeRisk({
      weightedFundingRatePct: 0.05,
      fundingPercentile: null,
      oiPercentile: null,
      oiChange24hPct: null,
      longShortRatio: null, // not reported by this venue set
      priceChange24hPct: 0,
    });
    expect(fundingOnly!.side).toBe("long");
  });

  it("renormalizes weights when oi/long-short data is entirely missing, rather than dragging toward neutral", () => {
    const fullData = computeSqueezeRisk({
      weightedFundingRatePct: 0.2,
      fundingPercentile: 100,
      oiPercentile: 100,
      oiChange24hPct: null,
      longShortRatio: 1.8,
      priceChange24hPct: 0,
    });
    const sparseData = computeSqueezeRisk({
      weightedFundingRatePct: 0.2,
      fundingPercentile: 100,
      oiPercentile: null, // missing
      oiChange24hPct: null, // missing
      longShortRatio: null, // missing
      priceChange24hPct: 0,
    });
    // Both should still score near the top since every AVAILABLE component
    // is maxed out - a naive average-with-zero-fill would score sparseData
    // far lower.
    expect(fullData!.score).toBe(100);
    expect(sparseData!.score).toBe(100);
  });
});
