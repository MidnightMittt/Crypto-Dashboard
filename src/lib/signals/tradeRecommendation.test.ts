import { describe, it, expect } from "vitest";
import { buildTradeRecommendation } from "./tradeRecommendation";
import { MarketBias, MetricVerdict } from "./types";
import { MarketThesis, TechnicalRead, ThesisDirection } from "@/types/market";

const watchMetric = (label: string, nextTrigger: string): MetricVerdict => ({
  id: "funding",
  label,
  verdict: "neutral",
  confidence: 80,
  confidenceBasis: "",
  explanation: "",
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger,
});

function baseBias(overrides: Partial<MarketBias> = {}): MarketBias {
  return {
    asset: "BTC",
    score: 50,
    verdict: "neutral",
    confidence: 60,
    agreement: 50,
    headline: "Leaning narrowly bullish (led by Funding Rate), not strong enough yet to act on.",
    topBullish: [],
    topBearish: [],
    opportunity: null,
    counterRisk: null,
    watchNext: [watchMetric("Funding Rate", "turns Bullish above 0.04%/8h")],
    changes: [],
    isFirstReading: false,
    riskLevel: "low",
    riskRationale: "",
    metrics: [],
    categories: [],
    trendStrength: null,
    healthScore: 70,
    updatedAt: 0,
    ...overrides,
  };
}

function baseThesis(overrides: Partial<MarketThesis> = {}): MarketThesis {
  return {
    asset: "BTC",
    regime: "Leaning Bullish",
    regimeDescription: "",
    regimeTags: null,
    dominant: "bullish" as ThesisDirection,
    bullishEvidence: [],
    bearishEvidence: [],
    neutralEvidence: [],
    conviction: 4,
    convictionLabel: "",
    topSupporting: [],
    topOpposing: [],
    invalidation: [],
    technicalConfirmation: ["Trend strength is weak (ADX 15) — signals here tend to mean-revert."],
    updatedAt: 0,
    ...overrides,
  };
}

function baseTechnicals(direction: TechnicalRead["direction"] = "bullish"): TechnicalRead {
  return {
    direction,
    strength: 60,
    summary: "",
    rsi: 55,
    macdHistogram: 0,
    emaAlignment: "above-all",
    adx: 25,
    atrPct: 2,
    volumeRatio: 1,
    vwapPosition: "above",
    trendStructure: "higher-highs",
    bollingerBandwidthPct: null,
    bollingerPosition: null,
    stochasticK: null,
    obvTrend: null,
    supertrendDirection: null,
    parabolicSarDirection: null,
    ichimokuPosition: null,
    fibonacciNearestLevel: null,
  };
}

describe("buildTradeRecommendation", () => {
  it("recommends ENTER LONG when the thesis is bullish AND technicals agree", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish")
    );
    expect(rec.action).toBe("enter-long");
    expect(rec.label).toBe("ENTER LONG");
    expect(rec.blockingLayer).toBeNull();
    expect(rec.nextTrigger).toBeNull();
  });

  it("recommends ENTER SHORT when the thesis is bearish AND technicals agree", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bearish", score: 30 }),
      baseThesis({ dominant: "bearish" }),
      baseTechnicals("bearish")
    );
    expect(rec.action).toBe("enter-short");
    expect(rec.label).toBe("ENTER SHORT");
  });

  it("WAITs, blocked by thesis, when the overall verdict is neutral — regardless of technicals", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "neutral", score: 53 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish")
    );
    expect(rec.action).toBe("wait");
    expect(rec.blockingLayer).toBe("thesis");
    // Next trigger cites the real watchNext data, not a fabricated level.
    expect(rec.nextTrigger).toContain("Funding Rate");
    expect(rec.nextTrigger).toContain("turns Bullish above 0.04%/8h");
  });

  it("WAITs, blocked by technicals, when the thesis is directional but technicals conflict", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bearish") // conflicts with the bullish thesis
    );
    expect(rec.action).toBe("wait");
    expect(rec.blockingLayer).toBe("technicals");
    // Reason cites the real technicalConfirmation line, not an invented one.
    expect(rec.reason).toContain("trend strength is weak");
  });

  it("WAITs, blocked by technicals, when technicals are simply absent", () => {
    // Matches MarketThesis's own contract: technicalConfirmation is empty
    // when candle data is unavailable — that's what "no technical read"
    // looks like in real data, not a thesis with confirmation lines but no
    // technicals object (an inconsistent state that can't occur in practice).
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish", technicalConfirmation: [] }),
      null
    );
    expect(rec.action).toBe("wait");
    expect(rec.blockingLayer).toBe("technicals");
    expect(rec.reason).toContain("No technical read is available");
  });

  it("never fabricates a specific numeric technical trigger level it can't back with real data", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("neutral") // "neutral" technicals -> technicalAgreement reads "neutral", not "agrees"
    );
    expect(rec.action).toBe("wait");
    expect(rec.nextTrigger).not.toMatch(/RSI\s*>|MACD\s*crossover|EMA\s*\d/i);
  });

  it("the recommendation reason never contains banned vague-language phrases", () => {
    const rec = buildTradeRecommendation(baseBias({ verdict: "neutral", score: 47 }), baseThesis({ dominant: "bearish" }), null);
    expect(rec.reason.toLowerCase()).not.toContain("mixed");
    expect(rec.reason.toLowerCase()).not.toContain("conflicting signals");
    expect(rec.reason.toLowerCase()).not.toContain("cannot determine");
  });
});
