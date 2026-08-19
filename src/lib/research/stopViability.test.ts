import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import {
  MIN_ENTRIES,
  SURVIVAL_FLOOR_PCT,
  describeStop,
  narrowestViable,
  stopGrid,
  survivalAt,
} from "./stopViability";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** Bars from explicit (close, low) pairs, so every test states its own path. */
const bars = (pairs: Array<[number, number]>): Bar[] =>
  pairs.map(([close, low], i) => ({
    t: T0 + i * DAY,
    open: close,
    high: Math.max(close, low) * 1.01,
    low,
    close,
    volume: 1_000_000,
  }));

/** n flat bars at 100 whose lows never threaten a stop. */
const calm = (n: number): Bar[] => bars(Array.from({ length: n }, () => [100, 99.5]));

describe("survivalAt", () => {
  /*
   * A stop is a resting order and gets taken out INTRADAY. Measuring against
   * closes would call this survival, which is the number no trader ever
   * experiences: the session traded 6% down and closed flat.
   */
  it("counts a stop hit by the LOW even when the close recovered", () => {
    const path = calm(40);
    path[10] = { ...path[10], low: 94, close: 100 }; // -6% intraday, flat close
    const cell = survivalAt(path, 5, 1)!;
    // One entry (bar 9) has bar 10 in its window and is stopped out.
    expect(cell.n).toBe(39);
    expect(cell.survivalPct).toBeCloseTo((38 / 39) * 100, 10);
  });

  /*
   * Entry is AT the close of bar i, so bar i's own low already happened.
   * Counting it would manufacture stop-outs that could not occur.
   */
  it("cannot be stopped out by the entry bar's own low", () => {
    const path = calm(40);
    path[10] = { ...path[10], low: 80, close: 100 }; // a brutal bar 10
    // Horizon 1 from entry 10 looks only at bar 11, which is calm.
    const cell = survivalAt(path, 5, 1)!;
    // Only entry 9 sees bar 10. Entry 10 itself survives.
    expect(cell.survivalPct).toBeCloseTo((38 / 39) * 100, 10);
  });

  /* Hand-computed: 100 -> stop at 5% is 95. A low of exactly 95 IS a fill. */
  it("treats a low exactly at the stop as hit, not as survived", () => {
    const path = calm(40);
    path[20] = { ...path[20], low: 95 };
    const cell = survivalAt(path, 5, 1)!;
    expect(cell.survivalPct).toBeCloseTo((38 / 39) * 100, 10);
  });

  /*
   * A wider stop cannot survive less often than a tighter one on the same
   * path. This is the monotonicity that makes the grid readable at all.
   */
  it("is monotone in width — wider never survives less", () => {
    const path = bars(
      Array.from({ length: 60 }, (_, i) => [100, 100 - (i % 12)] as [number, number])
    );
    const widths = [2, 3, 5, 8, 10];
    const survivals = widths.map((w) => survivalAt(path, 5, 5, 1)! && survivalAt(path, w, 5, 1)!.survivalPct);
    for (let i = 1; i < survivals.length; i++) {
      expect(survivals[i]).toBeGreaterThanOrEqual(survivals[i - 1]);
    }
  });

  /* And monotone the other way in horizon: more days is more chances to be hit. */
  it("is monotone in horizon — longer never survives more", () => {
    const path = bars(
      Array.from({ length: 80 }, (_, i) => [100, 100 - (i % 15)] as [number, number])
    );
    const s1 = survivalAt(path, 5, 1, 1)!.survivalPct;
    const s5 = survivalAt(path, 5, 5, 1)!.survivalPct;
    const s21 = survivalAt(path, 5, 21, 1)!.survivalPct;
    expect(s5).toBeLessThanOrEqual(s1);
    expect(s21).toBeLessThanOrEqual(s5);
  });

  /*
   * Windows OVERLAP, so n overstates independent information. Reporting only n
   * would invite a confidence interval that is far too tight — the same
   * correction the harmonic study needed.
   */
  it("reports the non-overlapping count beside the overlapping one", () => {
    const cell = survivalAt(calm(105), 5, 5)!;
    expect(cell.n).toBe(100);
    expect(cell.independentN).toBe(20);
  });

  it("refuses a rate computed on too few entries", () => {
    expect(survivalAt(calm(MIN_ENTRIES), 5, 1)).toBeNull();
  });
});

describe("stopGrid and the reading", () => {
  it("refuses a symbol without enough history for the longest horizon", () => {
    expect(stopGrid("APLD", calm(40))).toBeNull();
  });

  it("reports the window it was computed over", () => {
    const g = stopGrid("APLD", calm(200))!;
    expect(g.fromDate).toBe("2026-01-01");
    expect(g.sessions).toBe(200);
    expect(g.cells.length).toBeGreaterThan(0);
  });

  /*
   * THE NUMBER A TRADER WANTS: not a grid, but how much room this name needs.
   */
  it("finds the narrowest width that clears the floor", () => {
    // Lows cycle to -4%, so 2% and 3% are taken out and 5% is not.
    const path = bars(
      Array.from({ length: 200 }, (_, i) => [100, i % 5 === 0 ? 96 : 99.5] as [number, number])
    );
    const g = stopGrid("TEST", path)!;
    const v = narrowestViable(g, 5)!;
    expect(v.widthPct).toBe(5);
    expect(v.survivalPct).toBeGreaterThanOrEqual(SURVIVAL_FLOOR_PCT);
  });

  /*
   * Null is a REAL answer and the important one: no width on the grid survives
   * often enough, which is a reason not to take the trade rather than a reason
   * to widen without limit.
   */
  it("returns null when nothing on the grid survives, and says so plainly", () => {
    // Every third bar drops 20% intraday — no listed width is safe.
    const path = bars(
      Array.from({ length: 200 }, (_, i) => [100, i % 3 === 0 ? 80 : 99] as [number, number])
    );
    const g = stopGrid("WILD", path)!;
    expect(narrowestViable(g, 5)).toBeNull();
    const text = describeStop(g, 5);
    expect(text).toContain("NO stop on this grid survives");
    expect(text).toContain("deciding this trade, not the signal");
  });

  it("names both the needed width and what the tight one costs", () => {
    const path = bars(
      Array.from({ length: 200 }, (_, i) => [100, i % 5 === 0 ? 96 : 99.5] as [number, number])
    );
    const text = describeStop(stopGrid("TEST", path)!, 5);
    expect(text).toContain("needs at least a 5% stop");
    expect(text).toContain("A 2% stop");
  });
});
