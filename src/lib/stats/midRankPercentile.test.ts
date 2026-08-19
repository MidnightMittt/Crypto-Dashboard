import { describe, expect, it } from "vitest";
import { midRankPercentile, midRankPercentilePct } from "./midRankPercentile";

describe("midRankPercentile", () => {
  /*
   * THE FAILURE THIS ESTIMATOR EXISTS TO PREVENT.
   *
   * `below / n` returns 0 when the value ties everything, which reads as the
   * 0th percentile — a maximally bearish signal manufactured out of zero
   * variance. Splitting the tied mass puts it at the middle, which is the
   * honest answer for a measure that never moved.
   */
  it("puts a value that ties the whole distribution at the middle, not the floor", () => {
    expect(midRankPercentile(5, [5, 5, 5, 5])).toBe(0.5);
  });

  it("splits ties rather than counting them as below", () => {
    // 2 below, 2 equal, 1 above -> (2 + 1) / 5
    expect(midRankPercentile(5, [1, 2, 5, 5, 9])).toBeCloseTo(0.6, 12);
  });

  it("returns 1 above everything and 0 below everything", () => {
    expect(midRankPercentile(10, [1, 2, 3])).toBe(1);
    expect(midRankPercentile(0, [1, 2, 3])).toBe(0);
  });

  /*
   * Null means "nothing to compare against", NOT "the middle". A caller that
   * wants to treat an empty history as 0.5 says so at its own call site —
   * see volTermStructure, which does exactly that and documents why.
   */
  it("refuses an empty history rather than inventing a middle", () => {
    expect(midRankPercentile(5, [])).toBeNull();
  });

  it("is unaffected by the order of the history", () => {
    const a = midRankPercentile(4, [1, 9, 4, 7, 2]);
    const b = midRankPercentile(4, [9, 7, 4, 2, 1]);
    expect(a).toBe(b);
  });

  it("reports the same figure rounded to a percent", () => {
    expect(midRankPercentilePct(5, [1, 2, 5, 5, 9])).toBe(60);
    expect(midRankPercentilePct(5, [])).toBeNull();
  });
});
