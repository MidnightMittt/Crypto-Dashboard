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
    rsiDivergence: null,
    macdDivergence: null,
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

  it("still recommends ENTER LONG when the 4H higher-timeframe read is absent — HTF is optional, never required", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish")
      // technicals4h omitted entirely (defaults to null)
    );
    expect(rec.action).toBe("enter-long");
    expect(rec.reason).not.toContain("4-hour");
  });

  it("appends a caveat, but does NOT block, when the 4H higher-timeframe read contradicts an otherwise-clearing ENTER", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish"),
      baseTechnicals("bearish") // 4H disagrees with the bullish daily thesis
    );
    // Still a real ENTER — HTF disagreement never overrides a lower-timeframe entry per spec.
    expect(rec.action).toBe("enter-long");
    expect(rec.blockingLayer).toBeNull();
    expect(rec.nextTrigger).toBeNull();
    expect(rec.reason).toContain("4-hour");
  });

  it("adds no caveat when the 4H higher-timeframe read agrees", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish"),
      baseTechnicals("bullish") // 4H agrees
    );
    expect(rec.action).toBe("enter-long");
    expect(rec.reason).not.toContain("4-hour");
  });

  it("is NO TRADE, blocked by thesis, when the overall verdict is neutral — regardless of technicals", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "neutral", score: 53 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish")
    );
    expect(rec.action).toBe("no-trade");
    expect(rec.label).toBe("NO TRADE");
    expect(rec.blockingLayer).toBe("thesis");
    // Next trigger cites the real watchNext data, not a fabricated level.
    expect(rec.nextTrigger).toContain("Funding Rate");
    expect(rec.nextTrigger).toContain("turns Bullish above 0.04%/8h");
  });

  it("waits for long confirmation, blocked by technicals, when the thesis is directional but technicals conflict", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bearish") // conflicts with the bullish thesis
    );
    expect(rec.action).toBe("wait-long-confirmation");
    expect(rec.label).toBe("WAIT FOR LONG CONFIRMATION");
    expect(rec.blockingLayer).toBe("technicals");
    // Reason cites the real technicalConfirmation line, not an invented one.
    expect(rec.reason).toContain("trend strength is weak");
  });

  it("waits for long confirmation, blocked by technicals, when technicals are simply absent", () => {
    // Matches MarketThesis's own contract: technicalConfirmation is empty
    // when candle data is unavailable — that's what "no technical read"
    // looks like in real data, not a thesis with confirmation lines but no
    // technicals object (an inconsistent state that can't occur in practice).
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish", technicalConfirmation: [] }),
      null
    );
    expect(rec.action).toBe("wait-long-confirmation");
    expect(rec.blockingLayer).toBe("technicals");
    expect(rec.reason).toContain("No technical read is available");
  });

  it("waits for SHORT confirmation, not long, when the blocked thesis is bearish", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bearish", score: 30 }),
      baseThesis({ dominant: "bearish", technicalConfirmation: [] }),
      null
    );
    expect(rec.action).toBe("wait-short-confirmation");
    expect(rec.label).toBe("WAIT FOR SHORT CONFIRMATION");
    expect(rec.blockingLayer).toBe("technicals");
  });

  it("never fabricates a specific numeric technical trigger level it can't back with real data", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("neutral") // "neutral" technicals -> technicalAgreement reads "not-yet-confirmed", not "confirms"
    );
    expect(rec.action).toBe("wait-long-confirmation");
    expect(rec.nextTrigger).not.toMatch(/RSI\s*>|MACD\s*crossover|EMA\s*\d/i);
  });

  it("the recommendation reason never contains banned vague-language phrases", () => {
    const rec = buildTradeRecommendation(baseBias({ verdict: "neutral", score: 47 }), baseThesis({ dominant: "bearish" }), null);
    expect(rec.reason.toLowerCase()).not.toContain("mixed");
    expect(rec.reason.toLowerCase()).not.toContain("conflicting signals");
    expect(rec.reason.toLowerCase()).not.toContain("cannot determine");
  });

  it("waits for long confirmation, blocked by technicals, when the thesis agrees directionally but a regular divergence undercuts it", () => {
    const bullishTechnicals = baseTechnicals("bullish");
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      {
        ...bullishTechnicals,
        rsiDivergence: {
          kind: "regular-bearish",
          priorIndex: 0,
          recentIndex: 1,
          pricePrior: 0,
          priceRecent: 0,
          indicatorPrior: 0,
          indicatorRecent: 0,
        },
      }
    );
    expect(rec.action).toBe("wait-long-confirmation");
    expect(rec.blockingLayer).toBe("technicals");
    // Cites the real divergence source and kind, not a generic message.
    expect(rec.reason).toContain("RSI");
    expect(rec.reason).toContain("bearish divergence");
  });

  it("does not block on a hidden (continuation) divergence — still enters", () => {
    const bullishTechnicals = baseTechnicals("bullish");
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      {
        ...bullishTechnicals,
        rsiDivergence: {
          kind: "hidden-bullish",
          priorIndex: 0,
          recentIndex: 1,
          pricePrior: 0,
          priceRecent: 0,
          indicatorPrior: 0,
          indicatorRecent: 0,
        },
      }
    );
    expect(rec.action).toBe("enter-long");
    expect(rec.blockingLayer).toBeNull();
  });
});

describe("the record gate (Layer 3 — measured EV)", () => {
  it("downgrades a confirmed directional entry to NO TRADE when the side's record is EV-negative", () => {
    // Bias bearish + technicals confirm would normally be enter-short; a
    // negative-EV record for shorts in this regime withholds the ACTION
    // while the reason still states the read.
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bearish", score: 30 }),
      baseThesis({ dominant: "bearish" }),
      baseTechnicals("bearish"),
      null,
      { evLowerPct: -0.69, n: 289, cellKey: "short:high-vol" }
    );
    expect(rec.action).toBe("no-trade");
    expect(rec.blockingLayer).toBe("record");
    expect(rec.reason).toContain("NEGATIVE measured expectancy");
    expect(rec.reason).toContain("short:high-vol");
  });

  it("lets a positive-record side through unchanged", () => {
    const rec = buildTradeRecommendation(
      baseBias({ verdict: "bullish", score: 70 }),
      baseThesis({ dominant: "bullish" }),
      baseTechnicals("bullish"),
      null,
      { evLowerPct: 2.48, n: 82, cellKey: "long:high-vol" }
    );
    expect(rec.action).toBe("enter-long");
    expect(rec.blockingLayer).toBeNull();
  });

  it("changes nothing when no record covers the setup — absence of evidence is not a veto", () => {
    const args = [
      baseBias({ verdict: "bearish", score: 30 }),
      baseThesis({ dominant: "bearish" }),
      baseTechnicals("bearish"),
    ] as const;
    expect(buildTradeRecommendation(...args, null, null).action).toBe(
      buildTradeRecommendation(...args).action
    );
  });
});
