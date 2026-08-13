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
  directionalBaseRates,
  poissonBinomialPmf,
  poissonBinomialPValue,
  testSignificanceVsNull,
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

describe("drift-adjusted nulls", () => {
  /*
   * The correction that re-decides the census (design doc H1). Every case
   * hand-computed: an error here silently re-labels which signals the
   * platform believes in.
   */
  const occ = (verdict: "bullish" | "bearish", ret: number, asset = "BTC") =>
    ({ t: 0, verdict, forwardReturnPct: ret, asset }) as const;

  describe("directionalBaseRates", () => {
    it("counts strict inequalities, so ties belong to neither side — matching winRate's tie-is-loss rule", () => {
      // 3 up, 1 down, 1 exactly zero.
      const r = directionalBaseRates([1, 2, 3, -1, 0])!;
      expect(r.up).toBeCloseTo(3 / 5, 12);
      expect(r.down).toBeCloseTo(1 / 5, 12);
      expect(r.up + r.down).toBeLessThan(1); // the zero belongs to neither
      expect(r.n).toBe(5);
    });

    it("returns null on empty input — no data is not a 50/50 market", () => {
      expect(directionalBaseRates([])).toBeNull();
    });
  });

  describe("poissonBinomialPmf", () => {
    it("hand-computed heterogeneous case: p = [0.5, 0.8]", () => {
      // P(0) = .5*.2 = .10 ; P(1) = .5*.8 + .5*.2 = .50 ; P(2) = .5*.8 = .40
      const pmf = poissonBinomialPmf([0.5, 0.8]);
      expect(pmf[0]).toBeCloseTo(0.1, 12);
      expect(pmf[1]).toBeCloseTo(0.5, 12);
      expect(pmf[2]).toBeCloseTo(0.4, 12);
    });

    it("sums to 1 at census scale (n=2706, mixed probs)", () => {
      const probs = Array.from({ length: 2706 }, (_, i) => 0.45 + 0.1 * ((i % 10) / 10));
      const total = poissonBinomialPmf(probs).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 9);
    });
  });

  describe("poissonBinomialPValue", () => {
    it("is numerically identical to signTestPValue when every null is 0.5", () => {
      // The two columns in the report must differ ONLY in the null.
      for (const [n, wins] of [
        [10, 7],
        [100, 60],
        [500, 240],
      ] as const) {
        const probs = new Array(n).fill(0.5);
        expect(poissonBinomialPValue(probs, wins)).toBeCloseTo(signTestPValue(n, wins), 10);
      }
    });

    it("the same win count is significant against 50% and NOT against a drifted null", () => {
      // 60/100 wins: p≈0.057 vs fair coin, but if the tape's base rate was
      // 58% up, 60 wins is nothing. This asymmetry is the whole point.
      const vsFair = poissonBinomialPValue(new Array(100).fill(0.5), 60);
      const vsDrift = poissonBinomialPValue(new Array(100).fill(0.58), 60);
      expect(vsFair).toBeLessThan(0.06);
      expect(vsDrift).toBeGreaterThan(0.6);
    });
  });

  describe("testSignificanceVsNull", () => {
    const rates: Record<string, { up: number; down: number }> = {
      BTC: { up: 0.6, down: 0.38 },
      ETH: { up: 0.52, down: 0.46 },
    };
    const nullFor = (o: { verdict: string; asset?: string }) => {
      const r = rates[o.asset ?? "BTC"];
      return o.verdict === "bullish" ? r.up : r.down;
    };

    it("hand-computed: null win rate is the exposure-weighted mean of per-occurrence nulls", () => {
      const occurrences = [
        occ("bullish", 1, "BTC"), // null .60, win
        occ("bullish", -1, "ETH"), // null .52, loss
        occ("bearish", -1, "BTC"), // null .38, win
        occ("bearish", 1, "ETH"), // null .46, loss
      ];
      const out = testSignificanceVsNull(occurrences, nullFor, 1)!;
      expect(out.n).toBe(4);
      expect(out.wins).toBe(2);
      expect(out.nullWinRate).toBeCloseTo((0.6 + 0.52 + 0.38 + 0.46) / 4, 12);
      expect(out.edgeVsNull).toBeCloseTo(0.5 - 0.49, 12);
    });

    it("a bearish signal beating its own hostile base rate is rewarded, not punished", () => {
      // 50 bearish wins of 100 on a tape where down-days run 38%: far above
      // blind shorting. The fair-coin test calls this nothing (p=1); the
      // drift test calls it real.
      const occurrences = Array.from({ length: 100 }, (_, i) => occ("bearish", i < 50 ? -1 : 1, "BTC"));
      const out = testSignificanceVsNull(occurrences, nullFor, 30)!;
      expect(out.nullWinRate).toBeCloseTo(0.38, 12);
      expect(out.edgeVsNull).toBeCloseTo(0.12, 12);
      expect(out.pValue).toBeLessThan(0.05);
      expect(signTestPValue(100, 50)).toBeGreaterThan(0.9); // the old test shrugs
    });

    it("applies the same tie-is-loss and neutral-exclusion rules as winRate", () => {
      const occurrences = [occ("bullish", 0, "BTC"), { t: 0, verdict: "neutral", forwardReturnPct: 5 } as const];
      const out = testSignificanceVsNull(occurrences, nullFor, 1)!;
      expect(out.n).toBe(1); // neutral excluded
      expect(out.wins).toBe(0); // zero return = loss
    });
  });
});
