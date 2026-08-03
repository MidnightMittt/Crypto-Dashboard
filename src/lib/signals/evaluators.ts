import { AggregateMarketData, FearGreed, TechnicalRead } from "@/types/market";
import type { StablecoinSummary } from "../providers/stablecoins";
import { MetricVerdict, Verdict } from "./types";
import { agreementOf, describeConfidence, scoreConfidence } from "./confidence";
import { bandFor, bandTrigger, FUNDING_BANDS, LONG_SHORT_BANDS } from "../sentiment/bands";
import type { SentimentBand } from "@/types/market";
import { coinbasePremiumLean, deribitOptionsLean, stablecoinFlowLean } from "../sentiment/leans";
import { squeezeLean } from "../sentiment/leans";
import { DOMINANT_SHARE_HIGH, DOMINANT_SHARE_LOW } from "../sentiment/orderFlow";
import { Lean } from "@/components/ui/LeanGauge";

/**
 * One evaluator per metric, each answering the dashboard's single question:
 * bullish, bearish, or neutral — and why.
 *
 * ── The rule that makes these different from a threshold table ─────────
 *
 * A metric is never classified on its own number alone. Each evaluator
 * receives `SignalContext` — price action, the metric's own historical
 * percentile, and the readings of RELATED metrics — and uses it to decide
 * whether the raw value actually means what it appears to. The same funding
 * rate is a different signal in a trending market than in a range, and
 * saying so is the entire point of this layer.
 *
 * When context contradicts the headline reading, that goes in `conflicts`
 * and drags confidence down rather than being silently resolved.
 *
 * Existing logic is REUSED, never reimplemented: bands.ts, leans.ts, and
 * the sentiment/* summaries already encode this app's judgment calls, and
 * duplicating them here would let the cards and the engine drift apart.
 */

export interface SignalContext {
  technicals: TechnicalRead | null;
  stablecoins: StablecoinSummary | null;
  fearGreed: FearGreed | null;
  /** Price change over 24h, used to test whether positioning is being confirmed by price. */
  priceChange24hPct: number;
  now: number;
}

/**
 * Renders a band's own boundaries as a "watch this level" sentence.
 *
 * `fmt` receives the raw threshold so each metric can attach its own units
 * (%/8h, bps, a ratio) without this helper knowing about any of them.
 * Values come straight from the band table, never from a literal typed into
 * a sentence, so they cannot drift from the verdict logic.
 */
function triggerFromBands(value: number, bands: SentimentBand[], fmt: (n: number) => string): string | null {
  const t = bandTrigger(value, bands);
  const parts: string[] = [];
  if (t.above) parts.push(`${t.above.label} above ${fmt(t.above.threshold)}`);
  if (t.below) parts.push(`${t.below.label} below ${fmt(t.below.threshold)}`);
  if (parts.length === 0) return null;
  return `Currently ${t.current.label} — turns ${parts.join("; ")}.`;
}

function leanToVerdict(lean: Lean): Verdict {
  if (lean === "bullish" || lean === "extreme-bullish") return "bullish";
  if (lean === "bearish" || lean === "extreme-bearish") return "bearish";
  return "neutral";
}

/** Direction price action is pointing, or null when there's no technical read. */
function priceActionVerdict(ctx: SignalContext): Verdict | null {
  return ctx.technicals ? ctx.technicals.direction : null;
}

/**
 * Shared helper: does price action agree with this verdict? Returns a
 * conflict line when it clearly doesn't. Used by every evaluator whose
 * metric is about positioning, because positioning that price is already
 * moving against means something different from positioning it confirms.
 */
function priceActionConflict(verdict: Verdict, ctx: SignalContext, metricLabel: string): string[] {
  const pa = priceActionVerdict(ctx);
  if (!pa || pa === "neutral" || verdict === "neutral" || pa === verdict) return [];
  return [`Price action currently leans ${pa}, against this ${metricLabel.toLowerCase()} read.`];
}

// ── Funding ────────────────────────────────────────────────────────────

function evaluateFunding(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const pct = data.weightedFundingRatePct;
  const band = bandFor(pct, FUNDING_BANDS);

  /*
   * Fade the extremes, matching marketThesis.ts: crowded longs are BEARISH
   * evidence, not doubly bullish. FUNDING_BANDS' own descriptions already
   * frame it that way; this reads them at their word.
   */
  const verdict: Verdict =
    band.label === "Crowded Longs"
      ? "bearish"
      : band.label === "Extreme Shorts"
        ? "bullish"
        : band.label === "Bullish"
          ? "bullish"
          : band.label === "Bearish"
            ? "bearish"
            : "neutral";

  const conflicts = priceActionConflict(verdict, ctx, "funding");

  /*
   * Cross-venue agreement is real evidence here, not a proxy: funding is
   * aggregated across venues, so when they disperse widely the headline
   * average describes no single market well.
   */
  const venueCount = data.exchanges.length;
  const dispersionBps = data.fundingDivergence?.dispersionBps ?? null;
  const venueAgreement =
    dispersionBps === null ? 0.7 : dispersionBps < 1 ? 1 : dispersionBps < 3 ? 0.8 : 0.5;

  const completeness = Math.min(1, venueCount / 10);
  const agreement = conflicts.length ? venueAgreement * 0.6 : venueAgreement;
  const inputs = { completeness, agreement, backtested: false };

  const extreme = band.label === "Crowded Longs" || band.label === "Extreme Shorts";

  return {
    id: "funding",
    label: "Funding Rate",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: extreme
      ? `Funding at ${pct.toFixed(4)}%/8h is ${band.label.toLowerCase()} — the crowded side pays to stay in, and is the side exposed if positioning unwinds.`
      : `Funding at ${pct.toFixed(4)}%/8h sits in the ${band.label.toLowerCase()} band across ${venueCount} venues.`,
    whyItMatters:
      "Funding is the running cost of holding leverage, so it shows which side is paying to keep its position — and which side gets forced out first.",
    asOf: data.updatedAt,
    conflicts,
    nextTrigger: triggerFromBands(pct, FUNDING_BANDS, (n) => `${n}%/8h`),
  };
}

// ── Open interest ──────────────────────────────────────────────────────

function evaluateOpenInterest(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const change = data.oiChange24hPct;
  if (change === null) return null;

  /*
   * OI has NO direction of its own — it counts open positions without
   * saying whose. Direction comes only from pairing it with price, which
   * is the classic four-quadrant read:
   *
   *   OI up   + price up   -> new longs, trend has fuel        (bullish)
   *   OI up   + price down -> new shorts, trend has fuel       (bearish)
   *   OI down + price up   -> shorts covering, not fresh demand (weak bullish -> neutral)
   *   OI down + price down -> longs capitulating, deleveraging  (weak bearish -> neutral)
   *
   * Classifying OI by its own magnitude alone, with no price context,
   * would be exactly the fixed-threshold mistake this layer exists to
   * avoid.
   */
  const price = ctx.priceChange24hPct;
  const oiRising = change > 2;
  const oiFalling = change < -2;
  const priceUp = price > 0.5;
  const priceDown = price < -0.5;

  let verdict: Verdict = "neutral";
  let reading: string;

  if (oiRising && priceUp) {
    verdict = "bullish";
    reading = "new long positions opening into a rising price — the move has fresh capital behind it";
  } else if (oiRising && priceDown) {
    verdict = "bearish";
    reading = "new short positions opening into a falling price — the move has fresh capital behind it";
  } else if (oiFalling && priceUp) {
    reading = "open interest falling while price rises — shorts covering rather than new buyers arriving, which tends to fade";
  } else if (oiFalling && priceDown) {
    reading = "open interest falling with price — positions being closed out, a deleveraging rather than a directional bet";
  } else {
    // Phrased so it doesn't restate the "up X% / down X%" already in the
    // sentence prefix below.
    reading = "neither is moving enough to say leverage is meaningfully building or unwinding";
  }

  const completeness = data.oiPercentile !== null ? 1 : 0.7;
  const inputs = { completeness, agreement: verdict === "neutral" ? 0.5 : 0.85, backtested: false };

  return {
    id: "openInterest",
    label: "Open Interest",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `Open interest ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% over 24h with price ${price >= 0 ? "up" : "down"} ${Math.abs(price).toFixed(1)}% — ${reading}.`,
    whyItMatters:
      "Open interest is how much leverage is riding on the market. Read against price it separates a move backed by new money from one that is just positions closing.",
    asOf: data.updatedAt,
    conflicts: [],
    // The +/-2% OI and +/-0.5% price cutoffs above are what actually switch
    // this verdict, so they are the levels quoted.
    nextTrigger:
      "Turns directional once open interest moves more than 2% in 24h while price moves more than 0.5% — the sign of both together decides which way.",
  };
}

// ── Squeeze risk ───────────────────────────────────────────────────────

function evaluateSqueeze(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const sr = data.squeezeRisk;
  if (!sr) return null;

  const verdict = leanToVerdict(squeezeLean(sr.score, sr.side));

  /*
   * This is the one metric with genuine backtest coverage, so it is
   * allowed to exceed the unbacktested confidence ceiling — see
   * confidence.ts.
   */
  const inputs = {
    completeness: Math.min(1, sr.components.length / 4),
    agreement: sr.side === "balanced" ? 0.4 : 0.9,
    backtested: true,
  };

  const conflicts: string[] = [];
  const pa = priceActionVerdict(ctx);
  if (pa && pa !== "neutral" && verdict !== "neutral" && pa !== verdict) {
    conflicts.push(
      `Price action leans ${pa} — the crowded side is not yet under pressure, so this setup may not have triggered.`
    );
  }

  return {
    id: "squeezeRisk",
    label: "Squeeze Setup",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation:
      sr.side === "balanced"
        ? `Squeeze score ${sr.score}/100 with no side clearly crowded — nothing obviously primed to be forced out.`
        : `Squeeze score ${sr.score}/100 with ${sr.side}s crowded, so an unwind would push price ${sr.side === "long" ? "down" : "up"}.`,
    whyItMatters:
      "Forced liquidations move price faster than any deliberate buying or selling. This scores how much fuel is stacked on one side.",
    asOf: data.updatedAt,
    conflicts,
    // SQUEEZE_MEANINGFUL_SCORE (40) and the 70 extreme line in leans.ts are
    // the thresholds squeezeLean actually switches on.
    nextTrigger:
      sr.side === "balanced"
        ? "Stays neutral until funding and long/short agree on a crowded side."
        : `Score ${sr.score}/100 — drops to neutral below 40, and reads as an extreme setup at 70 or above.`,
  };
}

// ── Long/short positioning ─────────────────────────────────────────────

function evaluateLongShort(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const ratio = data.longShortRatio;
  if (ratio === null) return null;

  const longPct = (ratio / (ratio + 1)) * 100;
  const band = bandFor(longPct, LONG_SHORT_BANDS);
  const verdict: Verdict =
    band.label === "Mostly Longs" ? "bullish" : band.label === "Mostly Shorts" ? "bearish" : "neutral";

  const conflicts = priceActionConflict(verdict, ctx, "positioning");
  const inputs = { completeness: 0.8, agreement: conflicts.length ? 0.5 : 0.85, backtested: false };

  return {
    id: "longShort",
    label: "Long/Short Positioning",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `${ratio.toFixed(2)}:1 long/short (${longPct.toFixed(0)}% long) — ${band.label.toLowerCase()}.`,
    nextTrigger: triggerFromBands(longPct, LONG_SHORT_BANDS, (n) => `${n}% long`),
    whyItMatters:
      "Shows how the crowd is actually placed. Heavily one-sided positioning is what makes a market vulnerable to a move in the other direction.",
    asOf: data.updatedAt,
    conflicts,
  };
}

// ── Basis ──────────────────────────────────────────────────────────────

export const BASIS_NEUTRAL_PCT = 0.02;

function evaluateBasis(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const basis = data.basisPct;
  if (basis === null) return null;

  const verdict: Verdict =
    Math.abs(basis) < BASIS_NEUTRAL_PCT ? "neutral" : basis > 0 ? "bullish" : "bearish";
  const conflicts = priceActionConflict(verdict, ctx, "basis");

  const inputs = {
    completeness: data.spotSourceCount >= 2 ? 1 : 0.6,
    agreement: (data.spotDisagreementPct ?? 0) < 0.5 ? 0.9 : 0.6,
    backtested: false,
  };

  return {
    id: "basis",
    label: "Basis vs Spot",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `Perps trade ${basis >= 0 ? "above" : "below"} spot by ${Math.abs(basis).toFixed(3)}% — ${basis >= 0 ? "leveraged demand is paying up for exposure" : "perps are discounted to spot, a sign of hedging or unwind pressure"}.`,
    whyItMatters:
      "The gap between perp and spot prices shows what leveraged traders will pay over owning the asset outright.",
    asOf: data.updatedAt,
    conflicts,
    nextTrigger: `Reads as neutral inside +/-${BASIS_NEUTRAL_PCT}% — bullish above, bearish below (currently ${basis.toFixed(3)}%).`,
  };
}

// ── Order flow (CVD + book imbalance) ──────────────────────────────────

function evaluateOrderFlow(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const flow = data.orderFlow;
  if (!flow) return null;

  const verdict: Verdict =
    flow.dominantFlow === "buyers" ? "bullish" : flow.dominantFlow === "sellers" ? "bearish" : "neutral";

  /*
   * Taker flow and resting book depth are genuinely independent views of
   * the same question, so when they disagree that is real evidence of
   * uncertainty rather than noise to average away.
   */
  const bookVerdict: Verdict = flow.bookImbalance
    ? flow.bookImbalance.imbalancePct > 5
      ? "bullish"
      : flow.bookImbalance.imbalancePct < -5
        ? "bearish"
        : "neutral"
    : "neutral";

  const conflicts: string[] = [];
  if (flow.bookImbalance && bookVerdict !== "neutral" && verdict !== "neutral" && bookVerdict !== verdict) {
    conflicts.push(
      `Resting order book leans ${bookVerdict} while executed flow leans ${verdict} — passive and aggressive traders disagree.`
    );
  }
  conflicts.push(...priceActionConflict(verdict, ctx, "order flow"));

  const inputs = {
    completeness: flow.bookImbalance ? 1 : 0.6,
    agreement: agreementOf([verdict, bookVerdict, priceActionVerdict(ctx) ?? "neutral"]),
    backtested: false,
  };

  const share = flow.dominantFlow === "buyers" ? flow.buyerSharePct : 100 - flow.buyerSharePct;

  return {
    id: "orderFlow",
    label: "Order Flow",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation:
      verdict === "neutral"
        ? `Aggressive buying and selling are near balanced on ${flow.venue} over ${flow.windowHours}h.`
        : `${flow.dominantFlow === "buyers" ? "Buyers" : "Sellers"} took ${share.toFixed(0)}% of taker volume on ${flow.venue} over ${flow.windowHours}h.`,
    whyItMatters:
      "Taker flow is who is willing to cross the spread to get filled — the most direct measure of urgency on either side.",
    asOf: data.updatedAt,
    conflicts,
    // DOMINANT_SHARE_LOW/HIGH are the same constants summarizeOrderFlow
    // switches on, imported rather than retyped so they cannot drift.
    nextTrigger: `Buyers currently ${flow.buyerSharePct.toFixed(0)}% of taker volume — turns bullish at ${DOMINANT_SHARE_HIGH}% or above, bearish at ${DOMINANT_SHARE_LOW}% or below.`,
  };
}

// ── Liquidations ───────────────────────────────────────────────────────

function evaluateLiquidations(data: AggregateMarketData): MetricVerdict | null {
  const liq = data.liquidations;
  if (!liq) return null;

  /*
   * Deliberately always neutral. Liquidations are the only backward-looking
   * metric here — they describe positions already forced out, not a lean on
   * what happens next. LiquidationSummary's own doc comment says so, and
   * marketThesis.ts gives it weight 0 for the same reason. Showing it with
   * a direction would imply a predictive claim it cannot support.
   */
  const inputs = { completeness: Math.min(1, liq.venues.length / 3), agreement: 0.5, backtested: false };

  return {
    id: "liquidations",
    label: "Liquidations",
    verdict: "neutral",
    confidence: scoreConfidence(inputs),
    confidenceBasis: `${describeConfidence(inputs)} Reported as context only — this metric describes what already happened.`,
    explanation:
      liq.dominantSide === "balanced"
        ? `Liquidations over ${liq.windowHours}h were roughly balanced between longs and shorts.`
        : `${liq.dominantSide === "long" ? "Longs" : "Shorts"} bore ${liq.dominantSide === "long" ? liq.longSharePct.toFixed(0) : (100 - liq.longSharePct).toFixed(0)}% of forced closes over ${liq.windowHours}h.`,
    whyItMatters:
      "Shows which side has already been flushed out. Backward-looking by nature, so it explains the move that happened rather than predicting the next one.",
    asOf: data.updatedAt,
    conflicts: [],
    // Deliberately null: this metric never takes a direction, so there is no
    // level at which it would flip. Inventing one would imply it predicts.
    nextTrigger: null,
  };
}

// ── Options put/call ───────────────────────────────────────────────────

function evaluateOptions(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const opt = data.deribitOptions;
  if (!opt) return null;

  const verdict = leanToVerdict(deribitOptionsLean(opt.putCallRatio));
  const conflicts = priceActionConflict(verdict, ctx, "options positioning");
  const inputs = { completeness: 0.9, agreement: conflicts.length ? 0.55 : 0.85, backtested: false };

  return {
    id: "options",
    label: "Options Put/Call",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `Put/call ratio ${opt.putCallRatio.toFixed(2)} on the ${opt.expiry} expiry — ${opt.putCallRatio > 1.2 ? "more puts open than calls, skewed toward downside protection" : opt.putCallRatio < 0.8 ? "more calls open than puts, skewed toward upside bets" : "puts and calls roughly balanced"}.`,
    whyItMatters:
      "Options positioning shows what traders are paying to hedge against, which often diverges from what they say in spot markets.",
    asOf: data.updatedAt,
    conflicts,
    // 0.8 / 1.2 are deribitOptionsLean's own neutral boundaries.
    nextTrigger: `Put/call ${opt.putCallRatio.toFixed(2)} — turns bullish below 0.80, bearish above 1.20.`,
  };
}

// ── Exchange netflow (also carries the whale-activity read) ────────────

function evaluateExchangeFlow(data: AggregateMarketData): MetricVerdict | null {
  const flow = data.exchangeFlow;
  if (!flow) return null;

  const verdict: Verdict =
    flow.direction === "inflow" ? "bearish" : flow.direction === "outflow" ? "bullish" : "neutral";

  const inputs = {
    completeness: Math.min(1, flow.trackedAddressCount / 5),
    agreement: flow.direction === "balanced" ? 0.5 : 0.8,
    backtested: false,
  };

  return {
    id: "exchangeFlow",
    label: "Exchange Netflow",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: `${describeConfidence(inputs)} Covers ${flow.trackedAddressCount} tracked wallets across ${flow.venues.join(", ")}.`,
    // windowHours is a raw elapsed figure (e.g. 23.13620361111111), so it
    // must be rounded before it reaches a sentence.
    explanation:
      flow.direction === "balanced"
        ? `Tracked exchange wallet balances are roughly flat over ${flow.windowHours.toFixed(0)}h.`
        : `${Math.abs(flow.netflowNative).toFixed(2)} ${flow.asset} moved ${flow.direction === "inflow" ? "onto" : "off"} exchanges over ${flow.windowHours.toFixed(0)}h — ${flow.direction === "inflow" ? "coins arriving on exchanges usually precede selling" : "coins leaving usually means accumulation into cold storage"}.`,
    /*
     * This doubles as the dashboard's whale read. Large on-chain transfers
     * to and from exchanges ARE whale activity in the only sense that
     * affects price, and no free source for a standalone whale feed proved
     * usable — so this is stated rather than a separate card being invented
     * from the same underlying data.
     */
    whyItMatters:
      "Large transfers on and off exchanges are the clearest on-chain whale signal available: coins moving onto an exchange are usually being positioned to sell, coins leaving are usually being held.",
    asOf: data.updatedAt,
    conflicts: [],
    nextTrigger: `Flips as soon as the tracked wallet balance turns the other way — currently ${flow.direction}.`,
  };
}

// ── Coinbase premium ───────────────────────────────────────────────────

function evaluateCoinbasePremium(data: AggregateMarketData): MetricVerdict | null {
  const premium = data.coinbasePremiumPct;
  if (premium === null) return null;

  const verdict = leanToVerdict(coinbasePremiumLean(premium));
  const inputs = { completeness: 0.8, agreement: 0.8, backtested: false };

  return {
    id: "coinbasePremium",
    label: "Coinbase Premium",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `Coinbase is priced ${premium >= 0 ? "above" : "below"} the broader spot market by ${Math.abs(premium).toFixed(3)}% — ${premium >= 0 ? "US buyers bidding more aggressively than the rest of the market" : "US flow lagging the rest of the market"}.`,
    whyItMatters:
      "Coinbase is the main US on-ramp, so a persistent premium or discount there is the cleanest read on American demand specifically.",
    asOf: data.updatedAt,
    conflicts: [],
    // coinbasePremiumLean's own boundaries: +/-0.03 to lean, +/-0.15 for extreme.
    nextTrigger: `Premium ${premium.toFixed(3)}% — leans bullish above +0.03%, bearish below -0.03%, extreme past +/-0.15%.`,
  };
}

// ── Technicals / price action ──────────────────────────────────────────

function evaluateTechnicals(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const t = ctx.technicals;
  if (!t) return null;

  // A weak read is reported as neutral rather than a faint lean, matching
  // marketThesis.ts's TECHNICAL_MEANINGFUL_STRENGTH gate.
  const verdict: Verdict = t.strength < 20 ? "neutral" : t.direction;

  const inputs = {
    completeness: t.adx !== null && t.rsi !== null && t.emaAlignment !== null ? 1 : 0.6,
    agreement: t.strength / 100,
    backtested: false,
  };

  const conflicts: string[] = [];
  if (t.adx !== null && t.adx < 20) {
    conflicts.push(
      `Trend strength is weak (ADX ${t.adx.toFixed(0)}), so directional signals here tend to mean-revert rather than follow through.`
    );
  }

  return {
    id: "technicals",
    label: "Price Action",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: t.summary,
    whyItMatters:
      "Every other metric here measures positioning. This is the only one measuring what price itself is actually doing.",
    asOf: data.updatedAt,
    conflicts,
    nextTrigger: `Strength ${t.strength}/100 — below 20 this reports neutral regardless of direction; ADX above 25 would make the trend read carry full weight.`,
  };
}

// ── Stablecoin supply ──────────────────────────────────────────────────

function evaluateStablecoins(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const s = ctx.stablecoins;
  if (!s || !Number.isFinite(s.netChange7dPct)) return null;

  const verdict = leanToVerdict(stablecoinFlowLean(s.netChange7dPct));
  const inputs = { completeness: 0.9, agreement: 0.8, backtested: false };

  return {
    id: "stablecoins",
    label: "Stablecoin Supply",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `Stablecoin supply ${s.netChange7dPct >= 0 ? "grew" : "shrank"} ${Math.abs(s.netChange7dPct).toFixed(2)}% over 7 days — ${s.netChange7dPct >= 0 ? "fresh capital entering crypto as dry powder" : "capital leaving the ecosystem entirely"}.`,
    whyItMatters:
      "Stablecoins are the buying power waiting on the sidelines. Supply growing means money has arrived and not yet been deployed.",
    asOf: data.updatedAt,
    conflicts: [],
    // stablecoinFlowLean's own boundaries: +/-0.2% to lean, +/-1% for extreme.
    nextTrigger: `7-day supply change ${s.netChange7dPct.toFixed(2)}% — leans bullish above +0.2%, bearish below -0.2%.`,
  };
}

// ── Fear & Greed ───────────────────────────────────────────────────────

/** Beyond these, sentiment is treated as a contrarian signal rather than a trend read. */
export const FEAR_GREED_EXTREME_GREED = 75;
export const FEAR_GREED_EXTREME_FEAR = 25;

function evaluateFearGreed(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const fg = ctx.fearGreed;
  if (!fg || !Number.isFinite(fg.value)) return null;

  /*
   * Read as a CONTRARIAN indicator at the extremes — the same "fade the
   * crowd" rule funding and squeeze risk already follow in this codebase.
   * Extreme greed marks the point where buyers are already all-in and there
   * is little marginal demand left; extreme fear marks the opposite. In the
   * middle of the range it carries no directional information at all, so it
   * reports neutral rather than a faint lean.
   */
  const verdict: Verdict =
    fg.value >= FEAR_GREED_EXTREME_GREED
      ? "bearish"
      : fg.value <= FEAR_GREED_EXTREME_FEAR
        ? "bullish"
        : "neutral";

  const inputs = { completeness: 1, agreement: verdict === "neutral" ? 0.5 : 0.7, backtested: false };

  return {
    id: "fearGreed",
    label: "Fear & Greed",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: `${describeConfidence(inputs)} Read contrarian at the extremes, not as a trend signal.`,
    explanation:
      verdict === "neutral"
        ? `Sentiment reads ${fg.value}/100 (${fg.classification}) — inside the range where crowd mood carries no directional edge.`
        : `Sentiment reads ${fg.value}/100 (${fg.classification}) — crowd positioning is stretched, and extremes have more often marked turning points than continuations.`,
    whyItMatters:
      "Retail sentiment is most informative when it is extreme: that is when the marginal buyer or seller has already acted.",
    asOf: data.updatedAt,
    conflicts: [],
    nextTrigger: `Currently ${fg.value}/100 — turns bearish at ${FEAR_GREED_EXTREME_GREED} or above, bullish at ${FEAR_GREED_EXTREME_FEAR} or below.`,
  };
}

// ── ETF flows ──────────────────────────────────────────────────────────

function evaluateEtfFlows(data: AggregateMarketData): MetricVerdict | null {
  const etf = data.etfFlows;
  if (!etf) return null;

  /*
   * Judged against this complex's OWN typical flow, not a fixed dollar
   * figure — a $200M day is routine for the BTC complex and enormous for
   * ETH, so a shared threshold would permanently misread one of them.
   */
  const relative = etf.typicalAbsFlowUsd > 0 ? etf.netFlowUsd / etf.typicalAbsFlowUsd : 0;
  const verdict: Verdict = relative > 0.5 ? "bullish" : relative < -0.5 ? "bearish" : "neutral";

  const conflicts: string[] = [];
  // A single day's print is noisy; the 5-day trend is the more reliable read.
  const trendVerdict: Verdict = etf.netFlow5dUsd > 0 ? "bullish" : etf.netFlow5dUsd < 0 ? "bearish" : "neutral";
  if (trendVerdict !== "neutral" && verdict !== "neutral" && trendVerdict !== verdict) {
    conflicts.push(
      `The latest day runs counter to the 5-day trend (${etf.netFlow5dUsd >= 0 ? "+" : ""}$${(etf.netFlow5dUsd / 1e6).toFixed(0)}M) — one session is noisy.`
    );
  }
  if (etf.isStale) {
    conflicts.push(`Latest settled print is ${etf.ageDays} days old — ETFs do not trade on weekends or US holidays.`);
  }

  const inputs = {
    completeness: etf.isStale ? 0.5 : 1,
    agreement: conflicts.length ? 0.55 : 0.85,
    backtested: false,
  };

  const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v / 1e6).toFixed(0)}M`;

  return {
    id: "etfFlows",
    label: "ETF Flows",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `US spot ETFs saw ${usd(etf.netFlowUsd)} on ${etf.latestDate} (${usd(etf.netFlow5dUsd)} over 5 sessions) against a typical day of $${(etf.typicalAbsFlowUsd / 1e6).toFixed(0)}M.`,
    whyItMatters:
      "ETF flows are the only read here on money arriving from traditional finance rather than from crypto-native traders.",
    asOf: data.updatedAt,
    conflicts,
    nextTrigger: `Counts as directional past half a typical day's flow, i.e. around ${usd(etf.typicalAbsFlowUsd * 0.5)} either way.`,
  };
}

// ── Spot vs perp volume ────────────────────────────────────────────────

function evaluateSpotPerpVolume(data: AggregateMarketData, ctx: SignalContext): MetricVerdict | null {
  const v = data.spotPerpVolume;
  if (!v) return null;

  /*
   * This metric has no direction of its own — it qualifies HOW a move is
   * being made. It confirms an existing price move when spot participates,
   * and warns when the move rests purely on leverage. So its verdict is the
   * direction of price action, or neutral when leverage is doing the work.
   *
   * THRESHOLDS ARE VENUE-SPECIFIC AND UNBASELINED. Both legs come from OKX,
   * a derivatives-first venue where perps routinely run 15-25x spot, so the
   * bands below are set against that observed scale rather than against a
   * general spot:perp norm — and there is no stored history for this ratio
   * yet to rank a reading against. Completeness is held down accordingly so
   * this can never present as a high-confidence signal on a threshold that
   * has not been validated.
   */
  const leverageLed = v.spotToPerpRatio < 0.03;
  const spotLed = v.spotToPerpRatio > 0.1;
  const pa = priceActionVerdict(ctx);

  let verdict: Verdict = "neutral";
  if (spotLed && pa && pa !== "neutral") verdict = pa;

  const conflicts: string[] = [];
  if (leverageLed) {
    conflicts.push(
      "Turnover is dominated by perpetuals rather than spot, so the current move rests on leverage rather than on outright demand."
    );
  }

  // Capped: no historical baseline exists for this ratio yet.
  const inputs = { completeness: 0.5, agreement: leverageLed ? 0.5 : 0.8, backtested: false };

  return {
    id: "spotPerpVolume",
    label: "Spot vs Perp Volume",
    verdict,
    confidence: scoreConfidence(inputs),
    confidenceBasis: describeConfidence(inputs),
    explanation: `Spot turnover is ${(v.spotToPerpRatio * 100).toFixed(0)}% of perpetual turnover — ${leverageLed ? "this move is being driven by leverage, not by people buying the asset outright" : spotLed ? "real spot demand is keeping pace with leveraged trading, which makes the move more durable" : "a normal mix of spot and leveraged activity"}.`,
    whyItMatters:
      "Moves carried by leverage alone unwind faster than moves backed by spot buying, because leveraged positions can be forced to close.",
    asOf: data.updatedAt,
    conflicts,
    nextTrigger: `Spot at ${(v.spotToPerpRatio * 100).toFixed(0)}% of perp turnover — flags leverage-led below 3%, spot-led above 10%.`,
  };
}

/**
 * Every evaluator, run in one pass. Metrics whose data is absent return
 * null and are dropped entirely rather than contributing a neutral — a
 * missing signal is not the same as a signal with no opinion, and counting
 * it as neutral would drag every roll-up toward the middle.
 */
export function evaluateAll(data: AggregateMarketData, ctx: SignalContext): MetricVerdict[] {
  const evaluated = [
    evaluateFunding(data, ctx),
    evaluateOpenInterest(data, ctx),
    evaluateSqueeze(data, ctx),
    evaluateLongShort(data, ctx),
    evaluateBasis(data, ctx),
    evaluateOrderFlow(data, ctx),
    evaluateTechnicals(data, ctx),
    evaluateEtfFlows(data),
    evaluateSpotPerpVolume(data, ctx),
    evaluateExchangeFlow(data),
    evaluateOptions(data, ctx),
    evaluateCoinbasePremium(data),
    evaluateStablecoins(data, ctx),
    evaluateFearGreed(data, ctx),
    evaluateLiquidations(data),
  ];

  return evaluated.filter((v): v is MetricVerdict => v !== null);
}
