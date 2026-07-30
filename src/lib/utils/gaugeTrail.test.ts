import { describe, it, expect } from "vitest";
import { gaugeTrail } from "./gaugeTrail";
import { LocalHistoryPoint } from "@/types/market";

const HOUR = 3_600_000;

function point(overrides: Partial<LocalHistoryPoint> & { t: number }): LocalHistoryPoint {
  return {
    totalOpenInterestUsd: 1,
    weightedFundingRatePct: 0,
    price: 1,
    longShortRatio: null,
    venueCount: 1,
    ...overrides,
  };
}

describe("gaugeTrail", () => {
  it("returns empty for an empty history array", () => {
    const result = gaugeTrail([], (p) => p.weightedFundingRatePct);
    expect(result.values).toEqual([]);
    expect(result.valueAgo).toBeNull();
  });

  it("returns empty when only a single usable point exists (a dot is not a trend)", () => {
    const result = gaugeTrail([point({ t: Date.now(), weightedFundingRatePct: 0.01 })], (p) =>
      p.weightedFundingRatePct
    );
    expect(result.values).toEqual([]);
  });

  it("skips points where the picked metric is null, rather than treating them as zero", () => {
    const now = Date.now();
    const history: LocalHistoryPoint[] = [
      point({ t: now - 3 * HOUR, longShortRatio: null }),
      point({ t: now - 2 * HOUR, longShortRatio: 1.5 }),
      point({ t: now - 1 * HOUR, longShortRatio: null }),
      point({ t: now, longShortRatio: 1.8 }),
    ];
    const result = gaugeTrail(history, (p) => p.longShortRatio);
    // Only the two non-null points should appear - a false "cliff" to 0
    // would be visually misleading on a ratio gauge.
    expect(result.values).toEqual([1.5, 1.8]);
  });

  it("skips points where the metric is entirely absent (undefined) - the case for points recorded before a field existed", () => {
    const now = Date.now();
    // Simulates history recorded before oiPercentile/leverageHeatScore were
    // added to LocalHistoryPoint - the field is simply not present.
    const history: LocalHistoryPoint[] = [
      point({ t: now - 2 * HOUR }), // no oiPercentile key at all
      point({ t: now - 1 * HOUR, oiPercentile: 60 }),
      point({ t: now, oiPercentile: 70 }),
    ];
    const result = gaugeTrail(history, (p) => p.oiPercentile);
    expect(result.values).toEqual([60, 70]);
  });

  it("excludes NaN and non-finite values defensively", () => {
    const now = Date.now();
    const history: LocalHistoryPoint[] = [
      point({ t: now - 2 * HOUR, weightedFundingRatePct: NaN }),
      point({ t: now - 1 * HOUR, weightedFundingRatePct: 0.01 }),
      point({ t: now, weightedFundingRatePct: 0.02 }),
    ];
    const result = gaugeTrail(history, (p) => p.weightedFundingRatePct);
    expect(result.values).toEqual([0.01, 0.02]);
  });

  it("caps the returned trail at maxPoints, keeping the MOST RECENT values", () => {
    const now = Date.now();
    const history: LocalHistoryPoint[] = Array.from({ length: 100 }, (_, i) =>
      point({ t: now - (100 - i) * HOUR, weightedFundingRatePct: i })
    );
    const result = gaugeTrail(history, (p) => p.weightedFundingRatePct, 10);
    expect(result.values).toHaveLength(10);
    // Last 10 values of 0..99 are 90..99.
    expect(result.values).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });

  it("returns null valueAgo when no point is at least ~20h old", () => {
    const now = Date.now();
    const history: LocalHistoryPoint[] = [
      point({ t: now - 2 * HOUR, weightedFundingRatePct: 0.01 }),
      point({ t: now - 1 * HOUR, weightedFundingRatePct: 0.02 }),
    ];
    const result = gaugeTrail(history, (p) => p.weightedFundingRatePct);
    expect(result.valueAgo).toBeNull();
  });

  it("picks the point closest to 24h ago as valueAgo, once history reaches back that far", () => {
    const now = Date.now();
    const history: LocalHistoryPoint[] = [
      point({ t: now - 25 * HOUR, weightedFundingRatePct: 0.05 }), // closest to 24h
      point({ t: now - 22 * HOUR, weightedFundingRatePct: 0.03 }),
      point({ t: now - 1 * HOUR, weightedFundingRatePct: 0.09 }),
    ];
    const result = gaugeTrail(history, (p) => p.weightedFundingRatePct);
    expect(result.valueAgo).toBe(0.05);
  });

  it("does not treat a point at exactly 19h old as '24h ago' (respects the MIN_AGE_MS floor)", () => {
    const now = Date.now();
    const history: LocalHistoryPoint[] = [
      point({ t: now - 19 * HOUR, weightedFundingRatePct: 0.05 }), // too recent to count
      point({ t: now - 1 * HOUR, weightedFundingRatePct: 0.09 }),
    ];
    const result = gaugeTrail(history, (p) => p.weightedFundingRatePct);
    expect(result.valueAgo).toBeNull();
  });
});
