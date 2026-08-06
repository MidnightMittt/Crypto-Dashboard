import {
  AssetSymbol,
  ExchangeFlowSummary,
  DeribitOptionsSummary,
  OrderFlowSummary,
  SqueezeRisk,
  LiquidationSummary,
  MarketThesis,
  MarketRegime,
  TechnicalRead,
  ThesisDirection,
  ThesisEvidence,
} from "@/types/market";
import type { RegimeTags } from "@/lib/technicals/regimes";
import { technicalConfirmation } from "./technicals";
import { bandFor, FUNDING_BANDS, LONG_SHORT_BANDS } from "./bands";
import { coinbasePremiumLean, deribitOptionsLean, SQUEEZE_MEANINGFUL_SCORE } from "./leans";
import { Lean } from "@/components/ui/LeanGauge";

/**
 * Cross-indicator synthesis — reads every OTHER already-computed derived
 * signal on this dashboard together, the way an analyst reads a full board
 * rather than one gauge at a time.
 *
 * ── The one rule this whole module follows ──────────────────────────────
 *
 * Every evidence entry cites a REAL number already computed elsewhere in
 * this app (funding rate, squeeze score, order flow share, etc.) — nothing
 * here is a new data source or a re-derived estimate. `conviction` is pure
 * arithmetic on the weights below, explicitly NOT a probability: this app
 * has no backtesting infrastructure, so nothing here claims to have been
 * validated against historical outcomes. See MarketThesis's own doc
 * comment in types/market.ts for the full framing.
 *
 * ── "Fade the extremes" ──────────────────────────────────────────────────
 *
 * Funding and squeeze risk both use a genuinely different rule than "more
 * positive = more bullish": at the EXTREMES, crowded positioning is scored
 * as evidence for the OPPOSITE direction. This isn't invented here —
 * FUNDING_BANDS' own "Crowded Longs" description already says "squeeze
 * risk from a downside shock rises", and squeezeRisk's whole purpose is
 * identifying which side is exposed if positioning unwinds. Treating
 * "longs are crowded" as bearish evidence (not "very bullish") is just
 * taking those existing descriptions at their word.
 */

export interface MarketThesisInputs {
  asset: AssetSymbol | "MARKET";
  /** Daily price-action read. Null for MARKET, which has no single price series. */
  technicals: TechnicalRead | null;
  weightedFundingRatePct: number;
  longShortRatio: number | null;
  basisPct: number | null;
  coinbasePremiumPct: number | null;
  orderFlow: OrderFlowSummary | null;
  squeezeRisk: SqueezeRisk | null;
  deribitOptions: DeribitOptionsSummary | null;
  exchangeFlow: ExchangeFlowSummary | null;
  liquidations: LiquidationSummary | null;
  priceChange24hPct: number;
  leverageHeatScore: number | null;
  /** Live trend/volatility/range-bound classification for TODAY — see MarketThesis.regimeTags's own doc comment for why this is a separate concept from `regime` below. */
  regimeTags: RegimeTags | null;
}

/**
 * Weights are a defensible starting point, not settled science — same
 * framing this app already uses for FUNDING_BANDS, chartLean's flat-price
 * bands, and lib/signals/scoring.ts's METRIC_WEIGHTS. Sum to 1.0 when every
 * source answers; missing sources are dropped and the rest renormalized,
 * the same renormalization rule buildMarketBias uses.
 */
const WEIGHTS = {
  funding: 0.17,
  longShort: 0.1,
  basis: 0.1,
  coinbasePremium: 0.07,
  orderFlow: 0.1,
  squeezeRisk: 0.16,
  deribitOptions: 0.09,
  exchangeFlow: 0.07,
  /*
   * Technicals earn a meaningful share because they're the only input here
   * that describes PRICE rather than POSITIONING — every other source above
   * measures how traders are placed, so without this the thesis can say
   * "longs are crowded" but not whether price action agrees.
   *
   * The other eight took a proportional haircut to make room (funding
   * 0.20 -> 0.17, squeezeRisk 0.18 -> 0.16, and so on) rather than any one
   * source being singled out, preserving their relative ordering exactly.
   * Still sums to 1.00; missing sources renormalize as before.
   */
  technicals: 0.14,
};

function leanToDirection(lean: Lean): ThesisDirection {
  if (lean === "bullish" || lean === "extreme-bullish") return "bullish";
  if (lean === "bearish" || lean === "extreme-bearish") return "bearish";
  return "neutral";
}

function fundingEvidence(fundingPct: number): ThesisEvidence {
  const band = bandFor(fundingPct, FUNDING_BANDS);
  const direction: ThesisDirection =
    band.label === "Crowded Longs"
      ? "bearish"
      : band.label === "Extreme Shorts"
        ? "bullish"
        : band.label === "Bullish"
          ? "bullish"
          : band.label === "Bearish"
            ? "bearish"
            : "neutral";

  return {
    source: "Funding Rate",
    direction,
    detail: `Funding at ${fundingPct.toFixed(4)}%/8h — ${band.label}. ${band.description}`,
    weight: WEIGHTS.funding,
  };
}

function longShortEvidence(longShortRatio: number): ThesisEvidence {
  const longPct = (longShortRatio / (longShortRatio + 1)) * 100;
  const band = bandFor(longPct, LONG_SHORT_BANDS);
  const direction: ThesisDirection =
    band.label === "Mostly Longs" ? "bullish" : band.label === "Mostly Shorts" ? "bearish" : "neutral";

  return {
    source: "Long/Short Positioning",
    direction,
    detail: `${longShortRatio.toFixed(2)}:1 long/short (${longPct.toFixed(0)}% long) — ${band.label}`,
    weight: WEIGHTS.longShort,
  };
}

/** Below this, basis is close enough to zero to be noise, not a lean. */
const BASIS_NEUTRAL_PCT = 0.02;

function basisEvidence(basisPct: number): ThesisEvidence {
  const direction: ThesisDirection =
    Math.abs(basisPct) < BASIS_NEUTRAL_PCT ? "neutral" : basisPct > 0 ? "bullish" : "bearish";
  return {
    source: "Basis vs Spot",
    direction,
    detail: `Perps trade ${basisPct >= 0 ? "above" : "below"} spot by ${Math.abs(basisPct).toFixed(3)}%`,
    weight: WEIGHTS.basis,
  };
}

function coinbasePremiumEvidence(premiumPct: number): ThesisEvidence {
  return {
    source: "Coinbase Premium",
    direction: leanToDirection(coinbasePremiumLean(premiumPct)),
    detail: `Coinbase priced ${premiumPct >= 0 ? "above" : "below"} the broader spot market by ${Math.abs(premiumPct).toFixed(3)}%`,
    weight: WEIGHTS.coinbasePremium,
  };
}

function orderFlowEvidence(flow: OrderFlowSummary): ThesisEvidence {
  const direction: ThesisDirection =
    flow.dominantFlow === "buyers" ? "bullish" : flow.dominantFlow === "sellers" ? "bearish" : "neutral";
  const share = flow.dominantFlow === "buyers" ? flow.buyerSharePct : 100 - flow.buyerSharePct;

  return {
    source: "Order Flow (OKX)",
    direction,
    detail:
      direction === "neutral"
        ? "Aggressive buying and selling roughly balanced on OKX"
        : `${flow.dominantFlow === "buyers" ? "Buyers" : "Sellers"} took ${share.toFixed(0)}% of taker volume on OKX`,
    weight: WEIGHTS.orderFlow,
  };
}

function squeezeRiskEvidence(sr: SqueezeRisk): ThesisEvidence {
  const direction: ThesisDirection =
    sr.side === "balanced" || sr.score < SQUEEZE_MEANINGFUL_SCORE
      ? "neutral"
      : sr.side === "long"
        ? "bearish"
        : "bullish";

  return {
    source: "Squeeze Setup",
    direction,
    detail:
      sr.side === "balanced"
        ? `Squeeze score ${sr.score}/100 — no side clearly exposed`
        : `Squeeze score ${sr.score}/100 — ${sr.side}s are the crowded side, exposed if positioning unwinds`,
    weight: WEIGHTS.squeezeRisk,
  };
}

function deribitOptionsEvidence(opt: DeribitOptionsSummary): ThesisEvidence {
  return {
    source: "Deribit Options",
    direction: leanToDirection(deribitOptionsLean(opt.putCallRatio)),
    detail: `Put/call ratio ${opt.putCallRatio.toFixed(2)} for the ${opt.expiry} expiry`,
    weight: WEIGHTS.deribitOptions,
  };
}

function exchangeFlowEvidence(flow: ExchangeFlowSummary): ThesisEvidence {
  const direction: ThesisDirection =
    flow.direction === "inflow" ? "bearish" : flow.direction === "outflow" ? "bullish" : "neutral";

  return {
    source: "Exchange Flow",
    direction,
    detail:
      flow.direction === "balanced"
        ? "Tracked exchange wallet balance roughly flat"
        : `${flow.netflowNative >= 0 ? "+" : ""}${flow.netflowNative.toFixed(2)} ${flow.asset} moved ${flow.direction === "inflow" ? "into" : "out of"} the tracked exchange wallet`,
    weight: WEIGHTS.exchangeFlow,
  };
}

/**
 * ONE combined entry for all of price action, not one per indicator.
 *
 * Eight separate technical entries would let price action outvote every
 * positioning signal on the card by sheer count — inverting the point of
 * this dashboard, whose subject is derivatives positioning. Most of those
 * indicators are also different views of the same price series, so listing
 * them separately would double-count a single piece of information.
 *
 * A weak technical read (`strength` under this floor) is reported as
 * neutral rather than as a faint directional lean, so noise in a ranging
 * market doesn't quietly tilt the thesis.
 */
const TECHNICAL_MEANINGFUL_STRENGTH = 20;

function technicalEvidence(read: TechnicalRead): ThesisEvidence {
  const direction: ThesisDirection =
    read.strength < TECHNICAL_MEANINGFUL_STRENGTH ? "neutral" : read.direction;

  return {
    source: "Price Action",
    direction,
    detail: read.summary,
    weight: WEIGHTS.technicals,
  };
}

/**
 * Always neutral — liquidations describe what already happened, not a
 * lean on what's next (see LiquidationSummary's own doc comment). Weight
 * 0 so it's shown for context without contributing to conviction math.
 */
function liquidationsEvidence(liq: LiquidationSummary): ThesisEvidence {
  return {
    source: "Liquidations",
    direction: "neutral",
    detail:
      liq.dominantSide === "balanced"
        ? "Liquidations roughly balanced between longs and shorts"
        : `${liq.dominantSide === "long" ? "Longs" : "Shorts"} bore most of the forced closes — describes what already happened, not what's next`,
    weight: 0,
  };
}

function convictionLabel(conviction: number): string {
  if (conviction >= 8) return "Strong Agreement";
  if (conviction >= 5) return "Moderate Agreement";
  if (conviction >= 2) return "Weak / Mixed";
  return "No Clear Signal";
}

/** Squeeze score at/above this, with a clear side, overrides trend-based regime labeling. */
const REGIME_SQUEEZE_THRESHOLD = 70;
/** Conviction at/above this counts as a "Trending" (not just "Leaning") regime. */
const REGIME_TREND_CONVICTION = 7;
/** Conviction at/below this counts as genuinely mixed rather than a soft lean. */
const REGIME_MIXED_CONVICTION = 2;
/** Below this heat AND this price move, the market reads as quiet rather than mixed. */
const REGIME_QUIET_HEAT = 30;
const REGIME_QUIET_PRICE_PCT = 2;

export function classifyRegime(ctx: {
  conviction: number;
  dominant: ThesisDirection;
  squeezeRisk: SqueezeRisk | null;
  leverageHeatScore: number | null;
  priceChange24hPct: number;
}): { label: MarketRegime; description: string } {
  if (
    ctx.squeezeRisk &&
    ctx.squeezeRisk.side !== "balanced" &&
    ctx.squeezeRisk.score >= REGIME_SQUEEZE_THRESHOLD
  ) {
    const side = ctx.squeezeRisk.side === "long" ? "Longs" : "Shorts";
    return {
      label: ctx.squeezeRisk.side === "long" ? "Squeeze Setup — Longs Exposed" : "Squeeze Setup — Shorts Exposed",
      description: `${side} are the crowded, exposed side (squeeze score ${ctx.squeezeRisk.score}/100) — conditions that have historically preceded a forced unwind are present. This describes setup conditions, not a timed prediction.`,
    };
  }

  if (ctx.conviction >= REGIME_TREND_CONVICTION && ctx.dominant !== "neutral") {
    return {
      label: ctx.dominant === "bullish" ? "Trending Bullish" : "Trending Bearish",
      description: "Most of the weighted evidence points the same direction with little disagreement.",
    };
  }

  /*
   * Checked BEFORE the generic low-conviction fallback below: when
   * conviction is low BECAUSE the market is genuinely quiet (flat price,
   * cold leverage), "Consolidation" is a more specific and useful
   * diagnosis than a bare "Mixed / Low Conviction" — it tells you WHY,
   * not just THAT. Low conviction from actual conflicting evidence still
   * falls through to the generic label below.
   */
  if ((ctx.leverageHeatScore ?? 50) < REGIME_QUIET_HEAT && Math.abs(ctx.priceChange24hPct) < REGIME_QUIET_PRICE_PCT) {
    return {
      label: "Consolidation",
      description: "Price and leverage are both quiet — no active setup building either way.",
    };
  }

  /*
   * "Mixed / Low Conviction" is reserved STRICTLY for the genuine tie
   * (dominant === "neutral", i.e. bullWeight === bearWeight exactly) —
   * never used as a catch-all for "conviction happens to be low," which
   * usually just means most evidence is neutral/inactive, with a real but
   * thin lean in whatever's left. Low conviction and no lean are different
   * facts; conflating them into one vague label is exactly the dead-end
   * "signals are mixed" phrasing this app no longer allows.
   */
  if (ctx.dominant === "neutral") {
    return {
      label: "Mixed / Low Conviction",
      description: "Neither side currently has more supporting evidence than the other — a genuinely flat read, not a close call.",
    };
  }

  return {
    label: ctx.dominant === "bullish" ? "Leaning Bullish" : "Leaning Bearish",
    description:
      ctx.conviction <= REGIME_MIXED_CONVICTION
        ? `More evidence leans ${ctx.dominant}, but most signals are neutral or inactive right now, so conviction is thin.`
        : "More weighted evidence on one side than the other, but not by an overwhelming margin.",
  };
}

function buildInvalidation(topSupporting: ThesisEvidence[], dominant: ThesisDirection): string[] {
  if (topSupporting.length === 0 || dominant === "neutral") {
    return ["No dominant thesis is currently in place — there's nothing specific to invalidate."];
  }
  const opposite = dominant === "bullish" ? "bearish" : "bullish";
  return topSupporting
    .slice(0, 3)
    .map((e) => `${e.source} reversing to ${opposite} would remove one of the strongest pillars of this read (currently: ${e.detail}).`);
}

export function buildMarketThesis(inputs: MarketThesisInputs, now: number): MarketThesis | null {
  const bullish: ThesisEvidence[] = [];
  const bearish: ThesisEvidence[] = [];
  const neutral: ThesisEvidence[] = [];

  const push = (e: ThesisEvidence) => {
    if (e.direction === "bullish") bullish.push(e);
    else if (e.direction === "bearish") bearish.push(e);
    else neutral.push(e);
  };

  push(fundingEvidence(inputs.weightedFundingRatePct));
  if (inputs.longShortRatio !== null) push(longShortEvidence(inputs.longShortRatio));
  if (inputs.basisPct !== null) push(basisEvidence(inputs.basisPct));
  if (inputs.coinbasePremiumPct !== null) push(coinbasePremiumEvidence(inputs.coinbasePremiumPct));
  if (inputs.orderFlow) push(orderFlowEvidence(inputs.orderFlow));
  if (inputs.squeezeRisk) push(squeezeRiskEvidence(inputs.squeezeRisk));
  if (inputs.deribitOptions) push(deribitOptionsEvidence(inputs.deribitOptions));
  if (inputs.exchangeFlow) push(exchangeFlowEvidence(inputs.exchangeFlow));
  if (inputs.technicals) push(technicalEvidence(inputs.technicals));
  if (inputs.liquidations) neutral.push(liquidationsEvidence(inputs.liquidations));

  if (bullish.length === 0 && bearish.length === 0 && neutral.length === 0) return null;

  const bullWeight = bullish.reduce((s, e) => s + e.weight, 0);
  const bearWeight = bearish.reduce((s, e) => s + e.weight, 0);
  const neutralWeight = neutral.reduce((s, e) => s + e.weight, 0);
  const directionalWeight = bullWeight + bearWeight;
  const totalWeight = directionalWeight + neutralWeight;

  /*
   * conviction = agreement (how lopsided bull vs bear is) x participation
   * (how much of the total weight is directional at all, vs. neutral).
   * All bullish, zero neutral -> 10. Evenly split -> ~5 x participation.
   * All neutral -> 0. Pure arithmetic on weights already on this
   * dashboard — not a calibrated statistic.
   */
  const agreementRatio = directionalWeight > 0 ? Math.max(bullWeight, bearWeight) / directionalWeight : 0.5;
  const participationRatio = totalWeight > 0 ? directionalWeight / totalWeight : 0;
  const conviction = Math.round(agreementRatio * participationRatio * 10);

  const dominant: ThesisDirection =
    bullWeight > bearWeight ? "bullish" : bearWeight > bullWeight ? "bearish" : "neutral";

  const supportingPool = dominant === "bullish" ? bullish : dominant === "bearish" ? bearish : [];
  const opposingPool = dominant === "bullish" ? bearish : dominant === "bearish" ? bullish : [];

  const topSupporting = [...supportingPool].sort((a, b) => b.weight - a.weight).slice(0, 5);
  const topOpposing = [...opposingPool].sort((a, b) => b.weight - a.weight).slice(0, 5);

  const regime = classifyRegime({
    conviction,
    dominant,
    squeezeRisk: inputs.squeezeRisk,
    leverageHeatScore: inputs.leverageHeatScore,
    priceChange24hPct: inputs.priceChange24hPct,
  });

  return {
    asset: inputs.asset,
    regime: regime.label,
    regimeDescription: regime.description,
    regimeTags: inputs.regimeTags,
    dominant,
    bullishEvidence: bullish,
    bearishEvidence: bearish,
    neutralEvidence: neutral,
    conviction,
    convictionLabel: convictionLabel(conviction),
    topSupporting,
    topOpposing,
    invalidation: buildInvalidation(topSupporting, dominant),
    /*
     * Built here, AFTER `dominant` is known, which is what keeps this
     * non-circular: the technical read itself was computed independently of
     * the thesis and fed in as evidence above; only the PHRASING of these
     * lines depends on the thesis it's being compared against.
     */
    technicalConfirmation: inputs.technicals ? technicalConfirmation(inputs.technicals, dominant) : [],
    updatedAt: now,
  };
}
