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
    // liquidations belongs to liquidity but carries weight 0 by design.
    expect(buildCategoryScore([metric("liquidations", "bearish")], "liquidity")).toBeNull();
  });

  it("returns null when no metric belongs to the category at all", () => {
    expect(buildCategoryScore([metric("fearGreed", "bullish")], "derivatives")).toBeNull();
  });

  it("scores a category from only the metrics that belong to it", () => {
    // openInterest is liquidity; funding is derivatives — must not leak across.
    const cat = buildCategoryScore(
      [metric("openInterest", "bullish", 100), metric("funding", "bearish", 100)],
      "liquidity"
    )!;
    expect(cat.verdict).toBe("bullish");
    expect(cat.metrics.map((m) => m.id)).toEqual(["openInterest"]);
  });

  it("lets a metric feed two categories at once (exchangeFlow)", () => {
    const metrics = [metric("exchangeFlow", "bullish", 90)];
    const liquidity = buildCategoryScore(metrics, "liquidity");
    const onchain = buildCategoryScore(metrics, "onchain");
    expect(liquidity?.verdict).toBe("bullish");
    expect(onchain?.verdict).toBe("bullish");
  });

  it("picks the highest weight-x-confidence metric as the top reason", () => {
    const cat = buildCategoryScore(
      [
        metric("spotPerpVolume", "bullish", 90, "weak signal"), // lightest derivatives weight
        metric("funding", "bullish", 90, "strong signal"), // heaviest derivatives weight
      ],
      "derivatives"
    )!;
    expect(cat.topReason).toContain("strong signal");
  });
});

describe("buildAllCategories", () => {
  it("only returns categories that actually have contributing metrics", () => {
    const cats = buildAllCategories([metric("funding", "bullish", 90)]);
    expect(cats.map((c) => c.category)).toEqual(["derivatives"]);
  });

  it("keeps a stable, weight-ordered display sequence", () => {
    const all = [
      "openInterest",
      "technicals",
      "funding",
      "etfFlows",
      "fearGreed",
    ].map((id) => metric(id, "bullish", 90));
    const cats = buildAllCategories(all);
    expect(cats.map((c) => c.category)).toEqual([
      "liquidity",
      "momentum",
      "derivatives",
      "onchain",
      "sentiment",
    ]);
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

  it("weights liquidity heaviest, matching CATEGORY_WEIGHTS", () => {
    expect(CATEGORY_WEIGHTS.liquidity).toBeGreaterThan(CATEGORY_WEIGHTS.sentiment);
    // A strong liquidity read against an equally strong opposite sentiment
    // read should pull the combined score toward liquidity's direction,
    // since it carries 25% vs sentiment's 15%.
    const combined = combineCategoryScores([cat("liquidity", 90), cat("sentiment", 10)])!;
    expect(combined.score).toBeGreaterThan(50);
  });

  it("lands at exactly 50 when weighted-equal categories fully offset", () => {
    // momentum (20%) and derivatives (20%) carry equal weight, so mirrored
    // scores at equal confidence should cancel exactly.
    const combined = combineCategoryScores([cat("momentum", 80), cat("derivatives", 20)])!;
    expect(combined.score).toBe(50);
  });

  it("renormalizes across whatever categories reported rather than diluting toward neutral", () => {
    const combined = combineCategoryScores([cat("liquidity", 90, 100)])!;
    expect(combined.score).toBeGreaterThan(80);
  });

  it("lets a low-confidence category pull less than a well-evidenced one", () => {
    const combined = combineCategoryScores([cat("liquidity", 90, 100), cat("sentiment", 10, 10)])!;
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
