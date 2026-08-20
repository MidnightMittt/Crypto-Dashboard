import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import { TRAIL_ATR_MULTIPLE, trendState } from "./trendState";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** Bars from (close, range) pairs so each test states its own volatility. */
const bars = (rows: Array<[number, number]>): Bar[] =>
  rows.map(([close, range], i) => ({
    t: T0 + i * DAY,
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume: 1_000_000,
  }));

/** n sessions at `px` with a constant `range`, so ATR converges to `range`. */
const flat = (n: number, px: number, range: number): Bar[] =>
  bars(Array.from({ length: n }, () => [px, range]));

describe("trendState", () => {
  /*
   * THE LINE, hand-computed. 40 flat sessions at 100 with a constant 10-wide
   * range give ATR = 10. Trailing high is 100, so the line is 100 - 1.5x10 = 85.
   */
  it("puts the line at the trailing high less 1.5 ATR, in dollars", () => {
    const t = trendState("TEST", flat(40, 100, 10))!;
    expect(t.atr).toBeCloseTo(10, 6);
    expect(t.trailingHigh).toBe(100);
    expect(t.trailStop).toBeCloseTo(85, 6);
    expect(t.intact).toBe(true);
  });

  /*
   * THE WHOLE POINT OF ATR OVER PERCENT. Same 1.5 multiple, two names: one
   * with a 1% daily range and one with 13%. A single percentage trail cannot
   * serve both — 5% is four sessions of room on the first and a third of a
   * session on the second.
   */
  it("gives a volatile name far more room than a calm one at the same multiple", () => {
    const calm = trendState("SPY", flat(40, 100, 1))!;
    const wild = trendState("CORZ", flat(40, 100, 13))!;
    expect(calm.trailStop).toBeCloseTo(98.5, 6);
    expect(wild.trailStop).toBeCloseTo(80.5, 6);
    // A 5% trail (95) is OUTSIDE the calm name's line and INSIDE the wild one's
    // — it would be loose on one and pure noise on the other.
    expect(95).toBeLessThan(calm.trailStop);
    expect(95).toBeGreaterThan(wild.trailStop);
  });

  /*
   * The high is taken on CLOSES. An intraday spike that was not held would
   * ratchet the line up to a level the position never had the chance to sell
   * into, and the next ordinary session would breach it.
   */
  it("does not ratchet the line up on an intraday wick", () => {
    const path = flat(40, 100, 10);
    path[30] = { ...path[30], high: 180 }; // a spike, closing back at 100
    const t = trendState("TEST", path)!;
    expect(t.trailingHigh).toBe(100);
    // ATR rises because the range widened, so the line falls — it never rises
    // on a wick.
    expect(t.trailStop).toBeLessThan(85);
  });

  /* A high made before you owned it is not a high you could have sold into. */
  it("measures from the entry when one is supplied", () => {
    const path = bars([
      ...Array.from({ length: 30 }, () => [120, 10] as [number, number]),
      ...Array.from({ length: 20 }, () => [100, 10] as [number, number]),
    ]);
    const since = trendState("TEST", path, { entryIndex: 30 })!;
    expect(since.trailingHigh).toBe(100);
    const all = trendState("TEST", path, { lookback: 100 })!;
    expect(all.trailingHigh).toBe(120);
    /*
     * Measuring from entry gives a LOWER line, i.e. more room. That is the
     * point: being stopped relative to a $120 high you never had the chance to
     * sell into would exit a position that has done nothing wrong since you
     * owned it.
     */
    expect(since.trailStop).toBeLessThan(all.trailStop);
  });

  it("reports the trend broken once price sits at or below the line", () => {
    const path = bars([
      ...Array.from({ length: 35 }, () => [100, 10] as [number, number]),
      ...Array.from({ length: 5 }, () => [80, 10] as [number, number]),
    ]);
    const t = trendState("TEST", path)!;
    expect(t.intact).toBe(false);
    expect(t.roomUsd).toBeLessThan(0);
    expect(t.sentence).toContain("already there");
  });

  /* Room in ATR is the unit that travels between names; dollars do not. */
  it("reports distance in both dollars and ATR", () => {
    const t = trendState("TEST", flat(40, 100, 10))!;
    expect(t.roomUsd).toBeCloseTo(15, 6);
    expect(t.roomAtr).toBeCloseTo(TRAIL_ATR_MULTIPLE, 6);
  });

  /* The sentence must name a PRICE — that is the entire deliverable. */
  it("names the level in dollars rather than as a percentage", () => {
    const t = trendState("TEST", flat(40, 100, 10))!;
    expect(t.sentence).toContain("Below $85.00 the trend is over");
    expect(t.sentence).not.toMatch(/trail.*\d+%/);
  });

  it("refuses a series too short to have an ATR", () => {
    expect(trendState("TEST", flat(10, 100, 10))).toBeNull();
  });
});
