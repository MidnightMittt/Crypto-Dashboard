import { describe, it, expect } from "vitest";
import { fundingBandVerdict, bookImbalanceVerdict } from "./evaluators";

describe("fundingBandVerdict", () => {
  it("hand-computed: deep in the crowded-longs band -> bearish (fade the crowd)", () => {
    expect(fundingBandVerdict(0.2)).toBe("bearish");
  });

  it("hand-computed: deep in the extreme-shorts band -> bullish (fade the crowd)", () => {
    expect(fundingBandVerdict(-0.2)).toBe("bullish");
  });

  it("hand-computed: mild positive (Bullish band) -> bullish", () => {
    expect(fundingBandVerdict(0.08)).toBe("bullish");
  });

  it("hand-computed: mild negative (Bearish band) -> bearish", () => {
    expect(fundingBandVerdict(-0.08)).toBe("bearish");
  });

  it("hand-computed: inside the neutral band -> neutral", () => {
    expect(fundingBandVerdict(0.0)).toBe("neutral");
  });

  it("boundary: exactly at the neutral/bullish edge (0.04) reads neutral (band is inclusive on the neutral side)", () => {
    expect(fundingBandVerdict(0.04)).toBe("neutral");
  });
});

describe("bookImbalanceVerdict", () => {
  it("hand-computed: +10% imbalance (past the +5 threshold) -> bullish", () => {
    expect(bookImbalanceVerdict(10)).toBe("bullish");
  });

  it("hand-computed: -10% imbalance (past the -5 threshold) -> bearish", () => {
    expect(bookImbalanceVerdict(-10)).toBe("bearish");
  });

  it("hand-computed: +2% imbalance (inside the band) -> neutral", () => {
    expect(bookImbalanceVerdict(2)).toBe("neutral");
  });

  it("boundary: exactly +5% is NOT past threshold (strictly greater-than) -> neutral", () => {
    expect(bookImbalanceVerdict(5)).toBe("neutral");
  });

  it("returns neutral when no book data is available", () => {
    expect(bookImbalanceVerdict(null)).toBe("neutral");
  });
});
