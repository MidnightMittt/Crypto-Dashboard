import { describe, it, expect } from "vitest";
import { coinbasePremiumLean, deribitOptionsLean, stablecoinFlowLean } from "./leans";

describe("coinbasePremiumLean", () => {
  it("is neutral at exactly 0", () => {
    expect(coinbasePremiumLean(0)).toBe("neutral");
  });

  it("is bullish just above the neutral band, extreme-bullish once it clears the higher bar", () => {
    expect(coinbasePremiumLean(0.03)).toBe("bullish");
    expect(coinbasePremiumLean(0.14)).toBe("bullish");
    expect(coinbasePremiumLean(0.15)).toBe("extreme-bullish");
    expect(coinbasePremiumLean(1)).toBe("extreme-bullish");
  });

  it("is bearish just below the neutral band, extreme-bearish once it clears the lower bar", () => {
    expect(coinbasePremiumLean(-0.03)).toBe("bearish");
    expect(coinbasePremiumLean(-0.14)).toBe("bearish");
    expect(coinbasePremiumLean(-0.15)).toBe("extreme-bearish");
    expect(coinbasePremiumLean(-1)).toBe("extreme-bearish");
  });

  it("stays neutral just inside the band on both sides", () => {
    expect(coinbasePremiumLean(0.029)).toBe("neutral");
    expect(coinbasePremiumLean(-0.029)).toBe("neutral");
  });
});

describe("deribitOptionsLean", () => {
  it("matches DeribitOptionsIntelligence's existing badge boundaries exactly (0.8 and 1.2 are both neutral)", () => {
    // These two exact values must read "neutral" here the same way the
    // card's existing 3-level badge already treats them - the two must
    // never disagree about the same number.
    expect(deribitOptionsLean(0.8)).toBe("neutral");
    expect(deribitOptionsLean(1.2)).toBe("neutral");
  });

  it("is bullish just under 0.8, extreme-bullish at/under the lower bar", () => {
    expect(deribitOptionsLean(0.79)).toBe("bullish");
    expect(deribitOptionsLean(0.51)).toBe("bullish");
    expect(deribitOptionsLean(0.5)).toBe("extreme-bullish");
    expect(deribitOptionsLean(0.1)).toBe("extreme-bullish");
  });

  it("is bearish just over 1.2, extreme-bearish once it clears the higher bar", () => {
    expect(deribitOptionsLean(1.21)).toBe("bearish");
    expect(deribitOptionsLean(2.0)).toBe("bearish");
    expect(deribitOptionsLean(2.01)).toBe("extreme-bearish");
    expect(deribitOptionsLean(5)).toBe("extreme-bearish");
  });

  it("handles a zero call side (Infinity ratio) as extreme-bearish rather than crashing", () => {
    expect(deribitOptionsLean(Infinity)).toBe("extreme-bearish");
  });
});

describe("stablecoinFlowLean", () => {
  it("is neutral at exactly 0", () => {
    expect(stablecoinFlowLean(0)).toBe("neutral");
  });

  it("is bullish on real minting, extreme-bullish on a large 7d expansion", () => {
    expect(stablecoinFlowLean(0.2)).toBe("bullish");
    expect(stablecoinFlowLean(0.99)).toBe("bullish");
    expect(stablecoinFlowLean(1)).toBe("extreme-bullish");
    expect(stablecoinFlowLean(3)).toBe("extreme-bullish");
  });

  it("is bearish on real burning, extreme-bearish on a large 7d contraction", () => {
    expect(stablecoinFlowLean(-0.2)).toBe("bearish");
    expect(stablecoinFlowLean(-0.99)).toBe("bearish");
    expect(stablecoinFlowLean(-1)).toBe("extreme-bearish");
    expect(stablecoinFlowLean(-3)).toBe("extreme-bearish");
  });

  it("stays neutral for a small wobble inside the band", () => {
    expect(stablecoinFlowLean(0.1)).toBe("neutral");
    expect(stablecoinFlowLean(-0.1)).toBe("neutral");
  });

  it("correctly reads the real production figure observed during verification (-0.35%) as bearish", () => {
    expect(stablecoinFlowLean(-0.353)).toBe("bearish");
  });
});
