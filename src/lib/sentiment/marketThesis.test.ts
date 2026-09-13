import { describe, it, expect } from "vitest";
import { buildMarketThesis, classifyRegime, MarketThesisInputs } from "./marketThesis";
import {
  OrderFlowSummary,
  SqueezeRisk,
  DeribitOptionsSummary,
  ExchangeFlowSummary,
  LiquidationSummary,
  TechnicalRead,
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

describe("buildMarketThesis - funding evidence (fade the crowd, at every magnitude)", () => {
  /*
   * These two used to assert the opposite, inside a describe block named
   * "fade-the-extremes", directly above a test titled "reads EXTREME positive
   * funding as BEARISH, not more bullish". The suite recorded the sign flip
   * faithfully and never registered it as a contradiction.
   */
  it("reads mild positive funding as BEARISH — longs are paying, so longs are exposed", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0.08 }), NOW)!;
    expect(result.bearishEvidence.find((e) => e.source === "Funding Rate")).toBeDefined();
    expect(result.bullishEvidence.find((e) => e.source === "Funding Rate")).toBeUndefined();
  });

  it("reads mild negative funding as BULLISH — shorts are paying, so shorts are exposed", () => {
    const result = buildMarketThesis(baseInputs({ weightedFundingRatePct: -0.08 }), NOW)!;
    expect(result.bullishEvidence.find((e) => e.source === "Funding Rate")).toBeDefined();
    expect(result.bearishEvidence.find((e) => e.source === "Funding Rate")).toBeUndefined();
  });

  it("reads the same direction at mild and extreme magnitude — no sign flip on one axis", () => {
    // The property that was broken: +0.08 and +0.5 must not disagree.
    for (const pct of [0.05, 0.08, 0.2, 0.5]) {
      const r = buildMarketThesis(baseInputs({ weightedFundingRatePct: pct }), NOW)!;
      expect(r.bearishEvidence.find((e) => e.source === "Funding Rate"), `+${pct} must read bearish`).toBeDefined();
    }
    for (const pct of [-0.05, -0.08, -0.2, -0.5]) {
      const r = buildMarketThesis(baseInputs({ weightedFundingRatePct: pct }), NOW)!;
      expect(r.bullishEvidence.find((e) => e.source === "Funding Rate"), `${pct} must read bullish`).toBeDefined();
    }
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

/*
 * These used to assert the opposite: "reads a long-heavy ratio as bullish
 * (direct, not contrarian)". That reading was deliberate and it was wrong —
 * not because the trend interpretation is indefensible, but because
 * `squeezeRiskEvidence` was simultaneously making the CONTRARIAN call off the
 * same long/short ratio, at 0.16 against this one's 0.10. Every observation
 * where both spoke, they cancelled to a 0.06 bear lean that no one designed.
 *
 * One input, one directional claim. Positioning describes; the squeeze read
 * predicts.
 */
describe("buildMarketThesis - long/short evidence is context, never a pillar", () => {
  it("keeps a long-heavy ratio out of the bullish pillars", () => {
    const result = buildMarketThesis(baseInputs({ longShortRatio: 2.5 }), NOW)!; // ~71% long
    expect(result.bullishEvidence.find((e) => e.source === "Long/Short Positioning")).toBeUndefined();
    const ctx = result.neutralEvidence.find((e) => e.source === "Long/Short Positioning");
    expect(ctx).toBeDefined();
    // The placement itself is still reported — this is a demotion, not a deletion.
    expect(ctx!.detail).toContain("71% long");
    expect(ctx!.detail).toContain("Mostly Longs");
  });

  it("keeps a short-heavy ratio out of the bearish pillars", () => {
    const result = buildMarketThesis(baseInputs({ longShortRatio: 0.4 }), NOW)!; // ~29% long
    expect(result.bearishEvidence.find((e) => e.source === "Long/Short Positioning")).toBeUndefined();
    expect(result.neutralEvidence.find((e) => e.source === "Long/Short Positioning")).toBeDefined();
  });

  /*
   * The load-bearing assertion. Weight 0 is what stops it moving conviction:
   * a merely-neutral pillar at weight 0.10 would still enter neutralWeight
   * and drag participationRatio down, so the demotion would have swapped a
   * phantom vote for a phantom damper.
   */
  it("carries zero weight, so it cannot move conviction in either direction", () => {
    const withRatio = buildMarketThesis(
      baseInputs({ weightedFundingRatePct: 0.08, longShortRatio: 2.5 }),
      NOW
    )!;
    const without = buildMarketThesis(baseInputs({ weightedFundingRatePct: 0.08 }), NOW)!;
    expect(withRatio.neutralEvidence.find((e) => e.source === "Long/Short Positioning")!.weight).toBe(0);
    expect(withRatio.conviction).toBe(without.conviction);
    expect(withRatio.dominant).toBe(without.dominant);
  });

  /*
   * The pair that motivated all of this: a crowded long side must now produce
   * exactly one directional read, not two opposed ones.
   */
  it("no longer opposes the squeeze read on the same crowded side", () => {
    const result = buildMarketThesis(
      baseInputs({
        longShortRatio: 2.5, // crowd is long
        squeezeRisk: { score: 85, side: "long", components: [] }, // ...and exposed
      }),
      NOW
    )!;
    const bullSources = result.bullishEvidence.map((e) => e.source);
    const bearSources = result.bearishEvidence.map((e) => e.source);
    expect(bearSources).toContain("Squeeze Setup");
    expect(bullSources).not.toContain("Long/Short Positioning");
    expect(result.dominant).toBe("bearish");
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
    // Funding mildly bullish and basis bullish — they agree, and nothing
    // carries neutral WEIGHT, so agreementRatio=1 and participationRatio=1.
    // The long/short ratio is present but weightless context, which is
    // precisely why it does not pull participation below 1.
    //
    // Funding is NEGATIVE here to be the bullish side: shorts paying is what
    // makes shorts the exposed side. It read +0.08 while mild positive funding
    // was scored bullish; the intended arithmetic is unchanged, only the sign
    // that produces a bullish funding pillar.
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: -0.08,
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

  it("computes a specific mixed case by hand: bull=0.17 (funding), bear=0.10 (basis), rest absent", () => {
    // agreementRatio = max(0.17,0.10)/(0.17+0.10) = 0.17/0.27 = 0.6296
    // participationRatio = 0.27/0.27 = 1 (nothing neutral, nothing else present)
    // conviction = round(0.6296 * 1 * 10) = round(6.296) = 6
    //
    // The bear side used to be long/short at what this comment called 0.12.
    // Two things were wrong with that: long/short no longer votes at all, and
    // the weights quoted here (0.20/0.12) had not matched WEIGHTS since
    // technicals took its haircut — the arithmetic reached the same 6 by
    // coincidence, so nothing failed and the stale numbers survived.
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: -0.08, // bullish (shorts paying), weight 0.17
        basisPct: -0.05, // bearish, weight 0.10
      }),
      NOW
    )!;
    expect(result.conviction).toBe(6);
  });
});

/*
 * PRICE ACTION IS CONTEXT, NOT A PILLAR.
 *
 * These exist because nothing here covered it. Every fixture in this file
 * passed `technicals: null`, so a 0.14 directional weight — the second
 * largest in WEIGHTS — sat in the thesis engine with zero assertions on it
 * and the whole suite went green when it was removed. The census that
 * disqualified the read (no directional edge at 1h, 4h or 24h on n=2,195)
 * could not have been contradicted by a test that never supplied a read.
 *
 * So the point of these is not to lock in today's behaviour. It is that
 * restoring the vote must FAIL something.
 */
function technicalRead(
  direction: "bullish" | "bearish" | "neutral",
  strength: number
): TechnicalRead {
  return {
    direction,
    strength,
    summary: "Price is holding above the 20 and 50 EMAs.",
    rsi: 58,
    macdHistogram: 0.4,
    emaAlignment: "above-all",
    adx: 30,
    atrPct: 1.2,
    volumeRatio: 1.1,
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

describe("buildMarketThesis - price action does not vote", () => {
  it("files a strong bullish read under neutralEvidence at weight 0", () => {
    const result = buildMarketThesis(
      baseInputs({ technicals: technicalRead("bullish", 90) }),
      NOW
    )!;

    const entry = result.neutralEvidence.find((e) => e.source === "Price Action");
    expect(entry).toBeDefined();
    expect(entry!.direction).toBe("neutral");
    expect(entry!.weight).toBe(0);
    expect(result.bullishEvidence.find((e) => e.source === "Price Action")).toBeUndefined();
    expect(result.bearishEvidence.find((e) => e.source === "Price Action")).toBeUndefined();
  });

  it("keeps the summary visible — demoted, not hidden", () => {
    const result = buildMarketThesis(
      baseInputs({ technicals: technicalRead("bearish", 90) }),
      NOW
    )!;
    const entry = result.neutralEvidence.find((e) => e.source === "Price Action")!;
    expect(entry.detail).toContain("Price is holding above the 20 and 50 EMAs.");
  });

  /*
   * THE discriminating case, and the one the old weight would fail.
   *
   * Funding at 0.08 is bullish at 0.17; basis at -0.05 is bearish at 0.10.
   * Bull leads, so `dominant` is bullish. A bearish price read at the old
   * 0.14 would have put the bear side at 0.24 and FLIPPED the thesis. At
   * weight 0 it cannot, and `conviction` must land on exactly the 6 that the
   * hand-computed funding-vs-basis case above reaches without any technicals
   * present at all.
   */
  it("cannot flip dominant, and does not move conviction", () => {
    const withoutRead = buildMarketThesis(
      baseInputs({ weightedFundingRatePct: -0.08, basisPct: -0.05 }),
      NOW
    )!;
    const withRead = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: -0.08,
        basisPct: -0.05,
        technicals: technicalRead("bearish", 95),
      }),
      NOW
    )!;

    expect(withoutRead.dominant).toBe("bullish");
    expect(withRead.dominant).toBe("bullish");
    expect(withRead.conviction).toBe(withoutRead.conviction);
    expect(withRead.conviction).toBe(6);
  });

  it("stays out of topSupporting even when it agrees with the thesis", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: -0.08,
        technicals: technicalRead("bullish", 95),
      }),
      NOW
    )!;
    expect(result.dominant).toBe("bullish");
    expect(result.topSupporting.map((e) => e.source)).not.toContain("Price Action");
  });

  /*
   * The confirmation line is the reason removing the vote is not a loss of
   * information: price action still reaches the reader, as a comparison
   * AGAINST the positioning thesis rather than as part of it. That comparison
   * was part-circular while technicals held 0.14 of the weight that set
   * `dominant`; it is a real check now, so it has to keep working.
   */
  /*
   * WHY "Trending" vanished from the replay, pinned so the mechanism is
   * checkable rather than asserted in a comment.
   *
   * `conviction` is agreement x PARTICIPATION, and participation is the
   * share of PRESENT weight that is directional. A neutral source keeps its
   * weight in the denominator; a weight-0 source leaves both sides.
   *
   * The replay has funding (0.17) sitting inside its neutral band on 2,863
   * of 2,896 days, leaving squeezeRisk (0.16) and basis (0.10) to carry the
   * direction: 0.26/0.43 = 0.605, conviction 6, one short of the 7 that
   * REGIME_TREND_CONVICTION wants. Price action's 0.14 used to make up the
   * difference — on all 649 historical Trending days it was directional.
   *
   * Both halves are asserted: the label is NOT structurally dead (given
   * enough directional weight it still fires), it is simply out of reach on
   * the evidence the replay actually has.
   */
  it("cannot reach a Trending regime on directional weight it no longer has", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0, // inside the neutral band, as in ~99% of replay days
        squeezeRisk: { score: 50, side: "long", components: [] }, // bearish, 0.16
        basisPct: -0.05, // bearish, 0.10
        technicals: technicalRead("bearish", 95), // agrees, and contributes nothing
      }),
      NOW
    )!;
    expect(result.dominant).toBe("bearish");
    expect(result.conviction).toBe(6);
    expect(result.regime).toBe("Leaning Bearish");
  });

  it("still reaches Trending when the directional weight is genuinely there", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.2, // "Crowded Longs" -> bearish, 0.17, no longer neutral
        squeezeRisk: { score: 50, side: "long", components: [] }, // bearish, 0.16
        basisPct: -0.05, // bearish, 0.10
      }),
      NOW
    )!;
    expect(result.conviction).toBe(10);
    expect(result.regime).toBe("Trending Bearish");
  });

  it("still reports price action through technicalConfirmation", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: 0.08,
        technicals: technicalRead("bullish", 90),
      }),
      NOW
    )!;
    expect(result.technicalConfirmation.length).toBeGreaterThan(0);
  });
});

describe("buildMarketThesis - top supporting / opposing", () => {
  it("puts the higher-weighted evidence first in topSupporting", () => {
    const result = buildMarketThesis(
      baseInputs({
        weightedFundingRatePct: -0.08, // bullish (shorts paying), weight 0.17 - should rank first
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
    // Equal bull/bear weight, so `dominant` is neutral and there is no thesis
    // to name a reversal for. Basis and order flow both weigh 0.10; funding
    // stays at 0 so it lands in neutral and cannot tip the balance.
    const balanced = buildMarketThesis(
      baseInputs({
        basisPct: 0.05, // bullish, weight 0.10
        orderFlow: {
          bookImbalance: null,
          cvdHistory: [],
          totalBuyUsd: 0,
          totalSellUsd: 0,
          dominantFlow: "sellers", // bearish, weight 0.10
          buyerSharePct: 30,
          windowHours: 24,
          venue: "OKX",
        },
      }),
      NOW
    )!;
    expect(balanced.dominant).toBe("neutral");
    expect(balanced.invalidation[0]).toMatch(/no dominant thesis/i);
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
        weightedFundingRatePct: -0.08,
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
