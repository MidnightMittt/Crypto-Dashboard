import { describe, it, expect } from "vitest";
import { buildTechnicalRead, technicalConfirmation } from "./technicals";
import { Candle } from "../technicals/indicators";

const bar = (high: number, low: number, close: number, i: number, volumeUsd = 1000): Candle => ({
  t: i,
  open: close,
  high,
  low,
  close,
  volumeUsd,
});

/*
 * Deterministic pseudo-noise. Perfectly smooth synthetic series are
 * degenerate in ways real markets never are — a monotonic rise pins RSI at
 * exactly 100, and constant highs/lows make ADX mathematically undefined.
 * Testing against those shapes hides bugs that only appear on real data, so
 * every fixture below carries a repeatable wobble.
 */
const noise = (i: number) => Math.sin(i * 2.3) * 3 + Math.sin(i * 0.7) * 2;

const series = (length: number, level: (i: number) => number): Candle[] =>
  Array.from({ length }, (_, i) => {
    const close = level(i) + noise(i);
    return bar(close + 1.5, close - 1.5, close, i);
  });

/** Uptrend with realistic pullbacks, long enough for every indicator including EMA200. */
const uptrend = series(260, (i) => 100 + i);
/** Downtrend of the same length and shape. */
const downtrend = series(260, (i) => 500 - i);
/** Range-bound chop with no net direction. */
const flat = series(260, () => 100);

describe("buildTechnicalRead", () => {
  it("returns null below the minimum bar count rather than guessing", () => {
    expect(buildTechnicalRead(Array.from({ length: 30 }, (_, i) => bar(10, 9, 9.5, i)))).toBeNull();
  });

  it("reads a sustained uptrend as bullish, above all moving averages", () => {
    const read = buildTechnicalRead(uptrend)!;
    expect(read.direction).toBe("bullish");
    expect(read.emaAlignment).toBe("above-all");
    expect(read.trendStructure).toBe("higher-highs");
    expect(read.vwapPosition).toBe("above");
  });

  it("reads a sustained downtrend as bearish, below all moving averages", () => {
    const read = buildTechnicalRead(downtrend)!;
    expect(read.direction).toBe("bearish");
    expect(read.emaAlignment).toBe("below-all");
    expect(read.trendStructure).toBe("lower-lows");
    expect(read.vwapPosition).toBe("below");
  });

  it("damps strength when ADX says the market is ranging, not trending", () => {
    const trending = buildTechnicalRead(uptrend)!;
    const ranging = buildTechnicalRead(flat)!;
    expect(trending.strength).toBeGreaterThan(ranging.strength);
  });

  it("keeps strength within 0-100", () => {
    for (const series of [uptrend, downtrend, flat]) {
      const read = buildTechnicalRead(series)!;
      expect(read.strength).toBeGreaterThanOrEqual(0);
      expect(read.strength).toBeLessThanOrEqual(100);
    }
  });

  it("expresses ATR as a percentage of price so it compares across assets", () => {
    const read = buildTechnicalRead(uptrend)!;
    expect(read.atrPct).toBeGreaterThan(0);
    expect(read.atrPct).toBeLessThan(10);
  });

  it("treats an overbought RSI as exhaustion, not confirmation", () => {
    // A parabolic rise pins RSI near 100; the read must not be maximally
    // bullish, because the RSI vote flips bearish past 70.
    const parabolic = Array.from({ length: 260 }, (_, i) =>
      bar(100 * 1.03 ** i * 1.01, 100 * 1.03 ** i * 0.99, 100 * 1.03 ** i, i)
    );
    const read = buildTechnicalRead(parabolic)!;
    expect(read.rsi).toBeGreaterThan(70);
    // Still bullish overall, but not unanimously — RSI voted the other way.
    expect(read.strength).toBeLessThan(100);
  });

  it("does not let floating-point MACD noise cast a vote", () => {
    /*
     * Regression guard. On a smooth linear trend the fast and slow EMAs
     * converge, leaving a histogram around -1.8e-15 — mathematically zero,
     * but a bare `> 0` check read it as a full bearish vote and dragged a
     * clean uptrend's strength from 67 down to 33.
     */
    const smooth = Array.from({ length: 260 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i));
    const read = buildTechnicalRead(smooth)!;
    expect(Math.abs(read.macdHistogram!)).toBeLessThan(1e-9);
    expect(read.direction).toBe("bullish");
  });

  it("scores a clean trend more strongly than directionless chop", () => {
    /*
     * The bug this exists to prevent: strength originally measured only vote
     * lopsidedness, so a flat market where just two indicators could vote
     * scored a unanimous 100 while a genuine uptrend scored 33. Strength now
     * multiplies agreement by participation.
     */
    expect(buildTechnicalRead(uptrend)!.strength).toBeGreaterThan(
      buildTechnicalRead(flat)!.strength
    );
  });
});

describe("technicalConfirmation", () => {
  it("says price action confirms when technicals agree with the thesis", () => {
    const read = buildTechnicalRead(uptrend)!;
    const lines = technicalConfirmation(read, "bullish");
    expect(lines[0]).toContain("confirms");
    expect(lines[0]).toContain("bullish");
  });

  it("says price action weakens the thesis when technicals disagree", () => {
    const read = buildTechnicalRead(uptrend)!;
    const lines = technicalConfirmation(read, "bearish");
    expect(lines[0]).toContain("weakens");
  });

  it("handles a neutral thesis without claiming confirmation either way", () => {
    const read = buildTechnicalRead(uptrend)!;
    const lines = technicalConfirmation(read, "neutral");
    expect(lines[0]).not.toContain("confirms");
    expect(lines[0]).toContain("only side");
  });

  it("returns between 1 and 5 bullets, as the card is designed for", () => {
    for (const series of [uptrend, downtrend, flat]) {
      for (const dominant of ["bullish", "bearish", "neutral"] as const) {
        const lines = technicalConfirmation(buildTechnicalRead(series)!, dominant);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it("never surfaces a bare indicator value as a headline bullet", () => {
    // Every line should read as a sentence about meaning, not "RSI: 47".
    const lines = technicalConfirmation(buildTechnicalRead(uptrend)!, "bullish");
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(30);
      expect(line).toMatch(/[a-z]{4,}/);
    }
  });

  it("calls out fading momentum against higher highs as a divergence", () => {
    // Rise, then stall at the top so MACD rolls over while structure still
    // shows higher highs than the older half of the window.
    const stalling = [
      ...Array.from({ length: 220 }, (_, i) => bar(101 + i, 99 + i, 100 + i, i)),
      ...Array.from({ length: 40 }, (_, i) => bar(321, 316, 318 - i * 0.05, 220 + i)),
    ];
    const read = buildTechnicalRead(stalling)!;
    const lines = technicalConfirmation(read, "bullish");
    if (read.macdHistogram !== null && read.macdHistogram < 0 && read.trendStructure === "higher-highs") {
      expect(lines.some((l) => l.includes("losing its engine"))).toBe(true);
    }
  });
});
