import { describe, it, expect } from "vitest";
import {
  deriveSampleSizeLabel,
  deriveConfidenceLabel,
  lookupMetricPerformance,
  MIN_SAMPLE_N,
  BacktestMetricStats,
  MetricPerformanceSummary,
} from "./backtestStats";

describe("deriveSampleSizeLabel", () => {
  it("boundary: n just below 200 is Small, n at 200 is Medium", () => {
    expect(deriveSampleSizeLabel(199)).toBe("Small");
    expect(deriveSampleSizeLabel(200)).toBe("Medium");
  });

  it("boundary: n just below 1000 is Medium, n at 1000 is Large", () => {
    expect(deriveSampleSizeLabel(999)).toBe("Medium");
    expect(deriveSampleSizeLabel(1000)).toBe("Large");
  });

  it("classifies the floor and a very large sample correctly", () => {
    expect(deriveSampleSizeLabel(MIN_SAMPLE_N)).toBe("Small");
    expect(deriveSampleSizeLabel(2704)).toBe("Large");
  });
});

describe("deriveConfidenceLabel", () => {
  it("only reaches High when Large AND significant", () => {
    expect(deriveConfidenceLabel("Large", true)).toBe("High");
    expect(deriveConfidenceLabel("Large", false)).toBe("Medium");
  });

  it("a Medium sample only reaches Medium confidence when significant", () => {
    expect(deriveConfidenceLabel("Medium", true)).toBe("Medium");
    expect(deriveConfidenceLabel("Medium", false)).toBe("Low");
  });

  it("a Small sample is always Low, even if significant", () => {
    // Real case this guards against: `funding` has n=33 (Small) but IS
    // statistically significant — significance alone must not buy a thin
    // sample a higher confidence label.
    expect(deriveConfidenceLabel("Small", true)).toBe("Low");
    expect(deriveConfidenceLabel("Small", false)).toBe("Low");
  });
});

describe("lookupMetricPerformance", () => {
  const summary = (overrides: Partial<MetricPerformanceSummary> = {}): MetricPerformanceSummary => ({
    metricId: "x",
    label: "X",
    hasHistoricalSource: true,
    n24h: 500,
    effectiveN24h: 250,
    baseRate24h: 0.53,
    winRate24h: 0.6,
    winRate7d: 0.55,
    significant24h: true,
    bestRegime: null,
    worstRegime: null,
    bestHoldingPeriod: null,
    worstHoldingPeriod: null,
    sampleSizeLabel: "Medium",
    confidenceLabel: "Medium",
    stableAcrossWindows: null,
    ...overrides,
  });

  const stats = (metrics: Record<string, MetricPerformanceSummary>): BacktestMetricStats => ({
    generatedAt: 0,
    coverageStart: "2022-01-01",
    coverageEnd: "2026-01-01",
    metrics,
    agreementBuckets: [],
  });

  it("returns the stat when n clears MIN_SAMPLE_N and a historical source exists", () => {
    const s = stats({ x: summary({ n24h: MIN_SAMPLE_N }) });
    expect(lookupMetricPerformance(s, "x")).not.toBeNull();
  });

  it("returns null when n is one below MIN_SAMPLE_N, even with every other field populated", () => {
    const s = stats({ x: summary({ n24h: MIN_SAMPLE_N - 1 }) });
    expect(lookupMetricPerformance(s, "x")).toBeNull();
  });

  it("returns null when hasHistoricalSource is false, regardless of n24h", () => {
    const s = stats({ x: summary({ hasHistoricalSource: false, n24h: 500 }) });
    expect(lookupMetricPerformance(s, "x")).toBeNull();
  });

  it("returns null when n24h is null (no headline computed at all)", () => {
    const s = stats({ x: summary({ n24h: null }) });
    expect(lookupMetricPerformance(s, "x")).toBeNull();
  });

  it("returns null for a metric id absent from the stats file", () => {
    const s = stats({});
    expect(lookupMetricPerformance(s, "spotCvd")).toBeNull();
  });
});
