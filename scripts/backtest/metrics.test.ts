import { describe, expect, it } from "vitest";
import {
  winRate,
  meanReturn,
  medianReturn,
  maxDrawdown,
  confusionMatrix,
  signTestPValue,
  testSignificance,
  Occurrence,
  assetsPerDay,
  blockLengthFor,
} from "./metrics";

describe("winRate", () => {
  it("counts sign-match against direction, ignoring neutral and missing returns", () => {
    const occurrences: Occurrence[] = [
      { t: 1, verdict: "bullish", forwardReturnPct: 1 },
      { t: 2, verdict: "bullish", forwardReturnPct: -1 },
      { t: 3, verdict: "bullish", forwardReturnPct: 1 },
      { t: 4, verdict: "bullish", forwardReturnPct: 1 },
      { t: 5, verdict: "neutral", forwardReturnPct: 5 }, // excluded
      { t: 6, verdict: "bearish", forwardReturnPct: null }, // excluded
    ];
    expect(winRate(occurrences)).toBeCloseTo(0.75, 10);
  });

  it("a bearish signal wins when the return is negative", () => {
    const occurrences: Occurrence[] = [
      { t: 1, verdict: "bearish", forwardReturnPct: -2 },
      { t: 2, verdict: "bearish", forwardReturnPct: 2 },
    ];
    expect(winRate(occurrences)).toBeCloseTo(0.5, 10);
  });

  it("returns null with no scoreable occurrences", () => {
    expect(winRate([{ t: 1, verdict: "neutral", forwardReturnPct: 1 }])).toBeNull();
  });
});

describe("meanReturn / medianReturn", () => {
  it("matches hand-computed mean and median", () => {
    expect(meanReturn([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
    expect(medianReturn([1, 2, 3, 4])).toBeCloseTo(2.5, 10); // even count -> average of middle two
    expect(medianReturn([1, 2, 3])).toBe(2); // odd count -> middle element
  });

  it("returns null for empty input", () => {
    expect(meanReturn([])).toBeNull();
    expect(medianReturn([])).toBeNull();
  });
});

describe("maxDrawdown", () => {
  it("matches a hand-computed peak-to-trough sequence", () => {
    // equity path: 1 -> 1.20 (peak) -> 1.08 -> 0.972 (trough, -19% off peak) -> 1.0206
    const occurrences: Occurrence[] = [
      { t: 1, verdict: "bullish", forwardReturnPct: 20 },
      { t: 2, verdict: "bullish", forwardReturnPct: -10 },
      { t: 3, verdict: "bullish", forwardReturnPct: -10 },
      { t: 4, verdict: "bullish", forwardReturnPct: 5 },
    ];
    expect(maxDrawdown(occurrences)).toBeCloseTo(19, 10);
  });

  it("is order-independent of input array order (sorts by t itself)", () => {
    const chronological: Occurrence[] = [
      { t: 1, verdict: "bullish", forwardReturnPct: 20 },
      { t: 2, verdict: "bullish", forwardReturnPct: -10 },
      { t: 3, verdict: "bullish", forwardReturnPct: -10 },
      { t: 4, verdict: "bullish", forwardReturnPct: 5 },
    ];
    const shuffled = [chronological[2], chronological[0], chronological[3], chronological[1]];
    expect(maxDrawdown(shuffled)).toBeCloseTo(19, 10);
  });

  it("returns null with fewer than 2 points", () => {
    expect(maxDrawdown([{ t: 1, verdict: "bullish", forwardReturnPct: 5 }])).toBeNull();
    expect(maxDrawdown([])).toBeNull();
  });

  it("a monotonically rising equity curve has zero drawdown", () => {
    const occurrences: Occurrence[] = [
      { t: 1, verdict: "bullish", forwardReturnPct: 1 },
      { t: 2, verdict: "bullish", forwardReturnPct: 2 },
      { t: 3, verdict: "bullish", forwardReturnPct: 3 },
    ];
    expect(maxDrawdown(occurrences)).toBe(0);
  });
});

describe("confusionMatrix", () => {
  it("matches a hand-tallied 2x2 table for the bullish class", () => {
    const occurrences: Occurrence[] = [
      { t: 1, verdict: "bullish", forwardReturnPct: 2 }, // TP
      { t: 2, verdict: "bullish", forwardReturnPct: -1 }, // FP
      { t: 3, verdict: "bearish", forwardReturnPct: 3 }, // FN (missed a real up-move)
      { t: 4, verdict: "neutral", forwardReturnPct: 1 }, // FN (missed a real up-move)
      { t: 5, verdict: "bearish", forwardReturnPct: -2 }, // TN
      { t: 6, verdict: "neutral", forwardReturnPct: -1 }, // TN
    ];
    const matrix = confusionMatrix(occurrences, "bullish");
    expect(matrix.truePositives).toBe(1);
    expect(matrix.falsePositives).toBe(1);
    expect(matrix.falseNegatives).toBe(2);
    expect(matrix.trueNegatives).toBe(2);
    expect(matrix.precision).toBeCloseTo(0.5, 10);
    expect(matrix.recall).toBeCloseTo(1 / 3, 10);
  });

  it("returns null precision/recall when the denominator is zero", () => {
    const matrix = confusionMatrix(
      [{ t: 1, verdict: "bearish", forwardReturnPct: -1 }],
      "bullish"
    );
    expect(matrix.precision).toBeNull(); // no predicted-positive at all
    expect(matrix.recall).toBeNull(); // no actual-positive at all
  });
});

describe("signTestPValue", () => {
  it("a perfectly balanced 5/10 split is not significant (p should be ~1)", () => {
    // C(10,i) for i=0..10: 1,10,45,120,210,252,210,120,45,10,1 (sum 1024)
    // cdfLE(5) = cdfGE(5) = 638/1024 by symmetry -> 2*0.6230... capped at 1
    expect(signTestPValue(10, 5)).toBeCloseTo(1, 10);
  });

  it("9 wins out of 10 gives a small, real p-value (~0.0215)", () => {
    // cdfGE(9) = (C(10,9)+C(10,10))/1024 = 11/1024 = 0.0107421875; two-sided = 0.021484375
    expect(signTestPValue(10, 9)).toBeCloseTo(0.021484375, 8);
  });

  it("10 wins out of 10 gives an even smaller p-value", () => {
    // cdfGE(10) = 1/1024; two-sided = 2/1024 = 0.001953125
    expect(signTestPValue(10, 10)).toBeCloseTo(0.001953125, 8);
  });

  it("is symmetric: k wins and (n-k) wins give the same p-value", () => {
    expect(signTestPValue(20, 14)).toBeCloseTo(signTestPValue(20, 6), 10);
  });

  it("stays numerically stable at larger N (no overflow to Infinity/NaN)", () => {
    const p = signTestPValue(180, 100);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  /**
   * Regression test for a real bug: the raw-coefficient implementation
   * (C(n,k) times 0.5**n, computed directly rather than in log space)
   * silently produced NaN once real backtest sample sizes grew into the
   * thousands after the CoinGlass/Coinalyze migration — C(2704,1352)
   * overflows a double while 0.5**2704 underflows to 0, and Infinity * 0
   * is NaN. `JSON.stringify(NaN)` is `null`, which then failed `tsc`
   * against `HypothesisStat`'s non-nullable `pValue: number` — caught by
   * the type checker on real production data, not by a synthetic test
   * that happened to use a small N. N=2704 is the exact scale (basis vs
   * spot's 24h bucket) that surfaced it.
   */
  it("stays finite and correct at N in the thousands (the exact scale that broke the old implementation)", () => {
    const exactHalf = signTestPValue(2704, 1352);
    expect(Number.isFinite(exactHalf)).toBe(true);
    expect(exactHalf).toBeCloseTo(1, 10);

    const skewed = signTestPValue(2704, 1800);
    expect(Number.isFinite(skewed)).toBe(true);
    expect(skewed).toBeGreaterThan(0);
    expect(skewed).toBeLessThan(0.0001);

    // Symmetry must still hold at this scale, same property already
    // verified at N=20 above.
    expect(signTestPValue(2704, 1800)).toBeCloseTo(signTestPValue(2704, 904), 10);
  });
});

describe("testSignificance", () => {
  it("flags a 9/10 win streak as significant once N clears the minimum", () => {
    const occurrences: Occurrence[] = Array.from({ length: 10 }, (_, i) => ({
      t: i,
      verdict: "bullish" as const,
      forwardReturnPct: i < 9 ? 1 : -1,
    }));
    const result = testSignificance(occurrences, 10);
    expect(result?.n).toBe(10);
    expect(result?.wins).toBe(9);
    expect(result?.pValue).toBeCloseTo(0.021484375, 8);
    expect(result?.significant).toBe(true);
  });

  it("does not flag a 50/50 split as significant even at high N", () => {
    const occurrences: Occurrence[] = Array.from({ length: 20 }, (_, i) => ({
      t: i,
      verdict: "bullish" as const,
      forwardReturnPct: i < 10 ? 1 : -1,
    }));
    const result = testSignificance(occurrences, 10);
    expect(result?.significant).toBe(false);
  });

  it("withholds significance below the minimum sample size even with a perfect record", () => {
    const occurrences: Occurrence[] = Array.from({ length: 5 }, (_, i) => ({
      t: i,
      verdict: "bullish" as const,
      forwardReturnPct: 1,
    }));
    const result = testSignificance(occurrences, 10);
    expect(result?.n).toBe(5);
    expect(result?.significant).toBe(false); // p-value alone would be tiny, but N=5 < MIN_SAMPLE_N
  });

  it("returns null with no scoreable occurrences", () => {
    expect(testSignificance([{ t: 1, verdict: "neutral", forwardReturnPct: 1 }], 10)).toBeNull();
  });
});

describe("assetsPerDay / blockLengthFor", () => {
  /*
   * These decide how much independent evidence every published sample-size
   * label claims. Getting them too SMALL overstates the evidence, which is
   * the direction that flatters results — so the cases below pin the
   * behaviour rather than trusting a literal.
   */
  it("counts distinct assets, not rows", () => {
    const records = [
      { asset: "BTC" },
      { asset: "ETH" },
      { asset: "BTC" },
      { asset: "ETH" },
      { asset: "BTC" },
    ];
    expect(assetsPerDay(records)).toBe(2);
  });

  it("grows when the replay universe grows — the case a hardcoded 2 got wrong", () => {
    expect(assetsPerDay([{ asset: "BTC" }, { asset: "ETH" }, { asset: "SOL" }])).toBe(3);
  });

  it("never returns 0, which would divide the effective sample by nothing", () => {
    expect(assetsPerDay([])).toBe(1);
    expect(blockLengthFor("24h", 0)).toBe(1);
  });

  it("treats 1h/4h/24h as non-overlapping in time — cross-sectional dependence only", () => {
    // A 24h window sampled daily ends exactly where the next begins, so the
    // block is just the number of correlated assets sharing that day.
    expect(blockLengthFor("1h", 2)).toBe(2);
    expect(blockLengthFor("4h", 2)).toBe(2);
    expect(blockLengthFor("24h", 2)).toBe(2);
  });

  it("treats 7d as overlapping BOTH ways — seven days x the asset count", () => {
    expect(blockLengthFor("7d", 2)).toBe(14);
    expect(blockLengthFor("7d", 3)).toBe(21);
  });
});
