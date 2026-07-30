import { describe, it, expect } from "vitest";
import { classifyExchangeFlow } from "./exchangeFlow";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const base = {
  asset: "BTC" as const,
  currentT: NOW,
  priceUsd: 65_000,
  venues: ["Binance"],
  trackedAddressCount: 1,
};

describe("classifyExchangeFlow", () => {
  it("returns null with no prior snapshot — nothing to diff against", () => {
    expect(
      classifyExchangeFlow({ ...base, currentBalanceNative: 1000, prior: null })
    ).toBeNull();
  });

  it("returns null when current balance is not positive", () => {
    expect(
      classifyExchangeFlow({
        ...base,
        currentBalanceNative: 0,
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })
    ).toBeNull();
  });

  it("returns null when price is not positive", () => {
    expect(
      classifyExchangeFlow({
        ...base,
        priceUsd: 0,
        currentBalanceNative: 1000,
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })
    ).toBeNull();
  });

  it("returns null when the prior point isn't actually in the past", () => {
    expect(
      classifyExchangeFlow({
        ...base,
        currentBalanceNative: 1000,
        prior: { t: NOW, balanceNative: 1000 },
      })
    ).toBeNull();
  });

  describe("direction", () => {
    it("classifies 'inflow' when balance grew beyond the threshold", () => {
      const result = classifyExchangeFlow({
        ...base,
        currentBalanceNative: 1010, // +1%, above the 0.1% threshold
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })!;
      expect(result.direction).toBe("inflow");
      expect(result.netflowNative).toBeCloseTo(10, 6);
      expect(result.netflowUsd).toBeCloseTo(10 * 65_000, 6);
    });

    it("classifies 'outflow' when balance shrank beyond the threshold", () => {
      const result = classifyExchangeFlow({
        ...base,
        currentBalanceNative: 990,
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })!;
      expect(result.direction).toBe("outflow");
      expect(result.netflowNative).toBeCloseTo(-10, 6);
      expect(result.netflowUsd).toBeCloseTo(-10 * 65_000, 6);
    });

    it("classifies 'balanced' when the move sits inside the threshold band", () => {
      const result = classifyExchangeFlow({
        ...base,
        currentBalanceNative: 1000.5, // +0.05%, under the 0.1% threshold
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })!;
      expect(result.direction).toBe("balanced");
    });

    it("is inclusive/exclusive consistently at the exact threshold boundary", () => {
      // Exactly at 0.1% does not exceed it — "balanced" wins ties.
      const atThreshold = classifyExchangeFlow({
        ...base,
        currentBalanceNative: 1001, // exactly +0.1%
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })!;
      expect(atThreshold.direction).toBe("balanced");

      const justOver = classifyExchangeFlow({
        ...base,
        currentBalanceNative: 1001.001,
        prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
      })!;
      expect(justOver.direction).toBe("inflow");
    });

    it("treats a zero prior balance as balanced rather than dividing by zero", () => {
      const result = classifyExchangeFlow({
        ...base,
        currentBalanceNative: 5,
        prior: { t: NOW - 24 * HOUR, balanceNative: 0 },
      })!;
      expect(result.direction).toBe("balanced");
      expect(Number.isFinite(result.netflowNative)).toBe(true);
    });
  });

  it("computes windowHours from the actual gap between snapshots", () => {
    const result = classifyExchangeFlow({
      ...base,
      currentBalanceNative: 1000,
      prior: { t: NOW - 6 * HOUR, balanceNative: 1000 },
    })!;
    expect(result.windowHours).toBeCloseTo(6, 6);
  });

  it("passes through asset, venues, and trackedAddressCount unchanged", () => {
    const result = classifyExchangeFlow({
      ...base,
      asset: "ETH",
      venues: ["Binance", "Coinbase"],
      trackedAddressCount: 2,
      currentBalanceNative: 1000,
      prior: { t: NOW - 24 * HOUR, balanceNative: 1000 },
    })!;
    expect(result.asset).toBe("ETH");
    expect(result.venues).toEqual(["Binance", "Coinbase"]);
    expect(result.trackedAddressCount).toBe(2);
  });

  it("computes currentBalanceUsd from the current balance and price, not the prior one", () => {
    const result = classifyExchangeFlow({
      ...base,
      currentBalanceNative: 1000,
      priceUsd: 65_000,
      prior: { t: NOW - 24 * HOUR, balanceNative: 900 },
    })!;
    expect(result.currentBalanceUsd).toBeCloseTo(1000 * 65_000, 6);
  });
});
