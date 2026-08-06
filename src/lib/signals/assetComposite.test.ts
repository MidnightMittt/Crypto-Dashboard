import { describe, it, expect } from "vitest";
import { derive7dChangePct, aggregateAltcoinComposite, PricePoint } from "./assetComposite";

const DAY = 24 * 60 * 60 * 1000;

describe("derive7dChangePct", () => {
  it("computes a hand-verified 7-day change from exactly 7 days of history", () => {
    const points: PricePoint[] = [
      { t: 0, price: 100 },
      { t: 7 * DAY, price: 110 },
    ];
    // (110-100)/100*100 = 10%
    expect(derive7dChangePct(points)).toBeCloseTo(10, 10);
  });

  it("returns null when the series has fewer than 7 real days of history", () => {
    const points: PricePoint[] = [
      { t: 0, price: 100 },
      { t: 3 * DAY, price: 105 },
    ];
    expect(derive7dChangePct(points)).toBeNull();
  });

  it("sorts defensively — out-of-order input produces the same result as sorted input", () => {
    const outOfOrder: PricePoint[] = [
      { t: 7 * DAY, price: 110 },
      { t: 0, price: 100 },
    ];
    expect(derive7dChangePct(outOfOrder)).toBeCloseTo(10, 10);
  });

  it("uses the nearest point at or before the 7-day mark when sampling is daily, not interpolated", () => {
    const points: PricePoint[] = [
      { t: 0, price: 100 },
      { t: 6 * DAY, price: 108 },
      { t: 10 * DAY, price: 120 },
    ];
    // latest = day10 (120). targetT = day10-7=day3. Nearest point at/before day3 is day0 (100).
    // (120-100)/100*100 = 20%
    expect(derive7dChangePct(points)).toBeCloseTo(20, 10);
  });

  it("handles a negative change correctly", () => {
    const points: PricePoint[] = [
      { t: 0, price: 200 },
      { t: 7 * DAY, price: 180 },
    ];
    // (180-200)/200*100 = -10%
    expect(derive7dChangePct(points)).toBeCloseTo(-10, 10);
  });

  it("returns null for an empty series", () => {
    expect(derive7dChangePct([])).toBeNull();
  });

  it("returns null when either endpoint's price is non-positive", () => {
    expect(derive7dChangePct([{ t: 0, price: 0 }, { t: 7 * DAY, price: 10 }])).toBeNull();
  });
});

describe("aggregateAltcoinComposite", () => {
  it("hand-computed: confidence-weighted score average across 3 altcoins", () => {
    const inputs = [
      { score: 70, confidence: 80 },
      { score: 40, confidence: 60 },
      { score: 90, confidence: 20 },
    ];
    // weightedScoreSum = 70*.8 + 40*.6 + 90*.2 = 56+24+18 = 98
    // weightTotal = .8+.6+.2 = 1.6 -> score = round(98/1.6) = round(61.25) = 61
    // confidenceSum = 80+60+20=160, avg = round(160/3) = round(53.33) = 53
    const result = aggregateAltcoinComposite(inputs);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(61);
    expect(result!.confidence).toBe(53);
  });

  it("returns null with no inputs", () => {
    expect(aggregateAltcoinComposite([])).toBeNull();
  });

  it("returns null when every input has zero confidence — nothing to honestly average", () => {
    const inputs = [
      { score: 90, confidence: 0 },
      { score: 10, confidence: 0 },
    ];
    expect(aggregateAltcoinComposite(inputs)).toBeNull();
  });

  it("excludes zero-confidence entries from the weighted score but still counts them in the confidence average", () => {
    const inputs = [
      { score: 80, confidence: 100 },
      { score: 20, confidence: 0 }, // excluded from score weighting, included in confidence average
    ];
    // weightedScoreSum = 80*1 = 80, weightTotal = 1 -> score = 80
    // confidenceSum = 100+0=100, avg = round(100/2) = 50
    const result = aggregateAltcoinComposite(inputs);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(80);
    expect(result!.confidence).toBe(50);
  });

  it("a single fully-confident input passes through its own score and confidence unchanged", () => {
    const result = aggregateAltcoinComposite([{ score: 65, confidence: 90 }]);
    expect(result).toEqual({ score: 65, confidence: 90 });
  });
});
