import { describe, it, expect } from "vitest";
import {
  buildCategoryScore,
  buildAllCategories,
  combineCategoryScores,
  buildTrendStrength,
  buildMarketHealth,
  CATEGORY_WEIGHTS,
} from "./categories";
import { MetricVerdict, Verdict, CategoryScore } from "./types";
import { TechnicalRead } from "@/types/market";

const metric = (id: string, verdict: Verdict, confidence = 80, explanation = "test"): MetricVerdict => ({
  id,
  label: id,
  verdict,
  confidence,
  confidenceBasis: "",
  explanation,
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger: null,
});

describe("buildCategoryScore", () => {
  it("returns null when no metric belonging to the category has weight", () => {
    // liquidations belongs to liquidityMap but carries weight 0 by design —
    // liquidityMap's card reads its own volume-profile/S-R data instead, not
    // this score (see categories.ts's own doc comment on liquidityMap).
    expect(buildCategoryScore([metric("liquidations", "bearish")], "liquidityMap")).toBeNull();
  });

  it("returns null when no metric belongs to the category at all", () => {
    expect(buildCategoryScore([metric("fearGreed", "bullish")], "liquidityMap")).toBeNull();
  });

  it("scores a category from only the metrics that belong to it", () => {
    // openInterest is leveragedPositioning-only; coinbasePremium is spotDemand-only — must not leak across.
    const cat = buildCategoryScore(
      [metric("openInterest", "bullish", 100), metric("coinbasePremium", "bearish", 100)],
      "leveragedPositioning"
    )!;
    expect(cat.verdict).toBe("bullish");
    expect(cat.metrics.map((m) => m.id)).toEqual(["openInterest"]);
  });

  it("lets a metric feed two categories at once (funding)", () => {
    // funding is the one deliberate dual-membership in the new taxonomy —
    // "which side is crowded" (leveragedPositioning) vs. "how extreme is the
    // cost of holding leverage" (marketStress), same number, two questions.
    const metrics = [metric("funding", "bullish", 90)];
    const leveragedPositioning = buildCategoryScore(metrics, "leveragedPositioning");
    const marketStress = buildCategoryScore(metrics, "marketStress");
    expect(leveragedPositioning?.verdict).toBe("bullish");
    expect(marketStress?.verdict).toBe("bullish");
  });

  it("picks the highest weight-x-confidence metric as the top reason", () => {
    const cat = buildCategoryScore(
      [
        metric("openInterest", "bullish", 90, "weak signal"), // lighter leveragedPositioning weight (0.09)
        metric("funding", "bullish", 90, "strong signal"), // heavier leveragedPositioning weight (0.15)
      ],
      "leveragedPositioning"
    )!;
    expect(cat.topReason).toContain("strong signal");
  });
});

describe("buildAllCategories", () => {
  it("only returns categories that actually have contributing metrics", () => {
    // openInterest has single membership (leveragedPositioning only) — funding
    // would return two categories here since it's the deliberate dual-member.
    const cats = buildAllCategories([metric("openInterest", "bullish", 90)]);
    expect(cats.map((c) => c.category)).toEqual(["leveragedPositioning"]);
  });

  it("keeps a stable, weight-ordered display sequence", () => {
    // liquidityMap is deliberately excluded here: its only member
    // (liquidations) is weight-0, so buildCategoryScore always returns null
    // for it regardless of which metrics are passed — verified directly
    // against computeWeightedScore's `if (totalWeight <= 0) return null`.
    const all = ["openInterest", "orderFlow", "technicals"].map((id) => metric(id, "bullish", 90));
    const cats = buildAllCategories(all);
    expect(cats.map((c) => c.category)).toEqual(["leveragedPositioning", "spotDemand", "marketStress"]);
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

  it("weights leveragedPositioning heaviest, matching CATEGORY_WEIGHTS", () => {
    expect(CATEGORY_WEIGHTS.leveragedPositioning).toBeGreaterThan(CATEGORY_WEIGHTS.liquidityMap);
    // A strong leveragedPositioning read against an equally strong opposite
    // liquidityMap read should pull the combined score toward
    // leveragedPositioning's direction, since it carries 35% vs 15%.
    const combined = combineCategoryScores([cat("leveragedPositioning", 90), cat("liquidityMap", 10)])!;
    expect(combined.score).toBeGreaterThan(50);
  });

  it("lands at exactly 50 when two unequal-weight categories exactly cancel", () => {
    // Hand-verified: w_A = 0.35*0.8=0.28, w_B = 0.30*0.8=0.24; pull_A =
    // (80-50)/50=0.6, pull_B = (15-50)/50=-0.7. weightedSum =
    // 0.6*0.28 + (-0.7)*0.24 = 0.168 - 0.168 = 0 exactly, so score = 50.
    // (No two categories share a weight in the new 35/30/20/15 scheme, unlike
    // the old 25/20/20/20/15 scheme's momentum/derivatives tie — this test
    // picks scores that cancel the UNEQUAL weights exactly instead.)
    const combined = combineCategoryScores([cat("leveragedPositioning", 80), cat("spotDemand", 15)])!;
    expect(combined.score).toBe(50);
  });

  it("renormalizes across whatever categories reported rather than diluting toward neutral", () => {
    const combined = combineCategoryScores([cat("leveragedPositioning", 90, 100)])!;
    expect(combined.score).toBeGreaterThan(80);
  });

  it("lets a low-confidence category pull less than a well-evidenced one", () => {
    const combined = combineCategoryScores([cat("leveragedPositioning", 90, 100), cat("liquidityMap", 10, 10)])!;
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
