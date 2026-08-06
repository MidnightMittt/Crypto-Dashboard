import { describe, it, expect } from "vitest";
import {
  buildCategoryScore,
  buildAllCategories,
  combineCategoryScores,
  buildTrendStrength,
  buildMarketHealth,
  aggregateConflicts,
  CATEGORY_WEIGHTS,
} from "./categories";
import { MetricVerdict, Verdict, CategoryScore } from "./types";
import { TechnicalRead } from "@/types/market";

const metric = (
  id: string,
  verdict: Verdict,
  confidence = 80,
  explanation = "test",
  conflicts: string[] = []
): MetricVerdict => ({
  id,
  label: id,
  verdict,
  confidence,
  confidenceBasis: "",
  explanation,
  whyItMatters: "",
  asOf: 0,
  conflicts,
  nextTrigger: null,
});

describe("buildCategoryScore", () => {
  it("returns null when the only contributing metric carries weight 0", () => {
    // liquidations folds into `positioning` but carries weight 0 by design —
    // Positioning's card reads its own volume-profile/S-R data instead, not
    // this score (see categories.ts's own doc comment). Passing ONLY
    // liquidations means zero total weight for this call, even though
    // `positioning` itself carries plenty of weight from its other members.
    expect(buildCategoryScore([metric("liquidations", "bearish")], "positioning")).toBeNull();
  });

  it("returns null when no metric belongs to the category at all", () => {
    expect(buildCategoryScore([metric("fearGreed", "bullish")], "positioning")).toBeNull();
  });

  it("scores a category from only the metrics that belong to it", () => {
    // openInterest is positioning-only; coinbasePremium is marketStructure-only — must not leak across.
    const cat = buildCategoryScore(
      [metric("openInterest", "bullish", 100), metric("coinbasePremium", "bearish", 100)],
      "positioning"
    )!;
    expect(cat.verdict).toBe("bullish");
    expect(cat.metrics.map((m) => m.id)).toEqual(["openInterest"]);
  });

  it("every metric is single-homed in the V2 taxonomy (funding no longer dual-membership)", () => {
    // The prior taxonomy deliberately dual-homed funding (leveragedPositioning
    // + marketStress). Dashboard V2 drops that: funding lives ONLY in
    // `positioning` now, and reads null for every other category.
    const metrics = [metric("funding", "bullish", 90)];
    expect(buildCategoryScore(metrics, "positioning")?.verdict).toBe("bullish");
    expect(buildCategoryScore(metrics, "marketStructure")).toBeNull();
    expect(buildCategoryScore(metrics, "leadingDrivers")).toBeNull();
    expect(buildCategoryScore(metrics, "risk")).toBeNull();
  });

  it("picks the highest weight-x-confidence metric as the top reason", () => {
    const cat = buildCategoryScore(
      [
        metric("openInterest", "bullish", 90, "weak signal"), // lighter positioning weight (0.09)
        metric("funding", "bullish", 90, "strong signal"), // heavier positioning weight (0.15)
      ],
      "positioning"
    )!;
    expect(cat.topReason).toContain("strong signal");
  });
});

describe("buildAllCategories", () => {
  it("only returns categories that actually have contributing metrics", () => {
    const cats = buildAllCategories([metric("openInterest", "bullish", 90)]);
    expect(cats.map((c) => c.category)).toEqual(["positioning"]);
  });

  it("keeps a stable, weight-ordered display sequence across all four categories", () => {
    // One metric per category — unlike the prior taxonomy, every V2 category
    // carries real weighted metrics (liquidityMap was always null since its
    // only member was weight-0; positioning absorbs liquidations but has
    // plenty of other real weight, so it's never structurally empty).
    const all = [
      metric("openInterest", "bullish", 90), // positioning
      metric("orderFlow", "bullish", 90), // marketStructure
      metric("macroLiquidity", "bullish", 90), // leadingDrivers
      metric("fearGreed", "bullish", 90), // risk
    ];
    const cats = buildAllCategories(all);
    expect(cats.map((c) => c.category)).toEqual(["positioning", "marketStructure", "leadingDrivers", "risk"]);
  });
});

describe("combineCategoryScores", () => {
  const cat = (category: CategoryScore["category"], score: number, confidence = 80): CategoryScore => ({
    category,
    label: category,
    score,
    verdict: score > 50 ? "bullish" : score < 50 ? "bearish" : "neutral",
    confidence,
    topReason: "",
    metrics: [],
  });

  it("returns null with no categories", () => {
    expect(combineCategoryScores([])).toBeNull();
  });

  it("weights positioning heaviest, matching CATEGORY_WEIGHTS", () => {
    expect(CATEGORY_WEIGHTS.positioning).toBeGreaterThan(CATEGORY_WEIGHTS.risk);
    // A strong positioning read against an equally strong opposite risk read
    // should pull the combined score toward positioning's direction, since
    // it carries 35% vs 20%.
    const combined = combineCategoryScores([cat("positioning", 90), cat("risk", 10)])!;
    expect(combined.score).toBeGreaterThan(50);
  });

  it("lands at exactly 50 when two unequal-weight categories exactly cancel", () => {
    // Hand-verified: w_A = 0.35*0.8=0.28, w_B = 0.25*0.8=0.20; pull_A =
    // (75-50)/50=0.5, pull_B = (15-50)/50=-0.7. weightedSum =
    // 0.5*0.28 + (-0.7)*0.20 = 0.14 - 0.14 = 0 exactly, so score = 50.
    const combined = combineCategoryScores([cat("positioning", 75), cat("marketStructure", 15)])!;
    expect(combined.score).toBe(50);
  });

  it("renormalizes across whatever categories reported rather than diluting toward neutral", () => {
    const combined = combineCategoryScores([cat("positioning", 90, 100)])!;
    expect(combined.score).toBeGreaterThan(80);
  });

  it("lets a low-confidence category pull less than a well-evidenced one", () => {
    const combined = combineCategoryScores([cat("positioning", 90, 100), cat("risk", 10, 10)])!;
    expect(combined.verdict).toBe("bullish");
  });
});

describe("buildTrendStrength", () => {
  const tech = (strength: number): TechnicalRead => ({
    direction: "bullish",
    strength,
    summary: "",
    rsi: 50,
    macdHistogram: 0,
    emaAlignment: "mixed",
    adx: 25,
    atrPct: 2,
    volumeRatio: 1,
    vwapPosition: "above",
    trendStructure: "sideways",
    bollingerBandwidthPct: null,
    bollingerPosition: null,
    stochasticK: null,
    obvTrend: null,
    supertrendDirection: null,
    parabolicSarDirection: null,
    ichimokuPosition: null,
    fibonacciNearestLevel: null,
  });

  it("returns null without a technical read", () => {
    expect(buildTrendStrength(null)).toBeNull();
  });

  it.each([
    [0, "Very Weak"],
    [19, "Very Weak"],
    [20, "Weak"],
    [39, "Weak"],
    [40, "Moderate"],
    [59, "Moderate"],
    [60, "Strong"],
    [79, "Strong"],
    [80, "Very Strong"],
    [100, "Very Strong"],
  ] as const)("buckets strength %i as %s", (strength, label) => {
    expect(buildTrendStrength(tech(strength))?.label).toBe(label);
  });

  it("carries the raw strength value through alongside the label", () => {
    expect(buildTrendStrength(tech(73))).toEqual({ label: "Strong", value: 73 });
  });
});

describe("buildMarketHealth", () => {
  it("is high when confidence and agreement are high and risk is low", () => {
    expect(buildMarketHealth(90, 90, "low")).toBeGreaterThan(85);
  });

  it("drops as risk rises, holding confidence and agreement constant", () => {
    const low = buildMarketHealth(80, 80, "low");
    const medium = buildMarketHealth(80, 80, "medium");
    const high = buildMarketHealth(80, 80, "high");
    expect(low).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(high);
  });

  it("is direction-agnostic — does not take a verdict as input at all", () => {
    // Same confidence/agreement/risk must produce the same health regardless
    // of whether the underlying read is bullish or bearish; the function
    // signature itself enforces this (no verdict parameter exists).
    expect(buildMarketHealth(70, 60, "medium")).toBe(buildMarketHealth(70, 60, "medium"));
  });

  it("stays within 0-100", () => {
    expect(buildMarketHealth(0, 0, "high")).toBeGreaterThanOrEqual(0);
    expect(buildMarketHealth(100, 100, "low")).toBeLessThanOrEqual(100);
  });
});

describe("aggregateConflicts", () => {
  it("returns an empty array when no metric has conflicts", () => {
    expect(aggregateConflicts([metric("funding", "bullish"), metric("openInterest", "bullish")])).toEqual([]);
  });

  it("collects conflicts from every metric that has one", () => {
    const metrics = [
      metric("funding", "bullish", 80, "test", ["Price action leans bearish, against this read."]),
      metric("openInterest", "bullish", 80, "test", ["Basis is inverted, against this read."]),
    ];
    expect(aggregateConflicts(metrics)).toEqual([
      "Price action leans bearish, against this read.",
      "Basis is inverted, against this read.",
    ]);
  });

  it("dedupes identical conflict sentences shared across metrics", () => {
    const shared = "Price action leans bearish, against this read.";
    const metrics = [
      metric("funding", "bullish", 80, "test", [shared]),
      metric("openInterest", "bullish", 80, "test", [shared]),
    ];
    expect(aggregateConflicts(metrics)).toEqual([shared]);
  });

  it("preserves first-seen order across metrics", () => {
    const metrics = [
      metric("funding", "bullish", 80, "test", ["A", "B"]),
      metric("openInterest", "bullish", 80, "test", ["B", "C"]),
    ];
    expect(aggregateConflicts(metrics)).toEqual(["A", "B", "C"]);
  });
});
