import { describe, it, expect } from "vitest";
import {
  ema,
  rsi,
  macd,
  atr,
  adx,
  directionalBias,
  rollingVwap,
  volumeRatio,
  trendStructure,
  Candle,
} from "./indicators";

/**
 * Indicator math is the one part of this feature where a subtle error would
 * be invisible: a wrong RSI still looks like a plausible RSI, and would
 * silently mis-weight every market thesis on the site. So these tests check
 * against EXTERNAL references and mathematical identities, not against
 * whatever the implementation happens to produce.
 */

const bar = (high: number, low: number, close: number, i: number, volumeUsd = 100): Candle => ({
  t: i,
  open: close,
  high,
  low,
  close,
  volumeUsd,
});

describe("rsi — against Wilder's published worked example", () => {
  /*
   * Wilder's original RSI series from "New Concepts in Technical Trading
   * Systems", as republished in StockCharts' worked table. This is the
   * reference that matters: it's external to this codebase.
   *
   * The published table agrees to within 0.071, and the residual SHRINKS
   * monotonically as bars accumulate (0.066 at the first value, 0.019 by the
   * last). That decay is the signature of rounding in the published
   * intermediate values washing out under Wilder's smoothing — a genuine
   * formula error would hold steady or compound instead. Tolerance is set to
   * 0.08 to accept that rounding while still catching any real regression,
   * which would move these by whole points.
   */
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
    46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35,
    44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
  ];
  const published = [
    70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99,
    41.46, 41.87, 45.46, 37.3, 33.08, 37.77,
  ];

  published.forEach((expected, i) => {
    it(`matches the published value at bar ${15 + i} (${expected})`, () => {
      // Explicit absolute tolerance rather than toBeCloseTo's decimal-place
      // form, which would mean +/-0.05 and reject the known 0.0704 rounding
      // residual documented above for the wrong reason.
      expect(Math.abs(rsi(closes.slice(0, 15 + i))! - expected)).toBeLessThan(0.08);
    });
  });

  it("converges toward the published values as more bars accumulate", () => {
    // The distinguishing check between "published table rounds its
    // intermediates" and "the formula is wrong": rounding error decays under
    // Wilder smoothing, a formula error would not.
    const errAt = (i: number) => Math.abs(rsi(closes.slice(0, 15 + i))! - published[i]);
    expect(errAt(published.length - 1)).toBeLessThan(errAt(0) / 2);
  });
});

describe("mathematical identities that must hold by definition", () => {
  const rising = Array.from({ length: 60 }, (_, i) => bar(100 + i * 2, 99 + i * 2, 100 + i * 2, i));
  const falling = Array.from({ length: 60 }, (_, i) => bar(100 - i * 2, 99 - i * 2, 100 - i * 2, i));

  it("ADX is 100 in a pure uptrend — -DI is zero, so DX is 100 every bar", () => {
    expect(adx(rising)).toBeCloseTo(100, 6);
  });

  it("ADX is 100 in a pure downtrend, since ADX measures strength without direction", () => {
    expect(adx(falling)).toBeCloseTo(100, 6);
  });

  it("ATR of a constant range with no gaps equals that range exactly", () => {
    const flat = Array.from({ length: 40 }, (_, i) => bar(105, 95, 100, i));
    expect(atr(flat)).toBeCloseTo(10, 9);
  });

  it("RSI of a monotonic rise is 100 — there are no losses to divide by", () => {
    expect(rsi(Array.from({ length: 40 }, (_, i) => 100 + i))).toBe(100);
  });

  it("EMA of a constant series is that constant", () => {
    expect(ema(Array(60).fill(50), 20)).toBeCloseTo(50, 9);
  });

  it("rolling VWAP of constant price and volume is that price", () => {
    const flat = Array.from({ length: 30 }, (_, i) => bar(100, 100, 100, i, 500));
    expect(rollingVwap(flat)).toBeCloseTo(100, 9);
  });

  it("volume ratio is 1.0 when the latest bar matches the trailing average", () => {
    const flat = Array.from({ length: 30 }, (_, i) => bar(100, 99, 99.5, i, 250));
    expect(volumeRatio(flat)).toBeCloseTo(1, 9);
  });

  it("MACD histogram is the difference between the line and its signal", () => {
    const noisy = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 10);
    const result = macd(noisy)!;
    expect(result.histogram).toBeCloseTo(result.macd - result.signal, 9);
  });

  it("MACD of a flat series is zero — both EMAs converge to the same value", () => {
    const result = macd(Array(80).fill(42))!;
    expect(result.macd).toBeCloseTo(0, 9);
    expect(result.histogram).toBeCloseTo(0, 9);
  });
});

describe("directional bias and trend structure", () => {
  it("reads a rising series as up / higher-highs", () => {
    const rising = Array.from({ length: 60 }, (_, i) => bar(100 + i * 2, 99 + i * 2, 100 + i * 2, i));
    expect(directionalBias(rising)).toBe("up");
    expect(trendStructure(rising)).toBe("higher-highs");
  });

  it("reads a falling series as down / lower-lows", () => {
    const falling = Array.from({ length: 60 }, (_, i) => bar(100 - i * 2, 99 - i * 2, 100 - i * 2, i));
    expect(directionalBias(falling)).toBe("down");
    expect(trendStructure(falling)).toBe("lower-lows");
  });

  it("reads a flat series as sideways", () => {
    expect(trendStructure(Array.from({ length: 40 }, (_, i) => bar(105, 95, 100, i)))).toBe("sideways");
  });
});

describe("insufficient data returns null rather than a half-formed number", () => {
  it("rsi below period + 1", () => {
    expect(rsi(Array(10).fill(1))).toBeNull();
  });

  it("adx below 2x period + 1", () => {
    expect(adx(Array.from({ length: 20 }, (_, i) => bar(10, 9, 9.5, i)))).toBeNull();
  });

  it("ema when the period exceeds the series length", () => {
    expect(ema([1, 2, 3], 20)).toBeNull();
  });

  it("macd below slow + signal bars", () => {
    expect(macd(Array(30).fill(10))).toBeNull();
  });

  it("atr on an empty series", () => {
    expect(atr([])).toBeNull();
  });

  it("rollingVwap when total volume is zero — avoids a divide-by-zero NaN", () => {
    expect(rollingVwap(Array.from({ length: 25 }, (_, i) => bar(100, 99, 99.5, i, 0)))).toBeNull();
  });
});
