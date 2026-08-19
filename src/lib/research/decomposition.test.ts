import { describe, expect, it } from "vitest";
import { LegPeriod, decompose, describeDecomposition } from "./decomposition";

const leg = (rets: number[], from = 1): LegPeriod[] =>
  rets.map((ret, k) => ({ date: `2026-01-${String(from + k).padStart(2, "0")}`, ret }));

/** Twenty periods, enough to clear the minimum and to hand-check a mean. */
const twenty = (f: (k: number) => number): LegPeriod[] =>
  Array.from({ length: 20 }, (_, k) => ({
    date: `2026-01-${String(k + 1).padStart(2, "0")}`,
    ret: f(k),
  }));

describe("decompose — the identity that makes it a decomposition", () => {
  /*
   * THE CENTRAL INVARIANT. If the means of the three columns do not reconcile
   * exactly, the columns are not measuring one thing three ways and none of
   * them can be trusted against the others.
   */
  it("reconciles: mean(signal−index) equals the sum of the other two", () => {
    const d = decompose(
      twenty((k) => 0.02 + 0.001 * k),
      twenty((k) => 0.01 - 0.0005 * k),
      twenty((k) => 0.005 + 0.0002 * ((k * 7) % 5))
    )!;
    expect(d.signalMinusIndex.meanPct).toBeCloseTo(
      d.signalMinusUniverse.meanPct + d.universeMinusIndex.meanPct,
      12
    );
  });

  /*
   * ...and the t-statistics deliberately do NOT add. A reader who expects
   * them to would conclude the arithmetic is broken; a test says it is not.
   * Each column carries its own variance, which is why three are reported.
   */
  it("does not let the t-statistics add, because variances differ", () => {
    const d = decompose(
      twenty((k) => 0.02 + 0.01 * Math.sin(k)),
      twenty((k) => 0.01 + 0.009 * Math.sin(k)),
      twenty(() => 0.005)
    )!;
    const summed = d.signalMinusUniverse.t + d.universeMinusIndex.t;
    expect(Math.abs(d.signalMinusIndex.t - summed)).toBeGreaterThan(0.5);
  });

  /* Hand-computed: signal 3% flat, universe 1% flat, index 0.5% flat. */
  it("computes each column from the per-period difference", () => {
    const d = decompose(twenty(() => 0.03), twenty(() => 0.01), twenty(() => 0.005))!;
    expect(d.signalMinusUniverse.meanPct).toBeCloseTo(2, 10);
    expect(d.universeMinusIndex.meanPct).toBeCloseTo(0.5, 10);
    expect(d.signalMinusIndex.meanPct).toBeCloseTo(2.5, 10);
  });

  /*
   * A constant difference has no dispersion, so the test cannot distinguish
   * anything and t is ZERO, not infinity. An infinite t on a degenerate
   * sample is the most confident possible way to be wrong.
   */
  it("reports t=0 rather than infinity when a difference never varies", () => {
    const d = decompose(twenty(() => 0.03), twenty(() => 0.01), twenty(() => 0.005))!;
    expect(d.signalMinusUniverse.sdPct).toBe(0);
    expect(d.signalMinusUniverse.t).toBe(0);
    expect(Number.isFinite(d.signalMinusUniverse.t)).toBe(true);
  });
});

describe("decompose — pairing and refusal", () => {
  /*
   * Columns must be computed on ONE date set. A period the index is missing
   * cannot contribute to signal−universe either, or the three columns would
   * silently describe different samples and the identity above would fail.
   */
  it("drops a period missing from any leg, from every column", () => {
    const signal = leg([0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03]);
    const universe = leg([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
    const index = leg([0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005]);
    const d = decompose(signal, universe, index, 12)!;
    expect(d.periods).toHaveLength(12);
    expect(d.signalMinusIndex.n).toBe(12);
    expect(d.droppedPeriods).toEqual(["2026-01-13"]);
    expect(d.signalMinusUniverse.n).toBe(12);
    expect(d.universeMinusIndex.n).toBe(12);
  });

  /*
   * Three numbers computed on a handful of periods are three numbers that
   * mean nothing, and shipping them invites the over-reading this module
   * exists to prevent.
   */
  it("refuses below the minimum period count instead of returning noise", () => {
    expect(decompose(leg([0.01, 0.02]), leg([0.01, 0.01]), leg([0.0, 0.0]))).toBeNull();
  });

  it("reports the smallest effect the sample could have resolved", () => {
    const d = decompose(
      twenty((k) => 0.02 + 0.01 * Math.sin(k)),
      twenty(() => 0.01),
      twenty(() => 0.005)
    )!;
    // At t=3 the detectable effect is three standard errors, by definition.
    const se = d.signalMinusUniverse.sdPct / Math.sqrt(d.signalMinusUniverse.n);
    expect(d.signalMinusUniverse.detectablePctAtT3).toBeCloseTo(3 * se, 12);
  });
});

describe("describeDecomposition", () => {
  /*
   * THE READING THAT MATTERS. Selection skill inside a universe that trailed
   * the index is a real finding and a bad reason to trade — the copy must not
   * promote it to an edge.
   */
  it("refuses to call selection skill an edge when the index is not cleared", () => {
    /*
     * Signal beats the pool steadily — the difference varies, so it has a
     * real standard error and a real t — while the pool trails the index by
     * far more than the ranking recovers.
     */
    const d = decompose(
      twenty((k) => 0.005 + 0.001 * Math.sin(k)),
      twenty((k) => 0.0 + 0.0002 * Math.sin(k)),
      twenty(() => 0.02)
    )!;
    expect(d.signalMinusUniverse.t).toBeGreaterThan(2);
    expect(d.signalMinusIndex.meanPct).toBeLessThan(0);
    const text = describeDecomposition(d);
    expect(text).toContain("does not clear the index");
    expect(text).toContain("not a reason to trade");
  });

  it("names the universe when the result clears the index without selection skill", () => {
    const d = decompose(
      twenty((k) => 0.03 + 0.0002 * Math.sin(k)),
      twenty((k) => 0.03 + 0.0002 * Math.sin(k)),
      twenty(() => 0.001)
    )!;
    expect(describeDecomposition(d)).toContain("composition is doing the work");
  });

  it("says plainly when nothing separates", () => {
    const d = decompose(
      twenty((k) => 0.01 * Math.sin(k)),
      twenty((k) => 0.01 * Math.sin(k + 0.1)),
      twenty((k) => 0.01 * Math.sin(k + 0.2))
    )!;
    expect(describeDecomposition(d)).toContain("Neither");
  });
});
