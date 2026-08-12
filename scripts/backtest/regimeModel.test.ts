import { describe, expect, it } from "vitest";
import {
  efficiencyRatio,
  realizedVol,
  percentileRank,
  classifyMarketRegime,
  stabilizeLabels,
  REGIME_LOOKBACK,
  MIN_PERCENTILE_HISTORY,
} from "./regimeModel";
import { Candle } from "../../src/lib/technicals/indicators";

/** Flat-OHLC candles from a close series — the regime measures only read `close`, so this is exact rather than approximate. */
function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i * 86_400_000, open: c, high: c, low: c, close: c, volumeUsd: 0 }));
}

describe("efficiencyRatio — hand-computed reference cases", () => {
  it("a perfectly straight advance is exactly 1.0", () => {
    // net = |104-100| = 4; distance = 1+1+1+1 = 4; 4/4 = 1
    const c = candlesFrom([100, 101, 102, 103, 104]);
    expect(efficiencyRatio(c, 4, 4)).toBeCloseTo(1, 10);
  });

  it("a perfectly straight decline is also 1.0 — efficiency is direction-agnostic", () => {
    const c = candlesFrom([104, 103, 102, 101, 100]);
    expect(efficiencyRatio(c, 4, 4)).toBeCloseTo(1, 10);
  });

  it("a round trip back to the start is exactly 0.0", () => {
    // net = |100-100| = 0; distance = 5+5+5+5 = 20; 0/20 = 0
    const c = candlesFrom([100, 105, 100, 105, 100]);
    expect(efficiencyRatio(c, 4, 4)).toBeCloseTo(0, 10);
  });

  it("a partial retrace gives the hand-computed fraction", () => {
    // closes 100 -> 110 -> 105 over lookback 2.
    // net = |105-100| = 5; distance = 10 + 5 = 15; 5/15 = 1/3
    const c = candlesFrom([100, 110, 105]);
    expect(efficiencyRatio(c, 2, 2)).toBeCloseTo(1 / 3, 10);
  });

  it("is bounded to [0,1] across a noisy series", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i * 0.1);
    const c = candlesFrom(closes);
    for (let i = REGIME_LOOKBACK; i < c.length; i++) {
      const er = efficiencyRatio(c, i)!;
      expect(er).toBeGreaterThanOrEqual(0);
      expect(er).toBeLessThanOrEqual(1);
    }
  });

  it("a completely flat series is maximally inefficient (0), not an error", () => {
    const c = candlesFrom([100, 100, 100, 100, 100]);
    expect(efficiencyRatio(c, 4, 4)).toBe(0);
  });

  it("returns null rather than a partial answer without enough history", () => {
    const c = candlesFrom([100, 101, 102]);
    expect(efficiencyRatio(c, 2, 5)).toBeNull();
    expect(efficiencyRatio(c, 1, 2)).toBeNull();
  });

  it("separates a trending series from a chopping series of the SAME total distance travelled", () => {
    // Both travel 20 points in total; one arrives, one does not. This is
    // precisely the distinction no existing measure in the engine makes.
    const trend = candlesFrom([100, 105, 110, 115, 120]);
    const chop = candlesFrom([100, 105, 100, 105, 100]);
    expect(efficiencyRatio(trend, 4, 4)).toBeCloseTo(1, 10);
    expect(efficiencyRatio(chop, 4, 4)).toBeCloseTo(0, 10);
  });
});

describe("realizedVol", () => {
  it("is zero for a constant series and positive for a moving one", () => {
    expect(realizedVol(candlesFrom([100, 100, 100, 100, 100]), 4, 4)).toBeCloseTo(0, 10);
    expect(realizedVol(candlesFrom([100, 110, 95, 120, 90]), 4, 4)!).toBeGreaterThan(0);
  });

  it("ranks a violent series above a calm one", () => {
    const calm = realizedVol(candlesFrom([100, 100.5, 101, 100.7, 101.2]), 4, 4)!;
    const wild = realizedVol(candlesFrom([100, 120, 90, 130, 85]), 4, 4)!;
    expect(wild).toBeGreaterThan(calm);
  });

  it("returns null on a non-positive price rather than producing NaN from log(0)", () => {
    expect(realizedVol(candlesFrom([100, 0, 100, 100, 100]), 4, 4)).toBeNull();
  });
});

describe("percentileRank", () => {
  it("is hand-checkable", () => {
    expect(percentileRank(5, [1, 2, 3, 4])).toBe(1);
    expect(percentileRank(0, [1, 2, 3, 4])).toBe(0);
    expect(percentileRank(2.5, [1, 2, 3, 4])).toBe(0.5);
  });

  it("returns 0.5 on an empty baseline rather than dividing by zero", () => {
    expect(percentileRank(5, [])).toBe(0.5);
  });
});

describe("stabilizeLabels", () => {
  it("ignores a transient flip shorter than the confirmation window", () => {
    // One stray "b" in a run of "a" must not move the regime.
    const raw = ["a", "a", "a", "b", "a", "a", "a"];
    expect(stabilizeLabels(raw, 3)).toEqual(["a", "a", "a", "a", "a", "a", "a"]);
  });

  it("switches only after the new label holds for confirmDays consecutive bars", () => {
    // b appears at index 3; with confirmDays=3 it is confirmed at index 5.
    const raw = ["a", "a", "a", "b", "b", "b", "b"];
    expect(stabilizeLabels(raw, 3)).toEqual(["a", "a", "a", "a", "a", "b", "b"]);
  });

  it("resets the streak when the candidate is interrupted", () => {
    // b, b, then a interrupts, so b must start counting again from scratch.
    const raw = ["a", "b", "b", "a", "b", "b", "b", "b"];
    const out = stabilizeLabels(raw, 3);
    expect(out[3]).toBe("a");
    expect(out[out.length - 1]).toBe("b");
    // Never flipped during the first, aborted run of b.
    expect(out.slice(0, 4)).toEqual(["a", "a", "a", "a"]);
  });

  it("confirmDays=1 is a pass-through (no hysteresis)", () => {
    const raw = ["a", "b", "a", "b"];
    expect(stabilizeLabels(raw, 1)).toEqual(raw);
  });

  it("is causal — a later label can never change an earlier output", () => {
    const raw = ["a", "a", "b", "b", "b", "b", "a", "a"];
    const full = stabilizeLabels(raw, 3);
    for (let cut = 1; cut <= raw.length; cut++) {
      const truncated = stabilizeLabels(raw.slice(0, cut), 3);
      expect(truncated).toEqual(full.slice(0, cut));
    }
  });

  it("strictly reduces the number of switches on a churny series", () => {
    const raw = ["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"];
    const countSwitches = (xs: string[]) => xs.slice(1).filter((x, i) => x !== xs[i]).length;
    expect(countSwitches(stabilizeLabels(raw, 3))).toBeLessThan(countSwitches(raw));
  });

  it("handles empty and single-element input", () => {
    expect(stabilizeLabels([], 3)).toEqual([]);
    expect(stabilizeLabels(["a"], 3)).toEqual(["a"]);
  });
});

describe("classifyMarketRegime", () => {
  /** A long series alternating between smooth trending stretches and violent chop, so both tails of the efficiency distribution are genuinely populated. */
  function mixedSeries(): Candle[] {
    const closes: number[] = [100];
    for (let block = 0; block < 20; block++) {
      const trending = block % 2 === 0;
      for (let k = 0; k < 25; k++) {
        const last = closes[closes.length - 1];
        closes.push(trending ? last * 1.004 : last * (k % 2 === 0 ? 1.02 : 0.98));
      }
    }
    return candlesFrom(closes);
  }

  it("labels a smooth stretch trending and a chopping stretch choppy", () => {
    const c = mixedSeries();
    const reads = [];
    for (let i = 0; i < c.length; i++) {
      const r = classifyMarketRegime(c, i);
      if (r?.calibrated) reads.push({ i, r });
    }
    expect(reads.length).toBeGreaterThan(50);
    // The construction guarantees both extremes exist; a classifier that
    // collapsed to one label would be useless as a context layer.
    expect(reads.some((x) => x.r.efficiency === "trending")).toBe(true);
    expect(reads.some((x) => x.r.efficiency === "choppy")).toBe(true);
  });

  it("degrades to neutral labels (not null, not a guess) before the percentile baseline exists", () => {
    const c = candlesFrom(Array.from({ length: REGIME_LOOKBACK + 5 }, (_, i) => 100 + i));
    const r = classifyMarketRegime(c, REGIME_LOOKBACK + 4)!;
    expect(r.calibrated).toBe(false);
    expect(r.efficiency).toBe("mixed");
    expect(r.volatility).toBe("normal");
    // The raw measure is still real even when the percentile is not.
    expect(r.efficiencyRatio).toBeCloseTo(1, 6);
  });

  it("returns null when there is not even enough history for the raw measures", () => {
    expect(classifyMarketRegime(candlesFrom([100, 101, 102]), 2)).toBeNull();
  });

  /*
   * The look-ahead guard, checked the way the rest of this codebase checks
   * it (scripts/backtest/pointInTime.test.ts): truncate the series to what
   * existed at the decision bar and require an identical classification.
   * If the percentile baseline ever leaked a future bar, these would differ.
   */
  it("is point-in-time safe: truncating away all future bars changes nothing", () => {
    const full = mixedSeries();
    for (const i of [300, 350, 400, 450]) {
      const withFuture = classifyMarketRegime(full, i);
      const truncated = classifyMarketRegime(full.slice(0, i + 1), i);
      expect(truncated).toEqual(withFuture);
    }
  });

  it("assigns each tercile roughly a third of a long history, by construction", () => {
    const c = mixedSeries();
    const labels: string[] = [];
    for (let i = 0; i < c.length; i++) {
      const r = classifyMarketRegime(c, i);
      if (r?.calibrated) labels.push(r.efficiency);
    }
    const share = (l: string) => labels.filter((x) => x === l).length / labels.length;
    // Terciles of the instrument's own distribution: no bucket should be
    // empty or swallow everything. Wide bounds — this is a sanity check that
    // the percentile logic works, not a distributional claim.
    expect(share("trending")).toBeGreaterThan(0.1);
    expect(share("choppy")).toBeGreaterThan(0.1);
  });

  it("needs MIN_PERCENTILE_HISTORY prior observations before it claims calibration", () => {
    const c = candlesFrom(Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.05));
    const tooEarly = classifyMarketRegime(c, REGIME_LOOKBACK + MIN_PERCENTILE_HISTORY - 5)!;
    const lateEnough = classifyMarketRegime(c, REGIME_LOOKBACK + MIN_PERCENTILE_HISTORY + 50)!;
    expect(tooEarly.calibrated).toBe(false);
    expect(lateEnough.calibrated).toBe(true);
  });
});
