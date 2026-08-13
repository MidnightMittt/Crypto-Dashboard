import { describe, expect, it } from "vitest";
import { computeStability, agreementValidationSection, DayRecord } from "./report";
import { HypothesisStat, MIN_SAMPLE_N, RollingWindowStats } from "../../src/lib/sentiment/backtestStats";

const CONFUSION = { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, precision: null, recall: null };

function hypStat(n: number, winRate: number | null): HypothesisStat {
  return {
    n,
    winRate,
    meanReturnPct: 0,
    medianReturnPct: 0,
    maxDrawdownPct: 0,
    bullish: CONFUSION,
    bearish: CONFUSION,
    significance: null,
  };
}

function windowWithFundingStat(n: number, winRate: number | null): RollingWindowStats {
  return {
    windowStart: "2022-01-01",
    windowEnd: "2023-01-01",
    squeeze: {},
    thesis: {},
    categories: {},
    biasVerdict: {},
    hypotheses: { "funding:24h": hypStat(n, winRate) },
  };
}

describe("computeStability", () => {
  it("returns null when there are no rolling windows at all", () => {
    expect(computeStability(undefined, "funding", 0.3)).toBeNull();
  });

  it("returns null when the headline win rate itself is null", () => {
    const windows = { w1: windowWithFundingStat(50, 0.3) };
    expect(computeStability(windows, "funding", null)).toBeNull();
  });

  it("returns null when fewer than 3 windows have enough of their own sample to judge", () => {
    // Hand-verified real case: funding's own headline win rate is below 50%
    // (bearish direction), and only 2 windows clear MIN_SAMPLE_N here.
    const windows = {
      w1: windowWithFundingStat(15, 0.2),
      w2: windowWithFundingStat(20, 0.25),
      w3: windowWithFundingStat(5, 0.1), // below MIN_SAMPLE_N, doesn't count
    };
    expect(computeStability(windows, "funding", 0.3)).toBeNull();
  });

  it("returns true when a clear majority of qualifying windows agree with the headline direction", () => {
    // Headline win rate 0.30 -> direction "below 50%". 4 windows qualify
    // (n >= MIN_SAMPLE_N), all 4 also read below 50% -> 4/4 = 1.0 >= 2/3.
    const windows = {
      w1: windowWithFundingStat(13, 0.23),
      w2: windowWithFundingStat(28, 0.32),
      w3: windowWithFundingStat(29, 0.31),
      w4: windowWithFundingStat(20, 0.35),
      w5: windowWithFundingStat(1, 0), // below MIN_SAMPLE_N, excluded
      w6: windowWithFundingStat(0, null), // no data, excluded
    };
    expect(computeStability(windows, "funding", 0.30303030303030304)).toBe(true);
  });

  it("returns false when qualifying windows disagree with the headline direction more than 1/3 of the time", () => {
    // Headline direction "above 50%". Of 3 qualifying windows, only 1 agrees
    // (1/3 < 2/3 threshold).
    const windows = {
      w1: windowWithFundingStat(15, 0.6), // agrees (above 50%)
      w2: windowWithFundingStat(20, 0.4), // disagrees
      w3: windowWithFundingStat(30, 0.45), // disagrees
    };
    expect(computeStability(windows, "funding", 0.6)).toBe(false);
  });

  it("ignores a window whose own winRate is null even if n clears MIN_SAMPLE_N", () => {
    const windows = {
      w1: windowWithFundingStat(15, null),
      w2: windowWithFundingStat(20, 0.3),
      w3: windowWithFundingStat(30, 0.3),
    };
    // Only 2 windows have a usable winRate -> below the 3-window floor.
    expect(computeStability(windows, "funding", 0.3)).toBeNull();
  });

  it("exercises the exact real boundary this function is built around (MIN_SAMPLE_N itself)", () => {
    const windows = {
      w1: windowWithFundingStat(MIN_SAMPLE_N, 0.3),
      w2: windowWithFundingStat(MIN_SAMPLE_N - 1, 0.9), // excluded, one below floor
      w3: windowWithFundingStat(MIN_SAMPLE_N, 0.3),
      w4: windowWithFundingStat(MIN_SAMPLE_N, 0.3),
    };
    // 3 qualifying windows (w1, w3, w4), all agree -> stable.
    expect(computeStability(windows, "funding", 0.3)).toBe(true);
  });
});

function dayRecord(overrides: Partial<DayRecord> = {}): DayRecord {
  return {
    asset: "BTC",
    date: "2024-01-01",
    t: 0,
    squeezeScore: null,
    squeezeSide: null,
    thesisRegime: null,
    biasVerdict: null,
    biasScore: null,
    biasConfidence: null,
    biasAgreement: null,
    categories: [],
    metrics: [],
    regimeTags: [],
    forwardReturn1h: null,
    forwardReturn4h: null,
    forwardReturn1d: null,
    forwardReturn3d: null,
    forwardReturn7d: null,
    ...overrides,
  };
}

describe("agreementValidationSection", () => {
  it("reports insufficient data below MIN_SAMPLE_N without fabricating a win rate", () => {
    const records = Array.from({ length: MIN_SAMPLE_N - 1 }, (_, i) =>
      dayRecord({ biasAgreement: 10, biasVerdict: "bullish", forwardReturn1d: 1 })
    );
    const { stats } = agreementValidationSection(records);
    const bucket = stats.find((s) => s.bucketLabel === "0-25%")!;
    expect(bucket.n).toBe(MIN_SAMPLE_N - 1);
    expect(bucket.winRate).toBeNull();
    expect(bucket.meanReturnPct).toBeNull();
  });

  it("computes a real win rate once N clears the floor, hand-verified", () => {
    // 7 bullish-and-correct (return > 0), 3 bullish-and-wrong (return < 0) —
    // exactly 10 days, all agreement=80 (75-100% bucket) -> winRate 0.7.
    const wins = Array.from({ length: 7 }, () => dayRecord({ biasAgreement: 80, biasVerdict: "bullish", forwardReturn1d: 1 }));
    const losses = Array.from({ length: 3 }, () => dayRecord({ biasAgreement: 80, biasVerdict: "bullish", forwardReturn1d: -1 }));
    const { stats } = agreementValidationSection([...wins, ...losses]);
    const bucket = stats.find((s) => s.bucketLabel === "75-100%")!;
    expect(bucket.n).toBe(10);
    expect(bucket.winRate).toBeCloseTo(0.7, 5);
  });

  it("sorts days into the correct quartile at the exact boundary values", () => {
    // a=24.999 -> 0-25%; a=25 -> 25-50%; a=49.999 -> 25-50%; a=50 -> 50-75%;
    // a=74.999 -> 50-75%; a=75 -> 75-100%. One day per bucket, well below
    // MIN_SAMPLE_N, so this only checks bucketing (via `n`), not win rate.
    const records = [
      dayRecord({ biasAgreement: 24.999, biasVerdict: "bullish", forwardReturn1d: 1 }),
      dayRecord({ biasAgreement: 25, biasVerdict: "bullish", forwardReturn1d: 1 }),
      dayRecord({ biasAgreement: 49.999, biasVerdict: "bullish", forwardReturn1d: 1 }),
      dayRecord({ biasAgreement: 50, biasVerdict: "bullish", forwardReturn1d: 1 }),
      dayRecord({ biasAgreement: 74.999, biasVerdict: "bullish", forwardReturn1d: 1 }),
      dayRecord({ biasAgreement: 75, biasVerdict: "bullish", forwardReturn1d: 1 }),
    ];
    const { stats } = agreementValidationSection(records);
    expect(stats.find((s) => s.bucketLabel === "0-25%")!.n).toBe(1);
    expect(stats.find((s) => s.bucketLabel === "25-50%")!.n).toBe(2);
    expect(stats.find((s) => s.bucketLabel === "50-75%")!.n).toBe(2);
    expect(stats.find((s) => s.bucketLabel === "75-100%")!.n).toBe(1);
  });

  it("excludes days with null agreement or null verdict from every bucket", () => {
    const records = [
      dayRecord({ biasAgreement: null, biasVerdict: "bullish" }),
      dayRecord({ biasAgreement: 10, biasVerdict: null }),
    ];
    const { stats } = agreementValidationSection(records);
    expect(stats.every((s) => s.n === 0)).toBe(true);
  });
});
