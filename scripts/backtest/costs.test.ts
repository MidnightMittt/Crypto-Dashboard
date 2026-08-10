import { describe, it, expect } from "vitest";
import { applyCosts, fundingCostPct, roundTripCostPct, DEFAULT_COST_CONFIG, FundingPoint } from "./costs";

/**
 * Hand-computed against the declared constants, same discipline as
 * metrics.test.ts. Funding sign conventions are the easiest thing in this
 * file to get backwards — and getting them backwards would turn a losing
 * strategy into a winning one on paper — so each direction is pinned
 * explicitly.
 */

const HOUR = 3_600_000;

/** 8-hourly settlements starting 8h after t=0, matching Binance's real cadence. */
function settlements(rates: number[]): FundingPoint[] {
  return rates.map((fundingRatePct, i) => ({ t: (i + 1) * 8 * HOUR, fundingRatePct }));
}

describe("roundTripCostPct", () => {
  it("charges fee + slippage on both legs", () => {
    // (5bp fee + 2bp slippage) x 2 legs = 14bp = 0.14%
    expect(roundTripCostPct(DEFAULT_COST_CONFIG)).toBeCloseTo(0.14, 10);
  });

  it("scales with the configured rates", () => {
    expect(roundTripCostPct({ takerFeeBpsPerLeg: 10, slippageBpsPerLeg: 0 })).toBeCloseTo(0.2, 10);
    expect(roundTripCostPct({ takerFeeBpsPerLeg: 0, slippageBpsPerLeg: 0 })).toBe(0);
  });
});

describe("fundingCostPct", () => {
  const threePositive = settlements([0.01, 0.01, 0.01]); // t = 8h, 16h, 24h

  it("charges a long for positive funding", () => {
    expect(fundingCostPct("long", 0, 24 * HOUR, threePositive)).toBeCloseTo(0.03, 10);
  });

  it("credits a short for the same settlements", () => {
    // Mirror image — a short is on the receiving side of every one.
    expect(fundingCostPct("short", 0, 24 * HOUR, threePositive)).toBeCloseTo(-0.03, 10);
  });

  it("credits a long when funding is negative", () => {
    expect(fundingCostPct("long", 0, 16 * HOUR, settlements([-0.02, -0.02]))).toBeCloseTo(-0.04, 10);
  });

  it("counts settlements on (entryT, exitT] — open exclusive, close inclusive", () => {
    // Entering exactly AT the 8h settlement must not pay it; exiting
    // exactly at the 24h one must.
    expect(fundingCostPct("long", 8 * HOUR, 24 * HOUR, threePositive)).toBeCloseTo(0.02, 10);
    // Exiting one millisecond before the 24h settlement skips it.
    expect(fundingCostPct("long", 0, 24 * HOUR - 1, threePositive)).toBeCloseTo(0.02, 10);
  });

  it("is zero when the hold spans no settlement at all", () => {
    expect(fundingCostPct("long", 0, 4 * HOUR, threePositive)).toBe(0);
  });

  it("sums real mixed-sign settlements rather than taking an average", () => {
    // +0.05, -0.03, +0.01 => net +0.03 paid by the long.
    expect(fundingCostPct("long", 0, 24 * HOUR, settlements([0.05, -0.03, 0.01]))).toBeCloseTo(0.03, 10);
  });
});

describe("applyCosts", () => {
  it("subtracts fees and funding from a winning long, keeping components separate", () => {
    const r = applyCosts(10, "long", 0, 24 * HOUR, settlements([0.01, 0.01, 0.01]));

    expect(r.grossReturnPct).toBe(10);
    expect(r.feeAndSlippagePct).toBeCloseTo(0.14, 10);
    expect(r.fundingCostPct).toBeCloseTo(0.03, 10);
    expect(r.netReturnPct).toBeCloseTo(9.83, 10); // 10 - 0.14 - 0.03
  });

  it("makes a short's funding credit ADD to net return", () => {
    const r = applyCosts(10, "short", 0, 24 * HOUR, settlements([0.01, 0.01, 0.01]));
    expect(r.netReturnPct).toBeCloseTo(9.89, 10); // 10 - 0.14 + 0.03
  });

  it("can turn a thin gross win into a net loss", () => {
    // The whole reason this module exists: +0.10% gross is not a winning
    // trade once 0.14% of friction is applied.
    const r = applyCosts(0.1, "long", 0, 4 * HOUR, []);
    expect(r.netReturnPct).toBeCloseTo(-0.04, 10);
  });

  it("deepens a losing trade rather than offsetting it", () => {
    const r = applyCosts(-5, "long", 0, 24 * HOUR, settlements([0.01, 0.01, 0.01]));
    expect(r.netReturnPct).toBeCloseTo(-5.17, 10);
  });
});
