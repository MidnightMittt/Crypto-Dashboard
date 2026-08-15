import { describe, it, expect } from "vitest";
import {
  ema,
  rsi,
  macd,
  atr,
  atrPctSeries,
  adx,
  directionalBias,
  rollingVwap,
  volumeRatio,
  trendStructure,
  Candle,
  bollingerBands,
  stochastic,
  obv,
  obvTrend,
  supertrend,
  parabolicSar,
  ichimoku,
  fibonacciRetracement,
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

describe("bollingerBands", () => {
  it("collapses to zero width when price is perfectly constant", () => {
    const bands = bollingerBands(Array(25).fill(100))!;
    expect(bands.middle).toBe(100);
    expect(bands.upper).toBe(100);
    expect(bands.lower).toBe(100);
    expect(bands.bandwidthPct).toBe(0);
  });

  it("matches a hand-computed step function", () => {
    // 19 values of 10, one of 30. mean = 220/20 = 11.
    // variance = (19*(10-11)^2 + (30-11)^2) / 20 = (19 + 361) / 20 = 19.
    const bands = bollingerBands([...Array(19).fill(10), 30])!;
    expect(bands.middle).toBe(11);
    expect(bands.upper).toBeCloseTo(11 + 2 * Math.sqrt(19), 9);
    expect(bands.lower).toBeCloseTo(11 - 2 * Math.sqrt(19), 9);
  });

  it("returns null below the period", () => {
    expect(bollingerBands(Array(10).fill(1))).toBeNull();
  });
});

describe("stochastic", () => {
  it("scores %K at 100 when the close sits exactly at the period high", () => {
    // high === close on every bar, so the latest close IS the window's high.
    const candles = Array.from({ length: 20 }, (_, i) => bar(100 + i, 99 + i, 100 + i, i));
    expect(stochastic(candles)!.k).toBe(100);
  });

  it("scores %K at 0 when the close sits exactly at the period low", () => {
    // low === close on every bar, so the latest close IS the window's low.
    const candles = Array.from({ length: 20 }, (_, i) => bar(101 - i, 100 - i, 100 - i, i));
    expect(stochastic(candles)!.k).toBe(0);
  });

  it("reads 50 on a perfectly flat range rather than dividing by zero", () => {
    expect(stochastic(Array.from({ length: 20 }, (_, i) => bar(105, 95, 100, i)))!.k).toBe(50);
  });

  it("returns null below the period", () => {
    expect(stochastic(Array(5).fill(bar(10, 9, 9.5, 0)))).toBeNull();
  });
});

describe("obv / obvTrend", () => {
  it("is strictly increasing through a clean uptrend", () => {
    const series = obv(Array.from({ length: 40 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i)));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThan(series[i - 1]);
    expect(obvTrend(Array.from({ length: 40 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i)))).toBe("up");
  });

  it("is strictly decreasing through a clean downtrend", () => {
    const series = obv(Array.from({ length: 40 }, (_, i) => bar(101 - i, 99 - i, 100 - i, i)));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeLessThan(series[i - 1]);
    expect(obvTrend(Array.from({ length: 40 }, (_, i) => bar(101 - i, 99 - i, 100 - i, i)))).toBe("down");
  });

  it("starts at zero", () => {
    expect(obv([bar(10, 9, 9.5, 0)])).toEqual([0]);
  });

  it("holds flat on an unchanged close", () => {
    const flat = [bar(10, 9, 9.5, 0), bar(10, 9, 9.5, 1)];
    expect(obv(flat)).toEqual([0, 0]);
  });
});

describe("supertrend", () => {
  it("never flips to down through a clean, sustained uptrend", () => {
    const uptrend = Array.from({ length: 120 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i));
    for (let n = 30; n <= uptrend.length; n += 10) {
      expect(supertrend(uptrend.slice(0, n))?.direction).toBe("up");
    }
  });

  it("never flips to up through a clean, sustained downtrend", () => {
    const downtrend = Array.from({ length: 120 }, (_, i) => bar(600 - i, 598 - i, 599 - i, i));
    for (let n = 30; n <= downtrend.length; n += 10) {
      expect(supertrend(downtrend.slice(0, n))?.direction).toBe("down");
    }
  });

  it("flips direction after a sharp, sustained reversal", () => {
    const upThenDown = [
      ...Array.from({ length: 60 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i)),
      ...Array.from({ length: 60 }, (_, i) => bar(161 - i * 3, 155 - i * 3, 158 - i * 3, 60 + i)),
    ];
    expect(supertrend(upThenDown)?.direction).toBe("down");
  });

  it("returns null on too short a series", () => {
    expect(supertrend(Array.from({ length: 5 }, (_, i) => bar(10, 9, 9.5, i)))).toBeNull();
  });
});

describe("parabolicSar", () => {
  it("keeps SAR at or below every low while direction reads up", () => {
    const uptrend = Array.from({ length: 100 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i));
    for (let n = 10; n <= uptrend.length; n += 5) {
      const slice = uptrend.slice(0, n);
      const result = parabolicSar(slice);
      if (result?.direction === "up") {
        expect(result.value).toBeLessThanOrEqual(slice[slice.length - 1].low);
      }
    }
  });

  it("keeps SAR at or above every high while direction reads down", () => {
    const downtrend = Array.from({ length: 100 }, (_, i) => bar(600 - i, 598 - i, 599 - i, i));
    for (let n = 10; n <= downtrend.length; n += 5) {
      const slice = downtrend.slice(0, n);
      const result = parabolicSar(slice);
      if (result?.direction === "down") {
        expect(result.value).toBeGreaterThanOrEqual(slice[slice.length - 1].high);
      }
    }
  });

  it("returns null on too short a series", () => {
    expect(parabolicSar([bar(10, 9, 9.5, 0), bar(10, 9, 9.5, 1)])).toBeNull();
  });
});

describe("ichimoku", () => {
  it("reads price above the cloud in a clean, sustained uptrend", () => {
    const uptrend = Array.from({ length: 60 }, (_, i) => bar(101 + i * 2, 99 + i * 2, 100 + i * 2, i));
    const result = ichimoku(uptrend)!;
    expect(result.priceVsCloud).toBe("above");
    expect(result.chikouConfirms).toBe(true);
  });

  it("reads price below the cloud in a clean, sustained downtrend", () => {
    const downtrend = Array.from({ length: 60 }, (_, i) => bar(1200 - i * 2, 1198 - i * 2, 1199 - i * 2, i));
    const result = ichimoku(downtrend)!;
    expect(result.priceVsCloud).toBe("below");
    expect(result.chikouConfirms).toBe(false);
  });

  it("returns null below 52 bars", () => {
    expect(ichimoku(Array.from({ length: 30 }, (_, i) => bar(10, 9, 9.5, i)))).toBeNull();
  });
});

describe("fibonacciRetracement", () => {
  it("bounds swing high/low from the actual extremes in the window", () => {
    const candles = Array.from({ length: 50 }, (_, i) => bar(100, 90, 95, i));
    candles[10] = bar(150, 145, 148, 10);
    candles[30] = bar(52, 50, 51, 30);
    const result = fibonacciRetracement(candles)!;
    expect(result.swingHigh).toBe(150);
    expect(result.swingLow).toBe(50);
  });

  it("places the 50% level at the exact midpoint of the range", () => {
    const candles = Array.from({ length: 50 }, (_, i) => bar(100, 90, 95, i));
    candles[10] = bar(150, 145, 148, 10);
    candles[30] = bar(52, 50, 51, 30);
    const result = fibonacciRetracement(candles)!;
    const fifty = result.levels.find((l) => l.ratio === 0.5)!;
    expect(fifty.price).toBe((150 + 50) / 2);
  });

  it("orders levels from the swing high (ratio 0) down to the swing low (ratio 1)", () => {
    const candles = Array.from({ length: 50 }, (_, i) => bar(100, 90, 95, i));
    candles[10] = bar(150, 145, 148, 10);
    candles[30] = bar(52, 50, 51, 30);
    const result = fibonacciRetracement(candles)!;
    expect(result.levels[0]).toEqual({ ratio: 0, price: 150 });
    expect(result.levels[result.levels.length - 1]).toEqual({ ratio: 1, price: 50 });
  });

  it("returns null below the window", () => {
    expect(fibonacciRetracement(Array(10).fill(bar(10, 9, 9.5, 0)))).toBeNull();
  });

  it("returns null when the swing range is degenerate (flat price)", () => {
    expect(fibonacciRetracement(Array.from({ length: 50 }, (_, i) => bar(100, 100, 100, i)))).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * ATR AS A PERCENT, AND THE PROPERTY THAT KEEPS THE PAGE HONEST
 *
 * The dossier used to print "typical daily move" twice from two different
 * estimators — Wilder's here, a 14-bar simple mean in the volatility
 * module — disagreeing by up to 15.8% relative across the panel, with the
 * unvalidated one attached to the copy telling a user where to put a stop.
 * These tests exist so the two can never drift apart again.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("atrPctSeries", () => {
  const series = Array.from({ length: 60 }, (_, i) => bar(105 + i * 0.3, 95 + i * 0.3, 100 + i * 0.3, i));

  /*
   * THE INVARIANT. The narrative reads the last element of this series; the
   * planner reads `atr()`. Identical, not merely close — a tolerance here
   * would be the reconciliation the audit explicitly warned against.
   */
  it("ends on exactly the value atr() reports, as a percent of the last close", () => {
    const last = series[series.length - 1];
    const expected = (atr(series)! / last.close) * 100;
    expect(atrPctSeries(series)[series.length - 1]).toBe(expected);
  });

  it("is aligned to the input, with nulls where there is no reading yet", () => {
    const out = atrPctSeries(series, 14);
    expect(out).toHaveLength(series.length);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out.slice(14).every((v) => typeof v === "number")).toBe(true);
  });

  /*
   * THE LOOK-AHEAD GUARD. `trueRanges[j]` describes bar j+1 and
   * `wilderSmooth[k]` describes bar period+k; an off-by-one would give bar i
   * a value computed from bar i+1's range. Truncating the input must not
   * change any earlier reading.
   */
  it("never lets a later bar change an earlier reading", () => {
    const full = atrPctSeries(series);
    const truncated = atrPctSeries(series.slice(0, 40));
    expect(truncated).toEqual(full.slice(0, 40));
  });

  it("returns all nulls rather than throwing on too little history", () => {
    expect(atrPctSeries(series.slice(0, 5))).toEqual([null, null, null, null, null]);
  });

  it("reports a constant range as that range over price", () => {
    const flat = Array.from({ length: 40 }, (_, i) => bar(105, 95, 100, i));
    expect(atrPctSeries(flat)[39]).toBeCloseTo(10, 9);
  });
});
