import { describe, expect, it } from "vitest";
import { downsample, sparklineGeometry } from "./sparkline";

/**
 * Hand-computable fixtures throughout.
 *
 * A sparkline's output is coordinates, so nothing downstream can catch a
 * wrong one — a flipped axis or an off-by-five window renders as a perfectly
 * plausible picture. The only defence is arithmetic someone can check.
 *
 * The standing geometry: width 100, height 20, padY 2, so the drawable band
 * is y ∈ [2, 18] and 16px tall.
 */
const BOX = { width: 100, height: 20, padY: 2 };

describe("sparklineGeometry — the mapping", () => {
  /*
   * Three points, 0 → 10 → 20. x steps by 100/(3-1) = 50.
   * y: min 0 maps to the BOTTOM (18), max 20 to the TOP (2), 10 to 10.
   */
  it("maps high values to low y, because SVG grows downward", () => {
    const g = sparklineGeometry([0, 10, 20], BOX)!;
    expect(g.points).toBe("0,18 50,10 100,2");
    expect(g.last).toEqual({ x: 100, y: 2 });
  });

  it("draws a falling series falling", () => {
    const g = sparklineGeometry([20, 10, 0], BOX)!;
    expect(g.points).toBe("0,2 50,10 100,18");
  });

  it("reports the extremes it scaled against", () => {
    const g = sparklineGeometry([3, 9, 6], BOX)!;
    expect(g.min).toBe(3);
    expect(g.max).toBe(9);
  });

  it("refuses to draw fewer than two points rather than inventing a line", () => {
    expect(sparklineGeometry([5], BOX)).toBeNull();
    expect(sparklineGeometry([], BOX)).toBeNull();
    expect(sparklineGeometry([1, 2], { ...BOX, width: 0 })).toBeNull();
  });

  it("ignores non-finite values instead of producing NaN coordinates", () => {
    const g = sparklineGeometry([0, Number.NaN, 20], BOX)!;
    // Two usable points remain, so the step spans the full width.
    expect(g.points).toBe("0,18 100,2");
  });
});

describe("sparklineGeometry — the flat rule", () => {
  /*
   * THE LIE THIS PREVENTS. 100 → 100.02 is a 0.02% move. Scaled to fill a
   * 16px band it draws as a vertical climb, and a reader glancing at it sees
   * a breakout in a stock that did not move.
   */
  it("draws a near-flat series on a baseline rather than filling the box", () => {
    const g = sparklineGeometry([100, 100.01, 100.02], BOX)!;
    expect(g.flat).toBe(true);
    // Mid-height: 2 + 16/2 = 10, for every point.
    expect(g.points).toBe("0,10 50,10 100,10");
  });

  it("scales a series that genuinely moved", () => {
    // 100 → 105 is 5%, far above the 0.1% floor.
    const g = sparklineGeometry([100, 105], BOX)!;
    expect(g.flat).toBe(false);
    expect(g.points).toBe("0,18 100,2");
  });

  it("handles a perfectly constant series without dividing by zero", () => {
    const g = sparklineGeometry([7, 7, 7], BOX)!;
    expect(g.flat).toBe(true);
    expect(g.points).toBe("0,10 50,10 100,10");
  });

  /*
   * A long-short spread oscillates around zero, so its mean can be ~0 and a
   * relative test would divide by nothing. Range is the honest fallback.
   */
  it("judges a zero-mean series by its range, not a ratio", () => {
    const g = sparklineGeometry([-5, 0, 5], BOX)!;
    expect(g.flat).toBe(false);
    expect(g.points).toBe("0,18 50,10 100,2");
  });
});

describe("sparklineGeometry — the measurement window", () => {
  /*
   * The window is what makes this an EVIDENCE sparkline rather than
   * decoration: it shows the reader exactly which slice produced the number
   * printed beside it.
   */
  it("shades the trailing window only", () => {
    // 11 points, step 10. A 3-session window covers the last 3 points,
    // starting at index 8 → x = 80, width = 20.
    const g = sparklineGeometry(Array.from({ length: 11 }, (_, i) => i), {
      ...BOX,
      windowSessions: 3,
    })!;
    expect(g.window).toEqual({ x: 80, width: 20 });
  });

  it("shades nothing when the claim is about the whole series", () => {
    expect(sparklineGeometry([1, 2, 3], BOX)!.window).toBeNull();
  });

  /*
   * A 200-session claim drawn over 120 sessions of data must not shade past
   * the left edge — that would imply history the chart does not contain.
   */
  it("clamps a window longer than the series to the series", () => {
    const g = sparklineGeometry([1, 2, 3], { ...BOX, windowSessions: 500 })!;
    expect(g.window).toEqual({ x: 0, width: 100 });
  });
});

describe("downsample", () => {
  it("leaves a short series untouched", () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  /*
   * The right-hand end is the one point a reader will reconcile against the
   * quote printed beside the chart, so it is always kept.
   */
  it("always keeps the last value", () => {
    const out = downsample(Array.from({ length: 1000 }, (_, i) => i), 50);
    expect(out).toHaveLength(50);
    expect(out[out.length - 1]).toBe(999);
    expect(out[0]).toBe(0);
  });

  /*
   * STRIDED, not averaged. Averaging would smooth away the spikes a reader is
   * looking at the chart to find, while the result stayed labelled as price.
   */
  it("takes real observations rather than bucket averages", () => {
    const spiky = [0, 0, 0, 0, 50, 0, 0, 0, 0];
    const out = downsample(spiky, 5);
    // Every output value must exist in the input.
    for (const v of out) expect(spiky).toContain(v);
  });

  it("refuses a nonsensical target rather than guessing", () => {
    expect(downsample([1, 2, 3, 4], 1)).toEqual([1, 2, 3, 4]);
  });
});

describe("sparklineGeometry — the skipped month", () => {
  /*
   * The validated momentum signal is measured over twelve months EXCLUDING
   * the most recent one. Prose says so and readers still picture a plain
   * trailing year; shading the real window makes the construction visible.
   *
   * 11 points, step 10. windowSessions 5, windowOffset 2 → the window ends at
   * index 11-1-2 = 8 (x = 80) and starts at 8-5+1 = 4 (x = 40).
   */
  it("ends the window short of the right edge by the offset", () => {
    const g = sparklineGeometry(Array.from({ length: 11 }, (_, i) => i), {
      ...BOX,
      windowSessions: 5,
      windowOffset: 2,
    })!;
    expect(g.window).toEqual({ x: 40, width: 40 });
  });

  it("treats a zero offset as a plain trailing window", () => {
    const values = Array.from({ length: 11 }, (_, i) => i);
    const withZero = sparklineGeometry(values, { ...BOX, windowSessions: 3, windowOffset: 0 })!;
    const without = sparklineGeometry(values, { ...BOX, windowSessions: 3 })!;
    expect(withZero.window).toEqual(without.window);
  });

  it("shades nothing rather than a sliver when the offset swallows the series", () => {
    const g = sparklineGeometry([1, 2, 3], { ...BOX, windowSessions: 5, windowOffset: 10 })!;
    expect(g.window).toBeNull();
  });
});
