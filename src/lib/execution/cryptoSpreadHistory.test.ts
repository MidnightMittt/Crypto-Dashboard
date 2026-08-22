import { describe, expect, it, vi } from "vitest";

/**
 * The defect this store exists to fix, pinned: STX/USD printed 9.1bp and
 * 22.7bp twenty seconds apart, which moved /api/cost/express's headline
 * ratio from 54x to 18x on nothing but timing. A median and a tail describe
 * that book; a mean describes a market that never existed.
 */
const rows = (spreads: number[], pair = "STX/USD") =>
  spreads.map((spreadBp, i) => ({
    t: new Date(Date.UTC(2026, 7, 22, 0, i)).toISOString(),
    venue: "kraken",
    pair,
    bid: 0.2212,
    ask: 0.2214,
    mid: 0.2213,
    spreadBp,
    effectiveSpreadBp: spreadBp * 1.4,
    refPrice: 0.2213,
    refGapBp: i % 2 === 0 ? 4 : -6,
    usSession: i % 3 === 0 ? "overnight" : "weekend",
  }));

vi.mock("@/data/cryptoSpreadHistory.json", () => ({
  default: {
    version: 1,
    generatedAt: 1_756_000_000_000,
    // A book that swings: eight tight prints and two wide ones.
    observations: rows([8, 9, 9, 10, 10, 11, 12, 13, 23, 27]),
  },
}));

const { spreadDistribution, venueAgreement, MIN_SPREAD_SAMPLES } = await import("./cryptoSpreadHistory");

describe("spreadDistribution", () => {
  it("leads with the median and carries the tail, never a mean", () => {
    const d = spreadDistribution("STX/USD")!;
    expect(d.n).toBe(10);
    // Median of the ten prints is 10.5; the mean would be 13.2 — dragged by
    // two wide prints toward a spread most fills never see.
    expect(d.medianBp).toBeCloseTo(10.5, 1);
    expect(d.p90Bp).toBeGreaterThan(d.medianBp);
    expect(d.worstBp).toBe(27);
    expect(d.bestBp).toBe(8);
  });

  it("reports the depth-walked spread a real order actually pays", () => {
    const d = spreadDistribution("STX/USD")!;
    expect(d.medianEffectiveBp).toBeCloseTo(14.7, 1);
    expect(d.nominalFillUsd).toBe(500);
  });

  it("names which sessions are covered, so the dark window is auditable", () => {
    const d = spreadDistribution("STX/USD")!;
    expect(d.sessionsCovered).toContain("overnight");
    expect(d.sessionsCovered).toContain("weekend");
  });

  it("refuses a distribution below the sample floor rather than describing noise", () => {
    expect(MIN_SPREAD_SAMPLES).toBeGreaterThan(1);
    expect(spreadDistribution("NOT/RECORDED")).toBeNull();
  });
});

describe("venueAgreement", () => {
  it("logs the gap as a series, because one match can be a shared upstream feed", () => {
    const a = venueAgreement("STX/USD")!;
    expect(a.n).toBe(10);
    // Absolute gaps alternate 4 and 6 bp.
    expect(a.medianGapBp).toBeCloseTo(5, 0);
    expect(a.verdict).toContain("track each other");
    expect(a.verdict).toContain("not of the spread");
  });
});
