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
import { bandFor, fundingBandVerdict, FUNDING_BANDS, LONG_SHORT_BANDS } from "./bands";
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
 * arithmetic on the weights below and is explicitly NOT a probability. See
 * MarketThesis's own doc comment in types/market.ts for the full framing.
 *
 * ── This paragraph used to end with a false sentence ────────────────────
 *
 * It said "this app has no backtesting infrastructure, so nothing here
 * claims to have been validated against historical outcomes." That was true
 * when written and has not been true for a long time: there is a 2,896-day
 * replay, a module census that grades every signal against its own base
 * rate, and a forward record. The sentence survived because nobody re-read
 * it, and while it survived it did real work — it was the standing excuse
 * for any weight in this file, including a 0.14 on a read the census had
 * already failed. A caveat that exempts a number from evidence is worse
 * than no caveat, once the evidence exists.
 *
 * What IS still true, stated without the alibi: the weights below have
 * never been fitted, and this engine's own record is not the one published
 * on /validation — that is buildMarketBias, the category-weighted engine in
 * lib/signals/. They remain a reading of the board. But every input that
 * CAN be graded is now expected to survive grading in order to hold one.
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
 * bands, and lib/signals/scoring.ts's METRIC_WEIGHTS. Missing sources are
 * dropped and the rest renormalized, the same renormalization rule
 * buildMarketBias uses.
 *
 * These sum to 0.90, not 1.0. The missing 0.10 was `longShort`, removed for
 * the reason documented on EDGE_CLUSTERS in lib/signals/scoring.ts: it and
 * `squeezeRisk` read one input — the long/short ratio — under opposite sign
 * conventions, so a crowded long side was pushing 0.10 bullish here and 0.16
 * bearish there, on every observation where both spoke. That is not two
 * pillars disagreeing; it is one pillar minus itself, netting a 0.06 bear
 * lean nobody chose. Positioning now enters as context (weight 0, the
 * `liquidations` treatment) and the ratio's one directional claim is
 * squeezeRisk's.
 *
 * Not redistributed to the survivors on purpose. Everything renormalizes, so
 * the remaining eight already hold their exact previous ratios to each
 * other; inventing new numbers to reach 1.00 would change eight weights to
 * fix one and imply a recalibration that did not happen.
 *
 * ── `technicals` left too, 2026-09-13, and it sums to 0.76 now ──────────
 *
 * Price action used to hold 0.14 here — the second-largest pillar — with the
 * justification that it was "the only input that describes PRICE rather than
 * POSITIONING." That justification was about COVERAGE, not about accuracy,
 * and it went unexamined until the module census could answer the accuracy
 * question. The census answered it:
 *
 *      horizon   win rate   base rate   edge     p
 *      1h        48.84%     49.99%      -1.15pp  0.290
 *      4h        49.11%     49.93%      -0.82pp  0.455
 *      24h       47.97%     50.04%      -2.07pp  0.056
 *
 * n=2,195 at every horizon. Below the base rate at all three, and the
 * DEEPEST miss is at 24h — the horizon a daily price read is implicitly
 * making a claim about. The correct reading of that table is NOT "price
 * action is a contrarian signal": three horizons were tried, none clears
 * significance, and none of this is corrected for overlap. The defensible
 * conclusion is the weaker one — no evidence of a directional edge — which
 * is exactly what role `state` encodes in lib/signals/scoring.ts, where
 * `technicals` has been non-voting for that reason.
 *
 * So the same read was non-voting in one engine and the second-biggest vote
 * in the other. Two engines, one market, incompatible answers to "may this
 * signal speak?" — the divergence, not the weight, is the defect. Price
 * action now enters the way `longShort` and `liquidations` do: weight 0,
 * direction neutral, still fully displayed.
 *
 * What price action does NOT lose is its place on the card. It moves to
 * `technicalConfirmation`, which asks whether price agrees with the thesis
 * — and which was quietly PART-CIRCULAR while technicals was 0.14 of the
 * thesis it was being checked against. Removing the vote is what makes that
 * comparison mean what it says.
 *
 * The thesis is now a pure positioning read. That is a narrower object than
 * it was, and it is narrower still in the replay, where four of the seven
 * survivors have no historical source: see the note on `technicalEvidence`.
 */
const WEIGHTS = {
  funding: 0.17,
  basis: 0.1,
  coinbasePremium: 0.07,
  orderFlow: 0.1,
  squeezeRisk: 0.16,
  deribitOptions: 0.09,
  exchangeFlow: 0.07,
};

function leanToDirection(lean: Lean): ThesisDirection {
  if (lean === "bullish" || lean === "extreme-bullish") return "bullish";
  if (lean === "bearish" || lean === "extreme-bearish") return "bearish";
  return "neutral";
}

/**
 * Direction comes from `fundingBandVerdict` in ./bands, the one place a funding
 * rate becomes a direction, rather than a copy of it.
 *
 * It WAS a copy — the same five-way label chain, written out again here. Two
 * engines, one convention, two implementations, which is the shape of defect
 * 7.0.0 and 6.0.0 were both about. It had not drifted yet; it simply had no
 * mechanism that would stop it, and the mapping it duplicated turned out to be
 * wrong in a way that then had to be corrected in two places.
 *
 * `ThesisDirection` and `Verdict` are both "bullish" | "bearish" | "neutral",
 * so this is a shared judgement and not a coerced one.
 */
function fundingEvidence(fundingPct: number): ThesisEvidence {
  const band = bandFor(fundingPct, FUNDING_BANDS);
  const direction: ThesisDirection = fundingBandVerdict(fundingPct);

  return {
    source: "Funding Rate",
    direction,
    detail: `Funding at ${fundingPct.toFixed(4)}%/8h — ${band.label}. ${band.description}`,
    weight: WEIGHTS.funding,
  };
}

/**
 * CONTEXT, NOT A PILLAR — direction "neutral" and weight 0, the same shape
 * `liquidationsEvidence` uses, for the reason on WEIGHTS above.
 *
 * The band is still computed and still named in `detail`, so the reader gets
 * the placement exactly as before ("2.50:1 long/short (71% long) — Mostly
 * Longs"). What is gone is the inference from that placement to a direction,
 * which `squeezeRiskEvidence` makes — the other way — off the same ratio.
 */
function longShortEvidence(longShortRatio: number): ThesisEvidence {
  const longPct = (longShortRatio / (longShortRatio + 1)) * 100;
  const band = bandFor(longPct, LONG_SHORT_BANDS);

  return {
    source: "Long/Short Positioning",
    direction: "neutral",
    detail: `${longShortRatio.toFixed(2)}:1 long/short (${longPct.toFixed(0)}% long) — ${band.label}. Describes how the crowd is placed; whether that crowd is about to be forced out is the squeeze read's call.`,
    weight: 0,
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
 * CONTEXT, NOT A PILLAR — direction "neutral" and weight 0, for the reason
 * on WEIGHTS above: the module census finds no directional edge in this read
 * at any horizon it was graded on, and lib/signals/scoring.ts has therefore
 * had it as non-voting role `state` since before this change.
 *
 * ONE combined entry, which was already true and stays true. Eight separate
 * technical entries would let price action outvote every positioning signal
 * on the card by sheer count, and most of those indicators are different
 * views of the same price series, so listing them separately would
 * double-count one piece of information. That argument was about crowding
 * out the card; the census settled the separate question of whether the
 * combined entry should vote at all.
 *
 * The strength gate that used to live here is gone with the direction it
 * gated. It still governs `evaluateTechnicals`, which is where the price row
 * does still call a direction, and it is now exported from there as the one
 * definition — see TECHNICAL_MEANINGFUL_STRENGTH in lib/signals/evaluators.ts.
 *
 * ── What this leaves the thesis with, and where it bites hardest ────────
 *
 * Seven directional sources remain, and FOUR of them are in the replay's
 * `unavailableInputs` list — coinbasePremium, orderFlow, deribitOptions and
 * exchangeFlow have no historical archive, so the census cannot judge them
 * either way. Live, that is 0.33 of 0.76 riding on inputs with no graded
 * record. In the REPLAY those four are null and drop out entirely, which
 * leaves the historical thesis standing on three: funding 0.17, squeezeRisk
 * 0.16, basis 0.10.
 *
 * That is a thin object and it is stated here rather than discovered later.
 * It is not an argument for keeping an unvalidated pillar to pad the count —
 * a thesis that is honest about resting on three inputs beats one that reads
 * broader because a fourth input is present but wrong.
 */
function technicalEvidence(read: TechnicalRead): ThesisEvidence {
  return {
    source: "Price Action",
    direction: "neutral",
    detail: `${read.summary} Shown for context: this read has no measured directional edge (see the census table in this file), so it describes the tape without voting on the thesis — whether it agrees is the confirmation line's call.`,
    weight: 0,
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
/**
 * Conviction at/above this counts as a "Trending" (not just "Leaning") regime.
 *
 * Exported since 2026-09-13 because `tradeRecommendation.ts` needs the same
 * bar: its layer-conflict veto is justified in its own comment as the two
 * layers being in "open disagreement," and the honest reading of "open
 * disagreement" is that the opposing thesis clears the bar at which the
 * thesis calls ITSELF directional. That is this constant — the difference
 * between "Trending Bearish" and "Leaning Bearish" — not a second threshold
 * invented for the gate. One number, one meaning, two consumers.
 */
export const REGIME_TREND_CONVICTION = 7;
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
  // Straight to `neutral`, not through `push` — it is context, and routing it
  // by direction is what let it become a pillar in the first place.
  if (inputs.longShortRatio !== null) neutral.push(longShortEvidence(inputs.longShortRatio));
  if (inputs.basisPct !== null) push(basisEvidence(inputs.basisPct));
  if (inputs.coinbasePremiumPct !== null) push(coinbasePremiumEvidence(inputs.coinbasePremiumPct));
  if (inputs.orderFlow) push(orderFlowEvidence(inputs.orderFlow));
  if (inputs.squeezeRisk) push(squeezeRiskEvidence(inputs.squeezeRisk));
  if (inputs.deribitOptions) push(deribitOptionsEvidence(inputs.deribitOptions));
  if (inputs.exchangeFlow) push(exchangeFlowEvidence(inputs.exchangeFlow));
  // Straight to `neutral` for the same reason as longShort above: it is
  // context, and routing it by direction is what let it become a pillar.
  if (inputs.technicals) neutral.push(technicalEvidence(inputs.technicals));
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
     * NOW genuinely non-circular, which it was not before 2026-09-13.
     *
     * The old comment here claimed independence on the grounds that the
     * technical read "was computed independently of the thesis and fed in as
     * evidence above." Both halves are true and the conclusion still did not
     * follow: `technicals` was 0.14 of the weight that SET `dominant`, so on
     * any day where directional weight was thin, price action could be the
     * vote that decided the thesis and then be reported as confirming it.
     * Independent computation does not buy independence from your own vote.
     *
     * It is weight 0 now, so `dominant` is a pure positioning read and this
     * line is a real comparison against it — the check the phrasing always
     * implied. Ordering still matters for the wording, hence still built last.
     */
    technicalConfirmation: inputs.technicals ? technicalConfirmation(inputs.technicals, dominant) : [],
    updatedAt: now,
  };
}
