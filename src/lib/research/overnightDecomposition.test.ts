import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import {
  MAX_GAP_DAYS,
  ROUND_TRIP_TICKS,
  decomposeSymbol,
  decomposeWindow,
  tickCostBp,
} from "./overnightDecomposition";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5);

/** Bars from explicit (open, close) pairs, one calendar day apart. */
function bars(pairs: Array<[number, number]>, startAt = START, stepDays = 1): Bar[] {
  return pairs.map(([open, close], i) => ({
    t: startAt + i * stepDays * DAY,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1_000,
  }));
}

describe("tickCostBp — the whole reason this is not a flat charge", () => {
  /*
   * One cent is one cent regardless of price, so an identical crossing is a
   * different cost on every name. A flat basis-point assumption does not add
   * noise to the ranking, it REORDERS it.
   */
  it("scales inversely with price", () => {
    expect(tickCostBp(2, 1)!).toBeCloseTo(50, 6);
    expect(tickCostBp(12, 1)!).toBeCloseTo(8.3333, 3);
    expect(tickCostBp(30, 1)!).toBeCloseTo(3.3333, 3);
  });

  it("charges the declared number of ticks", () => {
    expect(tickCostBp(30, 2)!).toBeCloseTo(2 * tickCostBp(30, 1)!, 10);
    expect(tickCostBp(30)!).toBeCloseTo(tickCostBp(30, ROUND_TRIP_TICKS)!, 10);
  });

  it("refuses a non-positive price rather than returning Infinity", () => {
    expect(tickCostBp(0)).toBeNull();
    expect(tickCostBp(-5)).toBeNull();
  });
});

describe("decomposeWindow — the split itself", () => {
  /*
   * Hand-computed. Close 100 -> open 101 is +100bp overnight; open 101 ->
   * close 101 is 0bp intraday. Repeated so the mean is exactly +100bp and
   * the intraday mean exactly 0.
   */
  it("separates the gap from the session", () => {
    const b = bars([
      [100, 100],
      [101, 101],
      [102.01, 102.01],
      [103.0301, 103.0301],
    ]);
    const r = decomposeWindow(b, 120);
    expect(r.used).toBe(3);
    expect(r.overnightGross!.meanBp).toBeCloseTo(100, 6);
    expect(r.intradayGross!.meanBp).toBeCloseTo(0, 6);
  });

  it("puts an intraday move in the intraday leg and nothing overnight", () => {
    const b = bars([
      [100, 100],
      [100, 101],
      [101, 102.01],
    ]);
    const r = decomposeWindow(b, 120);
    expect(r.overnightGross!.meanBp).toBeCloseTo(0, 6);
    expect(r.intradayGross!.meanBp).toBeCloseTo(100, 6);
  });

  /* Net = gross minus the modelled cost charged on each observation. */
  it("charges the tick cost against the overnight leg", () => {
    const b = bars([
      [100, 100],
      [101, 101],
      [102.01, 102.01],
    ]);
    const r = decomposeWindow(b, 120);
    /*
     * Each observation is charged against ITS OWN prior close, so the mean
     * cost is the mean of 2bp (at $100) and 1.9802bp (at $101) — not 2bp
     * flat. This expectation was wrong first time round, and the difference
     * is exactly the effect the per-observation pricing exists to capture.
     */
    const perObs = [100, 101].map((p) => ((ROUND_TRIP_TICKS * 0.01) / p) * 10_000);
    const expectedCost = (perObs[0] + perObs[1]) / 2;
    expect(r.meanCostBp!).toBeCloseTo(expectedCost, 6);
    expect(r.overnightNet!.meanBp).toBeCloseTo(r.overnightGross!.meanBp - expectedCost, 6);
  });

  /*
   * Cost is charged against EACH session's own prior close, not the latest
   * price. On a name that has run from $2 to $30 the early observations
   * genuinely cost 25x what the recent ones do.
   */
  it("prices each observation off its own prior close", () => {
    const b = bars([
      [2, 2],
      [2, 2],
      [30, 30],
      [30, 30],
    ]);
    const r = decomposeWindow(b, 120);
    // Costs: at $2 -> 100bp, at $2 -> 100bp, at $30 -> 6.667bp. Mean 68.9bp.
    expect(r.meanCostBp!).toBeCloseTo((100 + 100 + 6.6667) / 3, 2);
  });

  /*
   * A fortnight-long hole is a halt or a data gap, not one night. Counting
   * it would import a multi-week move into a distribution of overnight ones.
   */
  it("drops a gap longer than the limit rather than calling it a night", () => {
    const clean = bars([
      [100, 100],
      [100, 100],
      [101, 101],
      [101, 101],
    ]);
    const withHole = [
      ...clean,
      // Three weeks later, +50%. A halt or a hole, not one night.
      { t: START + 25 * DAY, open: 150, high: 150, low: 150, close: 150, volume: 1 },
    ];
    const r = decomposeWindow(withHole, 120);
    expect(r.droppedGaps).toBe(1);
    // Three overnight observations survive; the +50% jump is not one of them.
    expect(r.used).toBe(3);
    expect(r.overnightGross!.meanBp).toBeLessThan(50);

    // Counting it would have dragged the mean into the thousands of bp.
    const unguarded = decomposeWindow(
      withHole.map((x, i) => (i === 4 ? { ...x, t: START + 4 * DAY } : x)),
      120
    );
    expect(unguarded.droppedGaps).toBe(0);
    expect(unguarded.overnightGross!.meanBp).toBeGreaterThan(1000);
  });

  it("keeps a normal weekend", () => {
    // Friday close -> Monday open is 3 calendar days, well inside the limit.
    const b = [
      { t: START, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { t: START + 3 * DAY, open: 101, high: 101, low: 101, close: 101, volume: 1 },
    ];
    expect(MAX_GAP_DAYS).toBeGreaterThanOrEqual(3);
    expect(decomposeWindow(b, 120).used).toBe(1);
  });

  it("reports the t-statistic from the sample, not from the mean alone", () => {
    // Constant +100bp overnight: zero dispersion, so t is defined as 0 rather
    // than infinite — a series with no variance proves nothing.
    const b = bars([[100, 100], [101, 101], [102.01, 102.01], [103.0301, 103.0301]]);
    const r = decomposeWindow(b, 120);
    expect(r.overnightGross!.sdBp).toBeCloseTo(0, 6);
    expect(r.overnightGross!.tStat).toBe(0);
    expect(r.overnightGross!.pValue).toBe(1);
  });

  it("annualises the Sharpe at 252 sessions", () => {
    const b = bars([[100, 100], [101, 100], [100, 100], [102, 101], [101, 101]]);
    const r = decomposeWindow(b, 120);
    expect(r.overnightGross!.sharpeAnnualised).toBeCloseTo(
      r.overnightGross!.sharpe * Math.sqrt(252),
      10
    );
  });

  it("returns nulls rather than zeros when there is nothing to measure", () => {
    const r = decomposeWindow([], 120);
    expect(r.overnightGross).toBeNull();
    expect(r.meanCostBp).toBeNull();
    expect(r.used).toBe(0);
  });

  it("uses only the trailing window", () => {
    const b = bars(Array.from({ length: 400 }, () => [100, 100] as [number, number]));
    expect(decomposeWindow(b, 120).used).toBe(120);
    expect(decomposeWindow(b, 250).used).toBe(250);
  });
});

describe("decomposeSymbol", () => {
  it("reports the cost at the latest price, which is what a reader is paying now", () => {
    const b = bars([[10, 10], [10, 10], [10, 20]]);
    const d = decomposeSymbol("TEST", b);
    expect(d.lastClose).toBe(20);
    expect(d.costBpAtLastClose!).toBeCloseTo(((2 * 0.01) / 20) * 10_000, 6);
  });

  it("refuses with a reason when no window can be filled", () => {
    const d = decomposeSymbol("TEST", bars([[10, 10], [10, 10]]));
    expect(d.reason).toContain("insufficient_history");
  });

  /*
   * THE GUARD THIS DEPENDS ON. An unadjusted corporate action lands entirely
   * in the OVERNIGHT leg, because the gap is where the price level changes.
   * One 2,633% night would swamp every statistic in the window, so bars must
   * be guarded before they arrive — this pins how bad it would be.
   */
  it("shows why the corporate-action guard has to run first", () => {
    const clean = bars(Array.from({ length: 100 }, () => [100, 100] as [number, number]));
    const withStep = [...clean];
    withStep[50] = { ...withStep[50], open: 2733, close: 2733 };
    const r = decomposeWindow(withStep, 120);
    // One unadjusted step drags a flat series to a wildly positive mean.
    expect(r.overnightGross!.meanBp).toBeGreaterThan(2000);
    expect(decomposeWindow(clean, 120).overnightGross!.meanBp).toBeCloseTo(0, 6);
  });
});
