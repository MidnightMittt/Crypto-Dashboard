import { describe, expect, it } from "vitest";
import { LabSeries, PeriodLeg } from "./signalLab";
import { benchmarkDecomposition } from "./benchmark";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

const series = (symbol: string, t: number[], close: number[]): LabSeries => ({
  symbol,
  t,
  close,
  high: close.map((c) => c * 1.01),
  low: close.map((c) => c * 0.99),
  volume: close.map(() => 1_000_000),
});

/** A benchmark that compounds a fixed rate every bar, for 400 bars. */
const bench = (perBar: number): LabSeries => {
  const t: number[] = [];
  const close: number[] = [];
  let px = 100;
  for (let i = 0; i < 400; i++) {
    t.push(T0 + i * DAY);
    close.push(px);
    px *= 1 + perBar;
  }
  return series("QQQ", t, close);
};

/** Twenty five-bar periods, back to back. */
const periods = (top: (k: number) => number, universe: (k: number) => number): PeriodLeg[] =>
  Array.from({ length: 20 }, (_, k) => ({
    entryTime: T0 + k * 5 * DAY,
    exitTime: T0 + (k * 5 + 5) * DAY,
    top: top(k),
    universe: universe(k),
  }));

describe("benchmarkDecomposition", () => {
  /*
   * The benchmark must be read at the hypothesis's OWN entry and exit, not on
   * a calendar this function rebuilds. Five bars at 0.1% compounds to
   * 1.001^5 - 1 = 0.50100...%, and the universe leg is set to exactly that,
   * so universe − index must land on zero.
   */
  it("reads the benchmark at the periods the hypothesis actually traded", () => {
    const fiveBars = 1.001 ** 5 - 1;
    const out = benchmarkDecomposition(
      periods(
        (k) => fiveBars + 0.01 + 0.001 * Math.sin(k),
        (k) => fiveBars + 0.0005 * Math.sin(k)
      ),
      bench(0.001)
    )!;
    expect(out.benchmark).toBe("QQQ");
    expect(out.decomposition.universeMinusIndex.meanPct).toBeCloseTo(
      // Mean of 0.0005*sin(k) over k=0..19, in percent.
      (Array.from({ length: 20 }, (_, k) => 0.0005 * Math.sin(k)).reduce((a, b) => a + b, 0) / 20) * 100,
      10
    );
  });

  /*
   * The identity has to survive the join, not just the pure module: if the
   * benchmark were read on shifted dates the columns would stop reconciling.
   */
  it("keeps the decomposition identity intact through the benchmark join", () => {
    const out = benchmarkDecomposition(
      periods((k) => 0.02 + 0.004 * Math.sin(k), (k) => 0.01 + 0.002 * Math.cos(k)),
      bench(0.0008)
    )!;
    const d = out.decomposition;
    expect(d.signalMinusIndex.meanPct).toBeCloseTo(
      d.signalMinusUniverse.meanPct + d.universeMinusIndex.meanPct,
      12
    );
  });

  /*
   * A benchmark that does not span a period contributes NOTHING for it, and
   * the period then drops from every column. Crediting a zero would hand the
   * signal the index's absence as outperformance.
   */
  it("drops periods the benchmark cannot cover rather than scoring them flat", () => {
    // Benchmark starts 60 bars late, so the first twelve 5-bar periods have
    // no bar at or before their entry.
    const late = bench(0.001);
    const shifted = series("QQQ", late.t.map((x) => x + 60 * DAY), late.close);
    const out = benchmarkDecomposition(
      periods(() => 0.02, () => 0.01),
      shifted
    );
    // 20 periods, 12 uncovered -> 8 remain, below the 12-period floor.
    expect(out).toBeNull();
  });

  it("refuses entirely when the benchmark series is unusable", () => {
    const empty = series("QQQ", [], []);
    expect(benchmarkDecomposition(periods(() => 0.02, () => 0.01), empty)).toBeNull();
  });
});
