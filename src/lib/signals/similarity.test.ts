import { describe, expect, it } from "vitest";
import { fingerprintDistance, findSimilarSetups, metricAgreementCount, DayFingerprint } from "./similarity";

// "a", "b", "c", "d" and "customX" aren't real metric ids from scoring.ts's
// METRIC_WEIGHTS, so metricWeight falls back to 0.05 for all of them —
// deliberately, so every test below reduces to hand-computable arithmetic
// (equal weights) rather than depending on the real weight table's exact
// numbers.

function fp(overrides: Partial<DayFingerprint>): DayFingerprint {
  return {
    asset: "BTC",
    date: "2024-01-01",
    metricVerdicts: { a: 1, b: 1, c: -1, d: 0 },
    regimeTags: ["bull", "high-vol"],
    forwardReturn1d: null,
    forwardReturn7d: null,
    ...overrides,
  };
}

describe("fingerprintDistance", () => {
  it("is 0 for identical fingerprints", () => {
    const x = fp({ date: "2024-01-01" });
    const y = fp({ date: "2024-01-02" });
    expect(fingerprintDistance(x, y)).toBe(0);
  });

  it("weights a single metric mismatch as 1 of 4 equally-weighted metrics, same regime", () => {
    const x = fp({ metricVerdicts: { a: 1, b: 1, c: -1, d: 0 } });
    const y = fp({ metricVerdicts: { a: 1, b: 1, c: -1, d: 1 } }); // only d differs
    // 4 metrics, all fallback weight 0.05 -> mismatchWeight 0.05 / totalWeight 0.20 = 0.25
    expect(fingerprintDistance(x, y)).toBeCloseTo(0.25, 10);
  });

  it("scores completely disjoint regime tags at the full 0.3 regime weight when metrics match", () => {
    const x = fp({ regimeTags: ["bull", "high-vol"] });
    const y = fp({ regimeTags: ["bear", "low-vol"] });
    // union size 4, intersection 0 -> regime mismatch fraction 1 -> 0 + 0.3*1
    expect(fingerprintDistance(x, y)).toBeCloseTo(0.3, 10);
  });

  it("scores partially-overlapping regime tags proportionally", () => {
    const x = fp({ regimeTags: ["bull", "high-vol"] });
    const y = fp({ regimeTags: ["bull", "low-vol"] });
    // union {bull, high-vol, low-vol} = 3, intersection {bull} = 1 -> mismatch 2/3
    expect(fingerprintDistance(x, y)).toBeCloseTo(0.3 * (2 / 3), 10);
  });

  it("combines a metric mismatch and a regime mismatch additively", () => {
    const x = fp({ metricVerdicts: { a: 1, b: 1, c: -1, d: 0 }, regimeTags: ["bull", "high-vol"] });
    const y = fp({ metricVerdicts: { a: 1, b: 1, c: -1, d: 1 }, regimeTags: ["bear", "high-vol"] });
    // metric: 0.25 (as above). regime: union {bull,bear,high-vol}=3, intersection {high-vol}=1 -> 2/3 -> 0.3*2/3
    expect(fingerprintDistance(x, y)).toBeCloseTo(0.25 + 0.3 * (2 / 3), 10);
  });

  it("only compares metrics present on BOTH days, ignoring the rest", () => {
    const x = fp({ metricVerdicts: { a: 1, x: 1 } });
    const y = fp({ metricVerdicts: { a: 1, z: -1 } });
    // only "a" is shared and it matches -> metric distance 0, same regime tags -> 0
    expect(fingerprintDistance(x, y)).toBe(0);
  });

  it("weights a mismatch on a shared metric by that metric's real weight, not the unmatched ones", () => {
    const x = fp({ metricVerdicts: { a: 1, only_x: 1 } });
    const y = fp({ metricVerdicts: { a: -1, only_y: 1 } });
    // only "a" is shared, and it mismatches -> mismatchWeight = totalWeight -> fraction 1
    expect(fingerprintDistance(x, y)).toBeCloseTo(1, 10);
  });

  it("weights a real metric id's mismatch by its actual scoring.ts weight, not the fallback", () => {
    const x = fp({ metricVerdicts: { funding: 1, customX: 1 } });
    const y = fp({ metricVerdicts: { funding: -1, customX: 1 } });
    // funding weight 0.15 (real), customX fallback 0.05 -> total 0.20, funding mismatches -> 0.15/0.20 = 0.75
    expect(fingerprintDistance(x, y)).toBeCloseTo(0.75, 10);
  });

  it("returns Infinity when the two days share no metric at all", () => {
    const x = fp({ metricVerdicts: { a: 1 } });
    const y = fp({ metricVerdicts: { b: 1 } });
    expect(fingerprintDistance(x, y)).toBe(Infinity);
  });
});

describe("findSimilarSetups", () => {
  const target = fp({ date: "2024-06-01", metricVerdicts: { a: 1, b: 1, c: -1, d: 0 }, regimeTags: ["bull", "high-vol"] });

  // minDaysGap is passed as 0 in most cases below so these tests isolate
  // k/maxDistance/self-exclusion/asset-exclusion behavior independently of
  // the date-gap floor, which has its own dedicated tests further down.

  it("returns the k closest days sorted by ascending distance", () => {
    const history: DayFingerprint[] = [
      fp({ date: "2024-01-02", metricVerdicts: { a: -1, b: -1, c: 1, d: 1 } }), // all 4 differ -> distance 1
      fp({ date: "2024-01-03", metricVerdicts: { a: 1, b: 1, c: -1, d: 1 } }), // 1 of 4 differs -> 0.25
      fp({ date: "2024-01-04", metricVerdicts: { a: 1, b: -1, c: -1, d: 1 } }), // 2 of 4 differ -> 0.5
    ];
    const result = findSimilarSetups(target, history, 2, 10, 0);
    expect(result.map((r) => r.day.date)).toEqual(["2024-01-03", "2024-01-04"]);
    expect(result[0].distance).toBeCloseTo(0.25, 10);
    expect(result[1].distance).toBeCloseTo(0.5, 10);
  });

  it("excludes matches beyond maxDistance even if that leaves fewer than k results", () => {
    const history: DayFingerprint[] = [
      fp({ date: "2024-01-05", metricVerdicts: { a: 1, b: 1, c: -1, d: 1 } }), // 0.25
      fp({ date: "2024-01-02", metricVerdicts: { a: -1, b: -1, c: 1, d: 1 } }), // 1.0
    ];
    const result = findSimilarSetups(target, history, 5, 0.5, 0);
    expect(result.map((r) => r.day.date)).toEqual(["2024-01-05"]);
  });

  it("never matches a day against itself, even if present in history with distance 0", () => {
    const history: DayFingerprint[] = [
      fp({ date: target.date, metricVerdicts: target.metricVerdicts, regimeTags: target.regimeTags }),
      fp({ date: "2024-01-06", metricVerdicts: { a: 1, b: 1, c: -1, d: 1 } }), // 0.25
    ];
    const result = findSimilarSetups(target, history, 5, 10, 0);
    expect(result.map((r) => r.day.date)).toEqual(["2024-01-06"]);
  });

  it("returns an empty array, not a fabricated match, when nothing clears maxDistance", () => {
    const history: DayFingerprint[] = [fp({ date: "2024-01-02", metricVerdicts: { a: -1, b: -1, c: 1, d: 1 } })];
    const result = findSimilarSetups(target, history, 5, 0.1, 0);
    expect(result).toEqual([]);
  });

  it("never matches across assets, even with an identical fingerprint", () => {
    const history: DayFingerprint[] = [
      fp({ asset: "ETH", date: "2024-01-07", metricVerdicts: target.metricVerdicts, regimeTags: target.regimeTags }),
      fp({ asset: "BTC", date: "2024-01-08", metricVerdicts: { a: 1, b: 1, c: -1, d: 1 } }), // 0.25
    ];
    const result = findSimilarSetups(target, history, 5, 10, 0);
    expect(result.map((r) => r.day.date)).toEqual(["2024-01-08"]);
  });

  it("excludes days within the default 20-day gap, even at distance 0", () => {
    const recentTarget = fp({ date: "2024-06-01", metricVerdicts: { a: 1, b: 1, c: -1, d: 0 } });
    const history: DayFingerprint[] = [
      fp({ date: "2024-05-20", metricVerdicts: recentTarget.metricVerdicts }), // 12 days back -> excluded
      fp({ date: "2024-01-01", metricVerdicts: recentTarget.metricVerdicts }), // ~152 days back -> included
    ];
    const result = findSimilarSetups(recentTarget, history, 5, 10); // default minDaysGap
    expect(result.map((r) => r.day.date)).toEqual(["2024-01-01"]);
  });

  it("includes a day exactly at the minDaysGap boundary", () => {
    const boundaryTarget = fp({ date: "2024-06-20", metricVerdicts: { a: 1, b: 1, c: -1, d: 0 } });
    const history: DayFingerprint[] = [
      fp({ date: "2024-05-31", metricVerdicts: boundaryTarget.metricVerdicts }), // exactly 20 days back
    ];
    const result = findSimilarSetups(boundaryTarget, history, 5, 10, 20);
    expect(result.map((r) => r.day.date)).toEqual(["2024-05-31"]);
  });
});

describe("metricAgreementCount", () => {
  it("counts matches only among shared metric ids", () => {
    const a = { funding: 1 as const, openInterest: -1 as const, basis: 0 as const };
    const b = { funding: 1 as const, openInterest: 1 as const, longShort: 0 as const };
    // shared: funding (match), openInterest (mismatch). basis/longShort not shared -> excluded.
    expect(metricAgreementCount(a, b)).toEqual({ matched: 1, total: 2 });
  });

  it("reports full agreement when every shared metric matches", () => {
    const a = { funding: 1 as const, openInterest: -1 as const };
    const b = { funding: 1 as const, openInterest: -1 as const };
    expect(metricAgreementCount(a, b)).toEqual({ matched: 2, total: 2 });
  });

  it("returns 0/0 with no shared metrics", () => {
    expect(metricAgreementCount({ a: 1 }, { b: 1 })).toEqual({ matched: 0, total: 0 });
  });
});
