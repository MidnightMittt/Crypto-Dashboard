import { describe, expect, it } from "vitest";
import { classifyRegime, regimeTagsToStrings } from "./regimes";
import { Candle } from "./indicators";

const DAY_MS = 86_400_000;

function candle(i: number, close: number, high = close, low = close): Candle {
  return { t: i * DAY_MS, open: close, high, low, close, volumeUsd: 1 };
}

describe("classifyRegime — trend", () => {
  it("returns null before there is even 20 days of history", () => {
    const candles = Array.from({ length: 19 }, (_, i) => candle(i, 100));
    expect(classifyRegime(candles, 18)).toBeNull();
  });

  it("classifies a clean +21.9% monotonic 20-day run as bull (1.01^20 - 1, well past the 7% threshold)", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 * 1.01 ** i));
    const result = classifyRegime(candles, 39);
    expect(result?.trend).toBe("bull");
  });

  it("classifies a clean -18.2% monotonic 20-day decline as bear (0.99^20 - 1, well past the -7% threshold)", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 * 0.99 ** i));
    const result = classifyRegime(candles, 39);
    expect(result?.trend).toBe("bear");
  });

  it("classifies a perfectly flat series as neutral", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100));
    const result = classifyRegime(candles, 39);
    expect(result?.trend).toBe("neutral");
  });

  it("treats the threshold as exclusive: +6.99% over 20 days is neutral, not bull", () => {
    // Deliberately NOT exactly 7.00% — (107-100)/100*100 evaluates to
    // 7.000000000000001 in IEEE double arithmetic (confirmed directly:
    // node -e computed this before writing the assertion), which is >7 and
    // would make this test flaky by relying on an exact floating-point tie.
    // 6.99% is unambiguously on the neutral side of the boundary instead.
    const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100));
    candles[19] = candle(19, 100);
    candles[39] = candle(39, 106.99);
    expect(classifyRegime(candles, 39)?.trend).toBe("neutral");
  });

  it("a hair above the threshold (+7.01%) is bull", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100));
    candles[19] = candle(19, 100);
    candles[39] = candle(39, 107.01);
    expect(classifyRegime(candles, 39)?.trend).toBe("bull");
  });
});

describe("classifyRegime — volatility (percentile-relative, not a fixed threshold)", () => {
  /**
   * 250 calm days (tiny +/-0.05% daily noise, narrow intraday range) followed
   * by 20 wild days (large alternating swings, wide intraday range). The
   * WILD day's trailing-14d vol should rank far above its own trailing-180d
   * history (which is overwhelmingly calm days), and vice versa for a calm
   * day deep in the baseline with a fully-calm 180-day history behind it.
   */
  function buildCalmThenWildSeries(): Candle[] {
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 250; i++) {
      price *= i % 2 === 0 ? 1.0005 : 0.9995; // tiny alternating noise
      candles.push(candle(i, price, price * 1.001, price * 0.999));
    }
    for (let i = 250; i < 270; i++) {
      price *= i % 2 === 0 ? 1.06 : 0.94; // large alternating swings
      candles.push(candle(i, price, price * 1.08, price * 0.92));
    }
    return candles;
  }

  it("flags a day deep in a volatile stretch as high-vol", () => {
    const candles = buildCalmThenWildSeries();
    const result = classifyRegime(candles, 265); // well into the wild run, 180d history behind it is mostly calm
    expect(result?.volatility).toBe("high");
  });

  it("flags a day deep in the calm baseline (full calm 180d history behind it) as not high-vol", () => {
    const candles = buildCalmThenWildSeries();
    const result = classifyRegime(candles, 230); // still calm, 180d history (days 50-229) is entirely calm
    expect(result?.volatility).not.toBe("high");
  });

  it("degrades to normal/false, not null, before 30 points of percentile history exist (trend can still classify)", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 * 1.01 ** i));
    const result = classifyRegime(candles, 39);
    expect(result).not.toBeNull();
    expect(result?.volatility).toBe("normal");
    expect(result?.rangeBound).toBe(false);
  });
});

describe("classifyRegime — range-bound (percentile-relative compression)", () => {
  /**
   * 250 "wide" days whose spread slowly oscillates (a sine wave, period 50
   * days, 12-22% amplitude), then 20 days with an almost-zero range.
   *
   * Two earlier fixture attempts both failed for the SAME underlying
   * reason, confirmed by direct trace each time before touching this code
   * again: `trailingRangeCompression` takes the ENVELOPE (max high, min
   * low) across a 14-day window, not an average of daily spreads. A
   * perfectly constant spread makes every window tie exactly (ties rank at
   * percentile 0, not "bug", just unrealistic). A short 7-day cycling
   * spread gets fully captured — same max and min — inside EVERY 14-day
   * window regardless of which 14 days you pick, so compression was still
   * identical across the whole "wide" period. A period of 50 days (more
   * than 3x the 14-day window) is the fix: any given window only sees a
   * narrow arc of the slow wave, so different windows land at genuinely
   * different local levels — verified directly (day 230 lands at
   * percentile ~0.52 of its own 180d history, day 265's near-zero range
   * lands far below it) before writing the assertions below.
   */
  function buildWideThenTightSeries(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 250; i++) {
      const spread = 17 + 5 * Math.sin((2 * Math.PI * i) / 50);
      candles.push(candle(i, 100, 100 + spread / 2, 100 - spread / 2));
    }
    for (let i = 250; i < 270; i++) {
      candles.push(candle(i, 100, 100.05, 99.95)); // ~0.1% range
    }
    return candles;
  }

  it("flags a day with a much tighter range than its own 180d history as range-bound", () => {
    const candles = buildWideThenTightSeries();
    const result = classifyRegime(candles, 265);
    expect(result?.rangeBound).toBe(true);
  });

  it("does not flag a day whose range matches its own wide 180d history", () => {
    const candles = buildWideThenTightSeries();
    const result = classifyRegime(candles, 230);
    expect(result?.rangeBound).toBe(false);
  });
});

describe("regimeTagsToStrings", () => {
  it("flattens trend + volatility always, range-bound only when true", () => {
    expect(regimeTagsToStrings({ trend: "bull", volatility: "high", rangeBound: false })).toEqual(["bull", "high-vol"]);
    expect(regimeTagsToStrings({ trend: "bear", volatility: "low", rangeBound: true })).toEqual([
      "bear",
      "low-vol",
      "range-bound",
    ]);
    expect(regimeTagsToStrings({ trend: "neutral", volatility: "normal", rangeBound: false })).toEqual([
      "neutral",
      "normal-vol",
    ]);
  });
});
