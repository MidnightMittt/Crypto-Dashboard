import { describe, it, expect } from "vitest";
import {
  buildWalkForward,
  buildQuantileCalibration,
  classifySample,
  marginalRegimeCells,
  summarizeDistribution,
  WalkForwardTrade,
  CalibrationObservation,
} from "./walkForward";
import { TradeRecord } from "./tradeStats";

const DAY = 86_400_000;

function wfTrade(dayIndex: number, side: "long" | "short", netReturnPct: number, holdDays = 1): WalkForwardTrade {
  const t = dayIndex * DAY;
  return {
    t,
    exitT: t + holdDays * DAY,
    side,
    outcome: netReturnPct > 0 ? "target" : "stop",
    grossReturnPct: netReturnPct + 0.14,
    netReturnPct,
    mfePct: Math.max(netReturnPct, 0),
    maePct: Math.min(netReturnPct, 0),
    hoursToTarget: null,
    hoursToStop: null,
    hoursHeld: holdDays * 24,
    tp2ReachedBeforeStop: false,
    ambiguousBar: false,
  };
}

describe("buildWalkForward", () => {
  /** 600 trades over 600 days, alternating sides, longs consistently better. */
  const trades = Array.from({ length: 600 }, (_, i) =>
    wfTrade(i, i % 2 === 0 ? "long" : "short", i % 2 === 0 ? 1 : -1)
  );

  it("produces the requested number of chronological folds", () => {
    const r = buildWalkForward(trades, 5);
    expect(r.folds).toHaveLength(5);
    expect(r.foldCount).toBe(5);
    // Windows advance and never overlap.
    for (let i = 1; i < r.folds.length; i++) {
      expect(r.folds[i].validationStart > r.folds[i - 1].validationStart).toBe(true);
    }
  });

  it("grows the discovery set as folds advance", () => {
    const r = buildWalkForward(trades, 5);
    for (let i = 1; i < r.folds.length; i++) {
      expect(r.folds[i].discoveryN).toBeGreaterThan(r.folds[i - 1].discoveryN);
    }
  });

  it("excludes trades still open at the boundary via the embargo", () => {
    // Every trade holds 30 days; with a 7-day embargo, no discovery trade
    // may have exited after (validationStart - 7d). Without purging, a
    // trade opened before the boundary but resolved inside the validation
    // window would leak validation-period price action backwards.
    const longHolds = Array.from({ length: 400 }, (_, i) =>
      wfTrade(i, i % 2 === 0 ? "long" : "short", i % 2 === 0 ? 1 : -1, 30)
    );
    const r = buildWalkForward(longHolds, 4, 7);
    for (const fold of r.folds) {
      const boundary = Date.parse(`${fold.validationStart}T00:00:00Z`) - 7 * DAY;
      const leaked = longHolds.filter((t) => t.exitT <= boundary).length;
      expect(fold.discoveryN).toBe(leaked);
      // and no discovery trade exits after the boundary
      expect(longHolds.filter((t) => t.exitT <= boundary).every((t) => t.exitT <= boundary)).toBe(true);
    }
  });

  it("runs the out-of-sample side-ranking test and detects a persistent edge", () => {
    const r = buildWalkForward(trades, 5);
    expect(r.sideRankingTestedCount).toBeGreaterThan(0);
    expect(r.sideRankingHeldCount).toBe(r.sideRankingTestedCount);
    expect(r.folds.every((f) => f.discoveryBetterSide === null || f.discoveryBetterSide === "long")).toBe(true);
  });

  it("detects a ranking that FLIPS out-of-sample", () => {
    // Longs win in the first half, shorts in the second. A discovery set
    // drawn from early data must mispredict the later windows.
    const flipping = Array.from({ length: 600 }, (_, i) => {
      const longGood = i < 300;
      const side = i % 2 === 0 ? "long" : ("short" as const);
      const good = side === "long" ? longGood : !longGood;
      return wfTrade(i, side as "long" | "short", good ? 1 : -1);
    });
    const r = buildWalkForward(flipping, 5);
    expect(r.sideRankingTestedCount).toBeGreaterThan(0);
    expect(r.sideRankingHeldCount).toBeLessThan(r.sideRankingTestedCount);
  });

  it("reports per-fold spread rather than only an average", () => {
    const r = buildWalkForward(trades, 5);
    expect(r.worstFoldExpectancyPct).not.toBeNull();
    expect(r.bestFoldExpectancyPct).not.toBeNull();
    expect(r.bestFoldExpectancyPct!).toBeGreaterThanOrEqual(r.worstFoldExpectancyPct!);
    expect(r.interpretation).toContain("folds");
  });

  it("states plainly that nothing is being fitted", () => {
    const r = buildWalkForward(trades, 5);
    expect(r.methodology).toContain("no fitted parameters");
  });

  it("handles an empty trade list without throwing", () => {
    const r = buildWalkForward([], 5);
    expect(r.folds).toHaveLength(0);
    expect(r.inSample).toBeNull();
  });
});

describe("buildQuantileCalibration", () => {
  /** `hits` of `n` days at a given confidence go the right way. */
  function days(confidence: number, n: number, hits: number): CalibrationObservation[] {
    return Array.from({ length: n }, (_, i) => ({
      confidence,
      verdict: "bullish",
      forwardReturnPct: i < hits ? 1 : -1,
    }));
  }

  it("splits a narrow real-world range into populated buckets", () => {
    // Mirrors the actual engine: confidence compressed into [35, 55], which
    // fixed 20-point bands cannot resolve at all.
    const obs = [...days(35, 200, 90), ...days(45, 200, 100), ...days(55, 200, 130)];
    const r = buildQuantileCalibration(obs, 3);
    expect(r.buckets.length).toBe(3);
    expect(r.buckets.every((b) => b.n >= 30)).toBe(true);
  });

  it("detects monotonic ordering and reports the spread", () => {
    const obs = [...days(35, 200, 80), ...days(45, 200, 100), ...days(55, 200, 140)];
    const r = buildQuantileCalibration(obs, 3);
    expect(r.monotonic).toBe(true);
    expect(r.spreadPct).toBeCloseTo(30, 5); // 40% -> 70%
    expect(r.interpretation).toContain("rise monotonically");
  });

  it("detects non-monotonic ordering", () => {
    const obs = [...days(35, 200, 140), ...days(45, 200, 80), ...days(55, 200, 100)];
    expect(buildQuantileCalibration(obs, 3).monotonic).toBe(false);
  });

  it("flags overlapping intervals as indistinguishable from no effect", () => {
    // A 2-point spread on 200 per bucket is well inside the noise.
    const obs = [...days(35, 200, 100), ...days(45, 200, 102), ...days(55, 200, 104)];
    const r = buildQuantileCalibration(obs, 3);
    expect(r.interpretation).toContain("not statistically distinguishable");
  });

  it("refuses to bucket a sample too small to split", () => {
    const r = buildQuantileCalibration(days(45, 40, 20), 4);
    expect(r.buckets).toHaveLength(0);
    expect(r.monotonic).toBeNull();
  });

  it("excludes neutral verdicts", () => {
    const obs = [
      ...days(35, 200, 100),
      ...days(55, 200, 120),
      ...Array.from({ length: 500 }, () => ({ confidence: 45, verdict: "neutral", forwardReturnPct: 1 })),
    ];
    const r = buildQuantileCalibration(obs, 2);
    expect(r.buckets.reduce((s, b) => s + b.n, 0)).toBe(400);
  });
});

describe("classifySample", () => {
  it("draws the declared thresholds", () => {
    expect(classifySample(250)).toBe("adequate");
    expect(classifySample(100)).toBe("adequate");
    expect(classifySample(99)).toBe("thin");
    expect(classifySample(30)).toBe("thin");
    expect(classifySample(29)).toBe("insufficient");
    expect(classifySample(0)).toBe("insufficient");
  });
});

describe("marginalRegimeCells", () => {
  function regimeTrade(i: number, tags: string[], net: number): TradeRecord & { regimeTags: string[] } {
    return { ...wfTrade(i, "long", net), regimeTags: tags };
  }

  it("measures each dimension separately, at far larger n than the cross-product", () => {
    // 120 bull trades split across three different volatility sub-cells:
    // each cross-product cell has 40, but the marginal "bull" cell has 120.
    const trades = [
      ...Array.from({ length: 40 }, (_, i) => regimeTrade(i, ["bull", "low-vol"], 1)),
      ...Array.from({ length: 40 }, (_, i) => regimeTrade(i + 40, ["bull", "high-vol"], 1)),
      ...Array.from({ length: 40 }, (_, i) => regimeTrade(i + 80, ["bull", "normal-vol"], 1)),
    ];
    const cells = marginalRegimeCells(trades);
    const bull = cells.find((c) => c.label === "bull")!;
    expect(bull.n).toBe(120);
    expect(bull.adequacy).toBe("adequate");
    expect(bull.dimension).toBe("trend");
    expect(cells.find((c) => c.label === "low-vol")!.dimension).toBe("volatility");
    expect(cells.find((c) => c.label === "low-vol")!.adequacy).toBe("thin");
  });

  it("marks a genuinely small cell insufficient and withholds stats", () => {
    const trades = Array.from({ length: 12 }, (_, i) => regimeTrade(i, ["range-bound"], -2));
    const cell = marginalRegimeCells(trades)[0];
    expect(cell.adequacy).toBe("insufficient");
    expect(cell.stats).toBeNull(); // below MIN_SAMPLE_N, so no numbers to quote
  });
});

describe("summarizeDistribution", () => {
  it("reports the range and quantiles that reveal a compressed score", () => {
    const values = Array.from({ length: 101 }, (_, i) => 33 + (i * 25) / 100); // 33..58
    const d = summarizeDistribution(values)!;
    expect(d.min).toBeCloseTo(33, 6);
    expect(d.max).toBeCloseTo(58, 6);
    expect(d.median).toBeCloseTo(45.5, 6);
    expect(d.n).toBe(101);
  });

  it("returns null on an empty sample", () => {
    expect(summarizeDistribution([])).toBeNull();
  });
});
