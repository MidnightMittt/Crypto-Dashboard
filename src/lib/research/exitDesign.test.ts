import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import {
  MIN_ENTRIES,
  compareToHold,
  definedRiskBudget,
  ladderOutcome,
  peakOfCurve,
  reachAt,
  reachCurve,
} from "./exitDesign";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** Bars from (close, high, low) triples so each test states its own path. */
const bars = (rows: Array<[number, number, number]>): Bar[] =>
  rows.map(([close, high, low], i) => ({
    t: T0 + i * DAY,
    open: close,
    high,
    low,
    close,
    volume: 1_000_000,
  }));

/** n flat sessions at `px` with no range — nothing is ever reached. */
const flat = (n: number, px = 100): Bar[] =>
  bars(Array.from({ length: n }, () => [px, px, px] as [number, number, number]));

describe("reachAt", () => {
  /*
   * TARGETS USE HIGHS, exactly as stops use lows. A level touched intraday
   * and given back still fills a resting order, so measuring on closes would
   * understate every rung.
   */
  it("counts a target touched intraday even if the close gives it back", () => {
    const path = flat(60);
    // Every session spikes 12% intraday and closes flat.
    for (let i = 0; i < path.length; i++) path[i] = { ...path[i], high: 112 };
    const c = reachAt(path, 10, 5)!;
    expect(c.reachPct).toBe(100);
  });

  it("reports zero when the high never reaches the target", () => {
    expect(reachAt(flat(60), 10, 5)!.reachPct).toBe(0);
  });

  /* Overlapping windows: n counts entries, independentN counts real evidence. */
  it("separates overlapping entries from independent windows", () => {
    const c = reachAt(flat(60), 10, 10)!;
    expect(c.n).toBe(50);
    expect(c.independentN).toBe(5);
  });

  it("refuses a series too short to say anything", () => {
    expect(reachAt(flat(MIN_ENTRIES + 2), 10, 5)).toBeNull();
    expect(reachAt(flat(100), 0, 5)).toBeNull();
    expect(reachAt(flat(100), 10, 0)).toBeNull();
  });

  /*
   * THE MEASUREMENT THAT SET THE RUNGS. A near target fills often for little;
   * a far one rarely for a lot. reachTimesTarget shows where the product
   * peaks, which is not where intuition puts it.
   */
  it("prices a near target against a far one on the same footing", () => {
    const path = flat(80);
    // Reaches +10% on every window, +40% on none.
    for (let i = 0; i < path.length; i++) path[i] = { ...path[i], high: 112 };
    const near = reachAt(path, 10, 20)!;
    const far = reachAt(path, 40, 20)!;
    expect(near.reachPct).toBe(100);
    expect(far.reachPct).toBe(0);
    expect(near.reachTimesTarget).toBeCloseTo(10, 5); // 100% x 10
    expect(far.reachTimesTarget).toBe(0);
    expect(peakOfCurve([near, far])!.targetPct).toBe(10);
  });
});

describe("reachCurve", () => {
  it("returns a cell per measurable target, nearest first", () => {
    const path = flat(120);
    for (let i = 0; i < path.length; i++) path[i] = { ...path[i], high: 118 };
    const curve = reachCurve(path, 10, [5, 15, 25]);
    expect(curve.map((c) => c.targetPct)).toEqual([5, 15, 25]);
    expect(curve[0].reachPct).toBe(100); // +5 reached
    expect(curve[1].reachPct).toBe(100); // +15 reached
    expect(curve[2].reachPct).toBe(0); // +25 not
  });

  it("omits targets the history cannot measure rather than reporting zero", () => {
    expect(reachCurve(flat(20), 10)).toEqual([]);
  });
});

describe("ladderOutcome", () => {
  /*
   * A ladder that fills every rung realises exactly the rungs. Hand-checked:
   * half at +10 and half at +20 on a path that reaches both = 15.00.
   */
  it("realises the rungs it fills", () => {
    const path = flat(80);
    for (let i = 0; i < path.length; i++) path[i] = { ...path[i], high: 125 };
    const r = ladderOutcome(path, 10, [[10, 0.5], [20, 0.5]], null)!;
    expect(r.meanPct).toBeCloseTo(15, 2);
    expect(r.medianPct).toBeCloseTo(15, 2);
  });

  /* Unsold size exits at the horizon close, not at the last rung. */
  it("exits the remainder at the horizon close", () => {
    const path = flat(80);
    for (let i = 0; i < path.length; i++) path[i] = { ...path[i], high: 112 };
    // Half fills at +10; the rest closes flat at 0.
    const r = ladderOutcome(path, 10, [[10, 0.5], [50, 0.5]], null)!;
    expect(r.meanPct).toBeCloseTo(5, 2);
  });

  /*
   * THE PESSIMISTIC TIE-BREAK. When a bar's low hits the stop and its high
   * hits a rung, intraday order is unknowable from a daily bar. Assuming the
   * favourable sequence would inflate every ladder by exactly the amount that
   * makes it look good, so the stop is assumed.
   */
  it("assumes the stop when a single bar could have hit either", () => {
    const path = flat(80);
    for (let i = 0; i < path.length; i++) path[i] = { ...path[i], high: 120, low: 80 };
    const r = ladderOutcome(path, 10, [[10, 1]], 10)!;
    expect(r.meanPct).toBeCloseTo(-10, 2);
  });

  it("refuses a series too short to replay", () => {
    expect(ladderOutcome(flat(20), 10, [[10, 1]], null)).toBeNull();
  });
});

describe("compareToHold", () => {
  const ladder = { meanPct: 4, medianPct: 3, n: 100, independentN: 5 };

  it("names both statistics and says they agree", () => {
    const s = compareToHold(ladder, { meanPct: 2, medianPct: 1, n: 100, independentN: 5 });
    expect(s).toContain("+2.00pp");
    expect(s).toContain("+2.00pp");
    expect(s).toContain("Both move the same way");
    expect(s).toContain("helped");
  });

  /*
   * THE CASE THE WHOLE FUNCTION EXISTS FOR. A single runner drags the mean
   * while the median says most trades were unremarkable. Refusing a verdict
   * here is not indecision — which statistic matters depends on whether the
   * account survives the variance, and that is not a question about the data.
   */
  it("refuses a verdict when mean and median disagree in sign", () => {
    const s = compareToHold(ladder, { meanPct: 9, medianPct: 1, n: 100, independentN: 5 });
    expect(s).toContain("disagree in SIGN");
    expect(s).toContain("No verdict is offered");
    expect(s).toContain("position size");
  });

  /* The honest sample size travels with the comparison. */
  it("reports independent windows rather than overlapping entries", () => {
    const s = compareToHold(ladder, { meanPct: 2, medianPct: 1, n: 100, independentN: 5 });
    expect(s).toContain("5 independent windows");
  });
});

/**
 * The budget that replaces a stop when no stop exists. Sized on the real
 * account the night this shipped: 436.04 against a 100 hard floor is 336.04
 * of capacity; four concurrent defined-risk positions is 84.01 each.
 */
describe("definedRiskBudget", () => {
  it("divides capacity above the hard floor across concurrent positions", () => {
    const b = definedRiskBudget(436.04, 100, 4)!;
    expect(b.riskCapacityUsd).toBe(336.04);
    expect(b.perPositionUsd).toBe(84.01);
  });

  it("refuses an account at or under its own floor — no negative permission slips", () => {
    expect(definedRiskBudget(100, 100, 4)).toBeNull();
    expect(definedRiskBudget(90, 100, 4)).toBeNull();
  });

  it("refuses a nonsensical position count", () => {
    expect(definedRiskBudget(436, 100, 0)).toBeNull();
    expect(definedRiskBudget(436, 100, 2.5)).toBeNull();
    expect(definedRiskBudget(436, 100, -1)).toBeNull();
  });

  it("refuses a negative floor rather than inflating capacity", () => {
    expect(definedRiskBudget(436, -50, 4)).toBeNull();
  });
});
