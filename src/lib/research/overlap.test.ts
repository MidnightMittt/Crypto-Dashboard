import { describe, expect, it } from "vitest";
import {
  mulberry32,
  effectiveSampleSize,
  nonOverlappingByTime,
  allOffsetSubsamples,
  movingBlockBootstrap,
  blockBootstrapProportion,
  differenceOfProportions,
  detectableDifference,
} from "./overlap";

/** Deterministic 0/1 series with no serial dependence — the IID reference case the analytic formulas actually apply to. */
function independentSeries(n: number, p: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => (rng() < p ? 1 : 0));
}

describe("mulberry32", () => {
  it("is deterministic for a given seed and differs across seeds", () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    const c = Array.from({ length: 5 }, mulberry32(43));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("effectiveSampleSize", () => {
  it("divides by the known overlap, hand-checkable", () => {
    // A 30-day forward return sampled daily over 900 days encodes 30 independent windows.
    expect(effectiveSampleSize(900, 30)).toBeCloseTo(30, 10);
    expect(effectiveSampleSize(1000, 1)).toBe(1000); // no overlap, nothing lost
    expect(effectiveSampleSize(0, 30)).toBe(0);
  });
});

describe("nonOverlappingByTime", () => {
  it("greedily keeps only genuinely disjoint windows", () => {
    // Hand-built: A[0,10) B[5,15) C[10,20) D[12,30) E[30,40)
    // Greedy from the earliest start: A kept (free at 10). B starts 5 < 10, skipped.
    // C starts 10, not < 10, kept (free at 20). D starts 12 < 20, skipped.
    // E starts 30, kept.
    const items = [
      { id: "A", s: 0, e: 10 },
      { id: "B", s: 5, e: 15 },
      { id: "C", s: 10, e: 20 },
      { id: "D", s: 12, e: 30 },
      { id: "E", s: 30, e: 40 },
    ];
    const kept = nonOverlappingByTime(items, (x) => x.s, (x) => x.e);
    expect(kept.map((x) => x.id)).toEqual(["A", "C", "E"]);
  });

  it("sorts chronologically before walking, so input order cannot change the answer", () => {
    const items = [
      { id: "E", s: 30, e: 40 },
      { id: "A", s: 0, e: 10 },
      { id: "C", s: 10, e: 20 },
    ];
    expect(nonOverlappingByTime(items, (x) => x.s, (x) => x.e).map((x) => x.id)).toEqual(["A", "C", "E"]);
  });

  it("keeps everything when nothing overlaps, and one item when everything does", () => {
    const disjoint = [{ s: 0, e: 1 }, { s: 1, e: 2 }, { s: 2, e: 3 }];
    expect(nonOverlappingByTime(disjoint, (x) => x.s, (x) => x.e)).toHaveLength(3);
    const identical = [{ s: 0, e: 100 }, { s: 1, e: 100 }, { s: 2, e: 100 }];
    expect(nonOverlappingByTime(identical, (x) => x.s, (x) => x.e)).toHaveLength(1);
  });
});

describe("allOffsetSubsamples", () => {
  it("returns exactly `stride` subsamples that partition the input", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const subs = allOffsetSubsamples(items, 3);
    expect(subs).toHaveLength(3);
    expect(subs[0]).toEqual([0, 3, 6]);
    expect(subs[1]).toEqual([1, 4, 7]);
    expect(subs[2]).toEqual([2, 5, 8]);
    // Every original observation appears exactly once across the subsamples.
    expect(subs.flat().sort((a, b) => a - b)).toEqual(items);
  });

  it("stride 1 returns the whole series unchanged", () => {
    expect(allOffsetSubsamples([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  });
});

describe("movingBlockBootstrap", () => {
  it("is reproducible under a fixed seed", () => {
    const values = independentSeries(200, 0.5, 7);
    const a = movingBlockBootstrap(values, 10, 500, 99);
    const b = movingBlockBootstrap(values, 10, 500, 99);
    expect(a).toEqual(b);
    expect(a).toHaveLength(500);
  });

  it("centres on the sample mean", () => {
    const values = independentSeries(500, 0.3, 11);
    const observed = values.reduce((x, y) => x + y, 0) / values.length;
    const dist = movingBlockBootstrap(values, 5, 2000, 3);
    const mean = dist.reduce((x, y) => x + y, 0) / dist.length;
    expect(mean).toBeCloseTo(observed, 1);
  });
});

describe("blockBootstrapProportion — the reference cases that prove the correction is real", () => {
  /*
   * THE key verification. With blockLength = 1 the moving block bootstrap
   * degenerates to the ordinary IID bootstrap, whose standard error is known
   * analytically to converge to the binomial sqrt(p(1-p)/n). If this test
   * fails, the bootstrap machinery is wrong and every number it produces
   * downstream is worthless — so this is checked against the closed-form
   * value, not against a previously recorded output.
   */
  it("blockLength=1 reproduces the analytic binomial standard error", () => {
    const values = independentSeries(1000, 0.5, 21);
    const res = blockBootstrapProportion(values, 1, 0.5, 4000, 5)!;
    const analytic = Math.sqrt((res.point * (1 - res.point)) / res.n);
    expect(res.bootstrapSe).toBeGreaterThan(analytic * 0.85);
    expect(res.bootstrapSe).toBeLessThan(analytic * 1.15);
    expect(res.naiveSe).toBeCloseTo(analytic, 10);
    expect(res.effectiveN).toBe(1000);
  });

  it("an IID series is not materially penalised even at a large block length", () => {
    // Blocks only inflate the SE when there is real dependence to preserve.
    // On genuinely independent data a block bootstrap should stay close to
    // the naive SE — otherwise the correction would be punishing everything
    // indiscriminately rather than measuring dependence.
    const values = independentSeries(1000, 0.5, 33);
    const res = blockBootstrapProportion(values, 20, 0.5, 4000, 5)!;
    expect(res.bootstrapSe).toBeLessThan(res.naiveSe * 1.6);
  });

  /*
   * The complementary case: a strongly serially dependent series, where the
   * naive SE is badly overconfident and the bootstrap must say so. Built as
   * alternating runs of 10 identical values — 500 observations that carry
   * roughly 50 observations' worth of information.
   */
  it("a strongly dependent series inflates the SE well beyond the naive one", () => {
    const values: number[] = [];
    for (let i = 0; i < 50; i++) for (let k = 0; k < 10; k++) values.push(i % 2);
    const res = blockBootstrapProportion(values, 10, 0.5, 4000, 5)!;
    expect(res.point).toBeCloseTo(0.5, 10);
    expect(res.bootstrapSe).toBeGreaterThan(res.naiveSe * 1.8);
    expect(res.effectiveN).toBeCloseTo(50, 10);
  });

  /*
   * The end-to-end statement of what this module exists to fix: identical
   * data, identical observed win rate, but a p-value that stops being
   * significant once the dependence is accounted for.
   */
  it("turns a spuriously significant naive result into a non-significant corrected one", () => {
    // 300 observations in runs of 30 — 10 independent runs, 6 of them wins.
    // 60% of 300 looks overwhelming; 6 of 10 is a coin flip.
    const values: number[] = [];
    const outcomes = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
    for (const o of outcomes) for (let k = 0; k < 30; k++) values.push(o);

    const naiveZ = (0.6 - 0.5) / Math.sqrt((0.6 * 0.4) / 300); // ≈ 3.54 — "p < 0.001"
    expect(naiveZ).toBeGreaterThan(3);

    const res = blockBootstrapProportion(values, 30, 0.5, 4000, 5)!;
    expect(res.point).toBeCloseTo(0.6, 10);
    expect(res.effectiveN).toBeCloseTo(10, 10);
    expect(res.pValue).toBeGreaterThan(0.05); // no longer significant, correctly
  });

  it("reports no evidence rather than infinite confidence on a degenerate all-identical sample", () => {
    const res = blockBootstrapProportion([1, 1, 1, 1, 1, 1], 2, 0.5, 500, 5)!;
    expect(res.point).toBe(1);
    expect(res.bootstrapSe).toBe(0);
    expect(res.pValue).toBe(1);
  });

  it("returns null on an empty sample instead of NaN", () => {
    expect(blockBootstrapProportion([], 5)).toBeNull();
  });

  it("differenceOfProportions adds variances and finds a real gap between disjoint samples", () => {
    // Two independent IID samples, 70% vs 40% — a 30pp gap at n=400 each is
    // enormous and must register.
    const high = blockBootstrapProportion(independentSeries(400, 0.7, 101), 1, 0.5, 2000, 5)!;
    const low = blockBootstrapProportion(independentSeries(400, 0.4, 202), 1, 0.5, 2000, 5)!;
    const diff = differenceOfProportions(high, low);

    expect(diff.difference).toBeGreaterThan(0.2);
    // Variances add: hand-checkable against the two inputs.
    expect(diff.se).toBeCloseTo(Math.sqrt(high.bootstrapSe ** 2 + low.bootstrapSe ** 2), 12);
    expect(diff.pValue).toBeLessThan(0.001);
    expect(diff.lower).toBeGreaterThan(0); // CI excludes zero
  });

  it("differenceOfProportions reports no difference between two samples drawn the same way", () => {
    const a = blockBootstrapProportion(independentSeries(400, 0.5, 303), 1, 0.5, 2000, 5)!;
    const b = blockBootstrapProportion(independentSeries(400, 0.5, 404), 1, 0.5, 2000, 5)!;
    const diff = differenceOfProportions(a, b);
    expect(Math.abs(diff.difference)).toBeLessThan(0.1);
    expect(diff.pValue).toBeGreaterThan(0.05);
  });

  it("detectableDifference shrinks with sample size and is hand-checkable", () => {
    // 2.802 * sqrt(0.5/100) = 2.802 * 0.070710 = 0.19813
    expect(detectableDifference(100)).toBeCloseTo(0.19813, 4);
    expect(detectableDifference(400)).toBeCloseTo(0.09907, 4);
    expect(detectableDifference(400)).toBeLessThan(detectableDifference(100));
    expect(detectableDifference(0)).toBe(1);
  });

  it("is reproducible: identical inputs and seed give an identical p-value", () => {
    const values = independentSeries(400, 0.55, 77);
    const a = blockBootstrapProportion(values, 7, 0.5, 1000, 8)!;
    const b = blockBootstrapProportion(values, 7, 0.5, 1000, 8)!;
    expect(a.pValue).toBe(b.pValue);
    expect(a.bootstrapSe).toBe(b.bootstrapSe);
  });
});
