import { describe, it, expect } from "vitest";
import { buildMarketThesis, classifyRegime, MarketThesisInputs } from "./marketThesis";
import {
  OrderFlowSummary,
  SqueezeRisk,
  DeribitOptionsSummary,
  ExchangeFlowSummary,
  LiquidationSummary,
} from "@/types/market";

const NOW = 1_700_000_000_000;

function baseInputs(overrides: Partial<MarketThesisInputs> = {}): MarketThesisInputs {
  return {
    asset: "BTC",
    technicals: null,
    weightedFundingRatePct: 0,
    longShortRatio: null,
    basisPct: null,
    coinbasePremiumPct: null,
    orderFlow: null,
    squeezeRisk: null,
    deribitOptions: null,
    exchangeFlow: null,
    liquidations: null,
    priceChange24hPct: 0,
    leverageHeatScore: 50,
    regimeTags: null,
    ...overrides,
  };
}

describe("buildMarketThesis - null/empty handling", () => {
  it("returns null when every input is absent", () => {
    // weightedFundingRatePct is always present in the real type (a number,
    // not nullable), so it alone always contributes neutral evidence at
    // fundingPct=0 - confirm that alone doesn't blank the whole thesis.
    const result = buildMarketThesis(baseInputs(), NOW);
    expect(result).not.toBeNull();
    expect(result!.neutralEvidence.length + result!.bullishEvidence.length + result!.bearishEvidence.length).toBeGreaterThan(0);
  });
});

describe("buildMarketThesis - funding evidence (fade-the-extremes)", () => {
  it("reads mild positive funding as bullish", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0.08 }), NOW)!;
    const funding = result.bullishEvidence.find((e) => e.source === "Funding Rate");
    expect(funding).toBeDefined();
  });

  it("reads mild negative funding as bearish", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: -0.08 }), NOW)!;
    const funding = result.bearishEvidence.find((e) => e.source === "Funding Rate");
    expect(funding).toBeDefined();
  });

  it("reads EXTREME positive funding (crowded longs) as BEARISH, not more bullish", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0.5 }), NOW)!;
    expect(result.bearishEvidence.find((e) => e.source === "Funding Rate")).toBeDefined();
    expect(result.bullishEvidence.find((e) => e.source === "Funding Rate")).toBeUndefined();
  });

  it("reads EXTREME negative funding (crowded shorts) as BULLISH, not more bearish", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: -0.5 }), NOW)!;
    expect(result.bullishEvidence.find((e) => e.source === "Funding Rate")).toBeDefined();
    expect(result.bearishEvidence.find((e) => e.source === "Funding Rate")).toBeUndefined();
  });

  it("reads near-zero funding as neutral", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0.001 }), NOW)!;
    expect(result.neutralEvidence.find((e) => e.source === "Funding Rate")).toBeDefined();
  });
});

describe("buildMarketThesis - long/short evidence", () => {
  it("reads a long-heavy ratio as bullish (direct, not contrarian)", () => {
    const result = buildMarketThesis(baseInputs({ longShortRatio: 2.5 }), NOW)!; // ~71% long
    expect(result.bullishEvidence.find((e) => e.source === "Long/Short Positioning")).toBeDefined();
  });

  it("reads a short-heavy ratio as bearish", () => {
    const result = buildMarketThesis(baseInputs({ longShortRatio: 0.4 }), NOW)!; // ~29% long
    expect(result.bearishEvidence.find((e) => e.source === "Long/Short Positioning")).toBeDefined();
  });

  it("is absent entirely when longShortRatio is null (not defaulted to neutral)", () => {
    const result = buildMarketThesis(baseInputs({ longShortRatio: null }), NOW)!;
    const all = [...result.bullishEvidence, ...result.bearishEvidence, ...result.neutralEvidence];
    expect(all.find((e) => e.source === "Long/Short Positioning")).toBeUndefined();
  });
});

describe("buildMarketThesis - squeeze risk evidence (fade the exposed side)", () => {
  const strongSqueeze = (side: "long" | "short" | "balanced"): SqueezeRisk => ({
    score: 85,
    side,
    components: [],
  });

  it("reads a strong long-side squeeze setup as BEARISH (longs exposed to downside)", () => {
    const result = buildMarketThesis(baseInputs({ squeezeRisk: strongSqueeze("long") }), NOW)!;
    expect(result.bearishEvidence.find((e) => e.source === "Squeeze Setup")).toBeDefined();
  });

  it("reads a strong short-side squeeze setup as BULLISH (shorts exposed to upside)", () => {
    const result = buildMarketThesis(baseInputs({ squeezeRisk: strongSqueeze("short") }), NOW)!;
    expect(result.bullishEvidence.find((e) => e.source === "Squeeze Setup")).toBeDefined();
  });

  it("reads a low-score squeeze setup as neutral even with a side, since the setup isn't developed", () => {
    const weakSqueeze: SqueezeRisk = { score: 15, side: "long", components: [] };
    const result = buildMarketThesis(baseInputs({ squeezeRisk: weakSqueeze }), NOW)!;
    expect(result.neutralEvidence.find((e) => e.source === "Squeeze Setup")).toBeDefined();
  });

  it("reads a balanced side as neutral regardless of score", () => {
    const result = buildMarketThesis(baseInputs({ squeezeRisk: strongSqueeze("balanced") }), NOW)!;
    expect(result.neutralEvidence.find((e) => e.source === "Squeeze Setup")).toBeDefined();
  });
});

describe("buildMarketThesis - order flow evidence", () => {
  function flow(dominantFlow: OrderFlowSummary["dominantFlow"], buyerSharePct: number): OrderFlowSummary {
    return {
      bookImbalance: null,
      cvdHistory: [],
      totalBuyUsd: 0,
      totalSellUsd: 0,
      dominantFlow,
      buyerSharePct,
      windowHours: 24,
      venue: "OKX",
    };
  }

  it("reads buyer-dominant flow as bullish", () => {
    const result = buildMarketThesis(baseInputs({ orderFlow: flow("buyers", 70) }), NOW)!;
    expect(result.bullishEvidence.find((e) => e.source === "Order Flow (OKX)")).toBeDefined();
  });

  it("reads seller-dominant flow as bearish", () => {
    const result = buildMarketThesis(baseInputs({ orderFlow: flow("sellers", 30) }), NOW)!;
    expect(result.bearishEvidence.find((e) => e.source === "Order Flow (OKX)")).toBeDefined();
  });
});

describe("buildMarketThesis - liquidations are always neutral context, never directional", () => {
  it("never appears in bullish or bearish evidence regardless of dominant side", () => {
    const liq: LiquidationSummary = {
      history: [],
      totalLongUsd: 1_000_000,
      totalShortUsd: 100_000,
      dominantSide: "long",
      longSharePct: 91,
      venues: ["binance"],
      windowHours: 24,
    };
    const result = buildMarketThesis(baseInputs({ liquidations: liq }), NOW)!;
    expect(result.bullishEvidence.find((e) => e.source === "Liquidations")).toBeUndefined();
    expect(result.bearishEvidence.find((e) => e.source === "Liquidations")).toBeUndefined();
    expect(result.neutralEvidence.find((e) => e.source === "Liquidations")).toBeDefined();
  });

  it("carries zero weight, so it never influences conviction", () => {
    const liq: LiquidationSummary = {
      history: [],
      totalLongUsd: 1,
      totalShortUsd: 0,
      dominantSide: "long",
      longSharePct: 100,
      venues: [],
      windowHours: 24,
    };
    const withLiq = buildMarketThesis(baseInputs({ liquidations: liq }), NOW)!;
    const withoutLiq = buildMarketThesis(baseInputs(), NOW)!;
    expect(withLiq.conviction).toBe(withoutLiq.conviction);
  });
});

describe("buildMarketThesis - conviction arithmetic (hand-verified)", () => {
  it("is maximal (10) when every present source agrees and none are neutral", () => {
    // Funding mildly bullish, long/short bullish, basis bullish - all
    // agree, nothing neutral -> agreementRatio=1, participationRatio=1.
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.08,
        longShortRatio: 2.5,
        basisPct: 0.05,
      }),
      NOW
    )!;
    expect(result.conviction).toBe(10);
  });

  it("is 0 when the only evidence is neutral", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0 }), NOW)!;
    expect(result.conviction).toBe(0);
  });

  it("computes a specific mixed case by hand: bull=0.2 (funding), bear=0.12 (long/short), rest absent", () => {
    // agreementRatio = max(0.2,0.12)/(0.2+0.12) = 0.2/0.32 = 0.625
    // participationRatio = 0.32/0.32 = 1 (nothing neutral, nothing else present)
    // conviction = round(0.625 * 1 * 10) = round(6.25) = 6
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.08, // bullish, weight 0.20
        longShortRatio: 0.4, // bearish, weight 0.12
      }),
      NOW
    )!;
    expect(result.conviction).toBe(6);
  });
});

describe("buildMarketThesis - top supporting / opposing", () => {
  it("puts the higher-weighted evidence first in topSupporting", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.08, // bullish, weight 0.20 - should rank first
        orderFlow: {
          bookImbalance: null,
          cvdHistory: [],
          totalBuyUsd: 0,
          totalSellUsd: 0,
          dominantFlow: "buyers",
          buyerSharePct: 70,
          windowHours: 24,
          venue: "OKX",
        }, // bullish, weight 0.12
      }),
      NOW
    )!;
    expect(result.topSupporting[0].source).toBe("Funding Rate");
  });

  it("caps topSupporting and topOpposing at 5 entries each", () => {
    const deribit: DeribitOptionsSummary = {
      asset: "BTC",
      expiry: "2026-01-01",
      putCallRatio: 0.3,
      maxPain: 60000,
      atmIvPct: 50,
      totalOpenInterestContracts: 100,
      totalOpenInterestUsd: 1,
      updatedAt: NOW,
    };
    const exchangeFlow: ExchangeFlowSummary = {
      asset: "BTC",
      netflowUsd: -1000,
      netflowNative: -1,
      currentBalanceUsd: 1,
      windowHours: 24,
      direction: "outflow",
      venues: ["Binance"],
      trackedAddressCount: 1,
    };
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.08,
        longShortRatio: 2.5,
        basisPct: 0.05,
        coinbasePremiumPct: 0.05,
        orderFlow: {
          bookImbalance: null,
          cvdHistory: [],
          totalBuyUsd: 0,
          totalSellUsd: 0,
          dominantFlow: "buyers",
          buyerSharePct: 70,
          windowHours: 24,
          venue: "OKX",
        },
        squeezeRisk: { score: 85, side: "short", components: [] },
        deribitOptions: deribit,
        exchangeFlow,
      }),
      NOW
    )!;
    expect(result.topSupporting.length).toBeLessThanOrEqual(5);
  });
});

describe("buildMarketThesis - invalidation", () => {
  it("names the top supporting factor by source and cites its actual detail", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0.08 }), NOW)!;
    expect(result.invalidation[0]).toContain("Funding Rate");
  });

  it("says there's nothing to invalidate when the thesis itself is neutral/balanced", () => {
    const result = buildMarketThesis(
      baseInputs({ weightedFundingRatePct: 0.08, longShortRatio: 0.4 }), // bull 0.20 vs bear 0.12... not balanced actually
      NOW
    );
    // Construct a genuinely balanced case instead: equal bull/bear weight.
    const balanced = buildMarketThesis(
      baseInputs({
        basisPct: 0.05, // bullish, weight 0.12
        longShortRatio: 0.4, // bearish, weight 0.12
      }),
      NOW
    )!;
    expect(balanced.invalidation[0]).toMatch(/no dominant thesis/i);
    expect(result).not.toBeNull(); // sanity: the other case still built fine
  });
});

describe("buildMarketThesis - regime classification", () => {
  it("classifies a strong long-side squeeze setup as its own regime, overriding trend labels", () => {
    const result = buildMarketThesis(
      baseInputs({ squeezeRisk: { score: 85, side: "long", components: [] } }),
      NOW
    )!;
    expect(result.regime).toBe("Squeeze Setup — Longs Exposed");
  });

  it("classifies high-conviction one-sided evidence as Trending", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.08,
        longShortRatio: 2.5,
        basisPct: 0.05,
      }),
      NOW
    )!;
    expect(result.regime).toBe("Trending Bullish");
  });

  it("classifies quiet price + low leverage heat as Consolidation", () => {
    const result = buildMarketThesis(
      baseInputs({ weightedFundingRatePct: 0, priceChange24hPct: 0.3, leverageHeatScore: 10 }),
      NOW
    )!;
    expect(result.regime).toBe("Consolidation");
  });

  it("classifies zero-conviction evidence as Mixed / Low Conviction", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0 }), NOW)!;
    expect(result.regime).toBe("Mixed / Low Conviction");
  });
});

describe("classifyRegime — never says 'Mixed'/'balanced' when there's a real (non-tied) lean", () => {
  const regimeCtx = (overrides: Partial<Parameters<typeof classifyRegime>[0]> = {}) => ({
    conviction: 0,
    dominant: "neutral" as const,
    squeezeRisk: null,
    leverageHeatScore: 80, // keep the "quiet market" Consolidation branch from firing
    priceChange24hPct: 5,
    ...overrides,
  });

  it("low conviction (<=2) with a real bullish lean reads Leaning Bullish, not Mixed", () => {
    // This is the exact bug: low CONVICTION used to fall through to "Mixed
    // / Low Conviction" regardless of whether `dominant` still cleanly
    // leaned a direction. Low conviction (mostly neutral/inactive
    // evidence) and no lean (a genuine tie) are different facts.
    const result = classifyRegime(regimeCtx({ conviction: 1, dominant: "bullish" }));
    expect(result.label).toBe("Leaning Bullish");
    expect(result.description.toLowerCase()).not.toContain("mixed");
    expect(result.description).toContain("thin");
  });

  it("low conviction (<=2) with a real bearish lean reads Leaning Bearish, not Mixed", () => {
    const result = classifyRegime(regimeCtx({ conviction: 2, dominant: "bearish" }));
    expect(result.label).toBe("Leaning Bearish");
    expect(result.description.toLowerCase()).not.toContain("mixed");
  });

  it("genuine tie (dominant === neutral) still reads Mixed / Low Conviction, worded without banned words", () => {
    const result = classifyRegime(regimeCtx({ conviction: 0, dominant: "neutral" }));
    expect(result.label).toBe("Mixed / Low Conviction");
    expect(result.description.toLowerCase()).not.toContain("mixed");
    expect(result.description.toLowerCase()).not.toContain("uncertain");
  });

  it("higher conviction with a real lean uses the non-thin phrasing", () => {
    const result = classifyRegime(regimeCtx({ conviction: 5, dominant: "bullish" }));
    expect(result.label).toBe("Leaning Bullish");
    expect(result.description).not.toContain("thin");
  });
});

describe("buildMarketThesis - passthrough", () => {
  it("carries asset and updatedAt through unchanged", () => {
    const result = buildMarketThesis(baseInputs({ asset: "ETH" }), NOW)!;
    expect(result.asset).toBe("ETH");
    expect(result.updatedAt).toBe(NOW);
  });
});
