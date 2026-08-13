import { describe, it, expect } from "vitest";
import { computeTradeStats, TradeRecord } from "./tradeStats";
import {
  buildCalibration,
  CalibrationInput,
  buildScoreRegimeCalibration,
  ScoreCalibrationInput,
  scoreCellKey,
  trendRegimeOf,
} from "./calibration";
import { wilsonInterval } from "./metrics";

const DAY = 86_400_000;

function trade(i: number, netReturnPct: number, extra: Partial<TradeRecord> = {}): TradeRecord {
  return {
    t: i * DAY,
    outcome: netReturnPct > 0 ? "target" : "stop",
    grossReturnPct: netReturnPct + 0.14,
    netReturnPct,
    mfePct: Math.max(netReturnPct, 0),
    maePct: Math.min(netReturnPct, 0),
    hoursToTarget: netReturnPct > 0 ? 10 : null,
    hoursToStop: netReturnPct > 0 ? null : 5,
    hoursHeld: netReturnPct > 0 ? 10 : 5,
    tp2ReachedBeforeStop: false,
    ambiguousBar: false,
    ...extra,
  };
}

describe("wilsonInterval", () => {
  it("brackets the point estimate and stays inside [0,1]", () => {
    const r = wilsonInterval(27, 50)!;
    expect(r.point).toBeCloseTo(0.54, 10);
    expect(r.lower).toBeGreaterThan(0);
    expect(r.upper).toBeLessThan(1);
    expect(r.lower).toBeLessThan(r.point);
    expect(r.upper).toBeGreaterThan(r.point);
  });

  it("stays in bounds at the extremes where the normal approximation breaks", () => {
    // The whole reason Wilson was chosen: a normal-approximation interval
    // at 0/10 spans [0,0] and at 10/10 runs past 1.
    const none = wilsonInterval(0, 10)!;
    expect(none.lower).toBe(0);
    expect(none.upper).toBeGreaterThan(0);
    expect(none.upper).toBeLessThan(1);

    const all = wilsonInterval(10, 10)!;
    expect(all.upper).toBe(1);
    expect(all.lower).toBeLessThan(1);
    expect(all.lower).toBeGreaterThan(0);
  });

  it("narrows as the sample grows", () => {
    const small = wilsonInterval(5, 10)!;
    const large = wilsonInterval(500, 1000)!;
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });

  it("rejects impossible inputs rather than returning nonsense", () => {
    expect(wilsonInterval(5, 0)).toBeNull();
    expect(wilsonInterval(11, 10)).toBeNull();
    expect(wilsonInterval(-1, 10)).toBeNull();
  });
});

describe("computeTradeStats", () => {
  it("refuses to report on a sample too small to mean anything", () => {
    expect(computeTradeStats([trade(1, 1), trade(2, -1)])).toBeNull();
  });

  it("computes expectancy, profit factor and win rate from net returns", () => {
    // 6 wins of +2, 6 losses of -1, padded to clear MIN_SAMPLE_N.
    const trades = [
      ...Array.from({ length: 6 }, (_, i) => trade(i, 2)),
      ...Array.from({ length: 6 }, (_, i) => trade(i + 6, -1)),
    ];
    const s = computeTradeStats(trades)!;

    expect(s.n).toBe(12);
    expect(s.winRatePct).toBeCloseTo(50, 10);
    expect(s.expectancyNetPct).toBeCloseTo(0.5, 10); // (6*2 - 6*1)/12
    expect(s.avgWinPct).toBeCloseTo(2, 10);
    expect(s.avgLossPct).toBeCloseTo(-1, 10);
    expect(s.profitFactor).toBeCloseTo(2, 10); // 12 / 6
  });

  it("counts a gross win eaten by costs as a LOSS", () => {
    // The distinction the whole cost model exists to enforce.
    const trades = Array.from({ length: 12 }, (_, i) =>
      trade(i, -0.04, { grossReturnPct: 0.1, outcome: "timeout" })
    );
    const s = computeTradeStats(trades)!;
    expect(s.expectancyGrossPct).toBeCloseTo(0.1, 10);
    expect(s.expectancyNetPct).toBeCloseTo(-0.04, 10);
    expect(s.winRatePct).toBe(0);
  });

  it("computes max drawdown additively at constant size, not by compounding", () => {
    // +10 then -50 points: cumulative 0 -> 10 -> -40, peak 10, worst
    // give-back -50 POINTS. The compounded reading would be -50% of a
    // notional account, which these overlapping trades never constituted.
    const trades = [
      trade(0, 10),
      trade(1, -50),
      ...Array.from({ length: 10 }, (_, i) => trade(i + 2, 0, { outcome: "timeout" })),
    ];
    const s = computeTradeStats(trades)!;
    expect(s.maxDrawdownPct).toBeCloseTo(-50, 6);
  });

  it("does not compound its way to ruin over a long losing sequence", () => {
    // Regression against the convention this replaced. 400 trades
    // alternating +4/-4 compounds to roughly -50% through volatility drag
    // alone; additively it is a flat 0 with a -4 point worst give-back.
    const trades = Array.from({ length: 400 }, (_, i) => trade(i, i % 2 === 0 ? 4 : -4));
    const s = computeTradeStats(trades)!;
    expect(s.maxDrawdownPct).toBeCloseTo(-4, 6);
    expect(s.expectancyNetPct).toBeCloseTo(0, 6);
  });

  it("reports MFE/MAE and timing distributions", () => {
    const trades = [
      ...Array.from({ length: 6 }, (_, i) => trade(i, 2)),
      ...Array.from({ length: 6 }, (_, i) => trade(i + 6, -1)),
    ];
    const s = computeTradeStats(trades)!;

    expect(s.mfe!.median).toBeCloseTo(1, 10); // half at 2, half at 0
    expect(s.mae!.median).toBeCloseTo(-0.5, 10);
    expect(s.medianHoursToTarget).toBe(10);
    expect(s.medianHoursToStop).toBe(5);
    expect(s.targetHitRatePct).toBeCloseTo(50, 10);
    expect(s.stopHitRatePct).toBeCloseTo(50, 10);
  });

  it("surfaces the share of outcomes resting on the intrabar assumption", () => {
    const trades = Array.from({ length: 12 }, (_, i) => trade(i, 1, { ambiguousBar: i < 3 }));
    expect(computeTradeStats(trades)!.ambiguousRatePct).toBeCloseTo(25, 10);
  });

  it("returns null for ratios that are undefined rather than zero", () => {
    // All winners: no losses, so profit factor has no denominator and
    // drawdown never happens. Reporting 0 or Infinity would both be lies.
    const trades = Array.from({ length: 12 }, (_, i) => trade(i, 1));
    const s = computeTradeStats(trades)!;
    expect(s.profitFactor).toBeNull();
    expect(s.avgLossPct).toBeNull();
    expect(s.calmar).toBeNull();
  });
});

describe("buildCalibration", () => {
  /** n days in one confidence band, `hits` of which went the right way. */
  function band(confidence: number, n: number, hits: number): CalibrationInput[] {
    return Array.from({ length: n }, (_, i) => ({
      confidence,
      verdict: "bullish",
      forwardReturnPct: i < hits ? 1 : -1,
    }));
  }

  it("reports observed rate, implied rate and the gap per bucket", () => {
    // 50 days at confidence 70 (implying 70%), only 50% favourable.
    const report = buildCalibration(band(70, 50, 25), "24h");
    expect(report.buckets).toHaveLength(1);
    const b = report.buckets[0];
    expect(b.label).toBe("60-80");
    expect(b.n).toBe(50);
    expect(b.observedRatePct).toBeCloseTo(50, 10);
    expect(b.impliedRatePct).toBe(70);
    expect(b.calibrationErrorPct).toBeCloseTo(-20, 10);
  });

  it("detects monotonic improvement across bands", () => {
    const report = buildCalibration([...band(30, 40, 16), ...band(50, 40, 20), ...band(70, 40, 28)], "24h");
    expect(report.buckets).toHaveLength(3);
    expect(report.monotonic).toBe(true);
    expect(report.interpretation).toContain("did correspond to better outcomes");
  });

  it("detects NON-monotonic confidence and says so plainly", () => {
    const report = buildCalibration([...band(30, 40, 24), ...band(50, 40, 12), ...band(70, 40, 20)], "24h");
    expect(report.monotonic).toBe(false);
    expect(report.interpretation).toContain("did NOT reliably correspond");
  });

  it("refuses to call a poorly-calibrated score a probability", () => {
    const report = buildCalibration([...band(30, 40, 20), ...band(90, 40, 22)], "24h");
    expect(report.meanAbsoluteCalibrationErrorPct).toBeGreaterThan(5);
    expect(report.interpretation).toContain("NOT a probability");
  });

  it("drops buckets below the minimum sample and states the limitation", () => {
    const report = buildCalibration(band(70, 4, 3), "24h");
    expect(report.buckets).toHaveLength(0);
    expect(report.monotonic).toBeNull();
    expect(report.interpretation).toContain("should not be read as a probability");
  });

  it("excludes neutral verdicts, which have no direction to score", () => {
    const withNeutrals: CalibrationInput[] = [
      ...band(70, 40, 20),
      ...Array.from({ length: 100 }, () => ({ confidence: 70, verdict: "neutral", forwardReturnPct: 1 })),
    ];
    expect(buildCalibration(withNeutrals, "24h").buckets[0].n).toBe(40);
  });
});

describe("buildScoreRegimeCalibration", () => {
  const row = (
    score: number,
    verdict: string,
    trendRegime: "bull" | "bear" | "neutral",
    ret: number | null,
    nullProb = 0.5
  ): ScoreCalibrationInput => ({ score, verdict, trendRegime, forwardReturnPct: ret, nullProb });

  it("keys cells by direction, intensityLabel's own 15-point strength boundary, and trend regime", () => {
    expect(scoreCellKey(64, "bullish", "bull")).toBe("bullish:leaning:bull"); // |64-50|=14 < 15
    expect(scoreCellKey(65, "bullish", "bull")).toBe("bullish:clear:bull");
    expect(scoreCellKey(36, "bearish", "neutral")).toBe("bearish:leaning:neutral"); // |36-50|=14
    expect(scoreCellKey(35, "bearish", "bear")).toBe("bearish:clear:bear");
    expect(scoreCellKey(50, "neutral", "bull")).toBeNull(); // no direction, nothing to calibrate
  });

  it("computes hit rate against the direction and the drift null against exposure", () => {
    // Hand-computed: 3 bullish-leaning-bull rows, returns +1, +1, -1 → 2/3
    // hits = 66.7%. Null probs 0.6, 0.6, 0.6 → null 60%, edge +6.7pp.
    const cells = buildScoreRegimeCalibration(
      [row(60, "bullish", "bull", 1, 0.6), row(60, "bullish", "bull", 1, 0.6), row(60, "bullish", "bull", -1, 0.6)],
      1
    );
    const c = cells["bullish:leaning:bull"];
    expect(c.n).toBe(3);
    expect(c.hitRatePct).toBeCloseTo(66.667, 2);
    expect(c.nullRatePct).toBeCloseTo(60, 6);
    expect(c.edgePP).toBeCloseTo(6.667, 2);
    expect(c.calibrated).toBe(false); // 3 < MIN_SAMPLE_N — emitted, but a UI must not quote it
  });

  it("a bearish hit is a NEGATIVE forward return", () => {
    const cells = buildScoreRegimeCalibration(
      [row(30, "bearish", "bear", -2, 0.5), row(30, "bearish", "bear", 3, 0.5)],
      1
    );
    expect(cells["bearish:clear:bear"].hitRatePct).toBe(50);
  });

  it("discounts effectiveN by the block length and drops null returns", () => {
    const rows = Array.from({ length: 10 }, () => row(60, "bullish", "neutral", 1, 0.5));
    rows.push(row(60, "bullish", "neutral", null, 0.5)); // no forward return — excluded, not a hit
    const cells = buildScoreRegimeCalibration(rows, 2);
    expect(cells["bullish:leaning:neutral"].n).toBe(10);
    expect(cells["bullish:leaning:neutral"].effectiveN).toBe(5);
  });

  it("trendRegimeOf maps tags with neutral as the fallback", () => {
    expect(trendRegimeOf(["bull", "high-vol"])).toBe("bull");
    expect(trendRegimeOf(["bear", "normal-vol"])).toBe("bear");
    expect(trendRegimeOf(["low-vol", "range-bound"])).toBe("neutral");
  });
});
