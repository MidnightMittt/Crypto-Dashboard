import { describe, expect, it } from "vitest";
import { buildVolumeProfile, buildSupportResistance } from "./marketStructure";
import { Candle, fibonacciRetracement } from "./indicators";

/**
 * 90-bar fixture (matching the default window): two zero-volume anchor bars
 * pin the exact high=200/low=100 range, 78 zero-volume filler bars pad out
 * the window without affecting anything (zero volume contributes nothing to
 * any bucket), and 10 bars with a concentrated [150, 152] price range carry
 * ALL the real volume (10,000 each) — the point of control must land in
 * whichever bucket contains [150, 152].
 *
 * Hand-computed bucket boundaries: bucketSize = (200-100)/24 = 4.1666...,
 * so bucket index 12 spans [100 + 12*4.1666.., 100 + 13*4.1666..] =
 * [150.0, 154.1666..] — [150, 152] sits entirely inside it.
 */
function buildConcentratedVolumeFixture(): Candle[] {
  const candles: Candle[] = [];
  candles.push({ t: 0, open: 100, high: 100, low: 100, close: 100, volumeUsd: 0 });
  candles.push({ t: 1, open: 200, high: 200, low: 200, close: 200, volumeUsd: 0 });
  for (let i = 0; i < 78; i++) {
    candles.push({ t: 2 + i, open: 145, high: 145.1, low: 145, close: 145.05, volumeUsd: 0 });
  }
  for (let i = 0; i < 10; i++) {
    candles.push({ t: 80 + i, open: 151, high: 152, low: 150, close: 151, volumeUsd: 10000 });
  }
  return candles;
}

describe("buildVolumeProfile", () => {
  it("returns null with fewer than `window` bars", () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      t: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volumeUsd: 1,
    }));
    expect(buildVolumeProfile(candles, 90)).toBeNull();
  });

  it("places the point of control in the bucket containing the concentrated volume", () => {
    const result = buildVolumeProfile(buildConcentratedVolumeFixture(), 90);
    expect(result).not.toBeNull();
    expect(result!.pointOfControl.priceLow).toBeCloseTo(150, 5);
    expect(result!.pointOfControl.priceHigh).toBeCloseTo(154.16666667, 5);
    // All 10 concentrated bars' volume (10 * 10000) lands in this one
    // bucket, since [150,152] sits entirely inside [150, 154.1666..].
    expect(result!.pointOfControl.volumeUsd).toBeCloseTo(100000, 2);
  });

  it("the value area encloses at least 70% of total volume, centered on the point of control", () => {
    const result = buildVolumeProfile(buildConcentratedVolumeFixture(), 90)!;
    const total = result.levels.reduce((s, l) => s + l.volumeUsd, 0);
    const inValueArea = result.levels
      .filter((l) => l.priceLow >= result.valueAreaLow && l.priceHigh <= result.valueAreaHigh)
      .reduce((s, l) => s + l.volumeUsd, 0);
    expect(inValueArea / total).toBeGreaterThanOrEqual(0.7);
    // With one bucket holding effectively 100% of all real volume, the
    // value area's own single bucket alone already clears 70% — confirming
    // the expansion loop doesn't needlessly grow past what's required.
    expect(result.valueAreaLow).toBeCloseTo(result.pointOfControl.priceLow, 5);
    expect(result.valueAreaHigh).toBeCloseTo(result.pointOfControl.priceHigh, 5);
  });

  it("has exactly 24 buckets spanning the window's high/low", () => {
    const result = buildVolumeProfile(buildConcentratedVolumeFixture(), 90)!;
    expect(result.levels).toHaveLength(24);
    expect(result.levels[0].priceLow).toBeCloseTo(100, 5);
    expect(result.levels[23].priceHigh).toBeCloseTo(200, 5);
  });
});

describe("buildSupportResistance", () => {
  it("returns an empty array with no candles", () => {
    expect(buildSupportResistance([], null, null)).toEqual([]);
  });

  it("reuses fibonacciRetracement's swing high/low verbatim as the two hardest S/R levels", () => {
    // 50 bars (fibonacciRetracement's own default window), clean swing of
    // 100 to 200, current price near the middle so both swing points are
    // unambiguously resistance (above) / support (below).
    const candles: Candle[] = Array.from({ length: 50 }, (_, i) => ({
      t: i,
      open: 150,
      high: i === 25 ? 200 : 150, // swing high at bar 25
      low: i === 10 ? 100 : 150, // swing low at bar 10
      close: 150,
      volumeUsd: 1,
    }));
    const fib = fibonacciRetracement(candles)!;
    expect(fib.swingHigh).toBe(200);
    expect(fib.swingLow).toBe(100);

    const levels = buildSupportResistance(candles, fib, null);
    const swingHighLevel = levels.find((l) => l.source === "swing-high")!;
    const swingLowLevel = levels.find((l) => l.source === "swing-low")!;
    expect(swingHighLevel).toMatchObject({ price: 200, kind: "resistance" });
    expect(swingLowLevel).toMatchObject({ price: 100, kind: "support" });
  });

  it("classifies volume-profile levels as support/resistance relative to current price", () => {
    const candles = buildConcentratedVolumeFixture();
    const profile = buildVolumeProfile(candles, 90)!;
    const currentPrice = candles[candles.length - 1].close; // 151, inside the POC bucket
    const levels = buildSupportResistance(candles, null, profile);

    const poc = levels.find((l) => l.source === "volume-poc")!;
    // POC bucket midpoint ~152.08, just above the 151 close -> resistance.
    expect(poc.kind).toBe("resistance");
    expect(poc.price).toBeGreaterThan(currentPrice);
  });

  it("returns levels sorted ascending by price", () => {
    const candles = buildConcentratedVolumeFixture();
    const fib = fibonacciRetracement(candles, 50);
    const profile = buildVolumeProfile(candles, 90);
    const levels = buildSupportResistance(candles, fib, profile);
    const prices = levels.map((l) => l.price);
    const sorted = [...prices].sort((a, b) => a - b);
    expect(prices).toEqual(sorted);
  });
});
