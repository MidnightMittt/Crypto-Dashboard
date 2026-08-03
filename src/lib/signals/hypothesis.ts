import { FUNDING_BANDS, LONG_SHORT_BANDS } from "../sentiment/bands";
import { DOMINANT_SHARE_HIGH, DOMINANT_SHARE_LOW } from "../sentiment/orderFlow";
import { SQUEEZE_MEANINGFUL_SCORE } from "../sentiment/leans";
import { BASIS_NEUTRAL_PCT, FEAR_GREED_EXTREME_FEAR, FEAR_GREED_EXTREME_GREED } from "./evaluators";

/**
 * Restates every metric in `evaluators.ts` as an explicit, falsifiable
 * hypothesis: what condition counts as an entry, what counts as success or
 * failure, and over what holding periods. Nothing here re-derives a
 * signal's direction — every condition below is read back from the SAME
 * bands/constants the real evaluator switches on (imported, not retyped),
 * so this file cannot silently drift from the logic it describes. Where a
 * threshold lives behind an unexported local inside evaluators.ts or
 * leans.ts rather than a shared constant, the number is written directly
 * with a comment pointing at its source — the same pattern already used by
 * `nextTrigger` strings in evaluators.ts (e.g. squeezeRisk's "70 extreme"
 * line).
 *
 * ── Why entry/exit/success are the same shape for every metric ─────────
 *
 * This is a DESCRIPTIVE backtest of "what happened after this signal
 * fired" — not a trading-strategy simulator. So, uniformly:
 *   - Entry: the metric's verdict is bullish or bearish (neutral readings
 *     are not tested — there is no direction to score).
 *   - Exit: time-based only, once the holding period elapses. No
 *     stop-loss, take-profit, or position sizing exists to simulate.
 *   - Success/failure: the forward return's SIGN matches (or opposes) the
 *     fired direction. No invented magnitude threshold — the same
 *     sign-only rule already shipped as `report.ts`'s `fadeHitRatePct`.
 */

export type HoldingPeriod = "1h" | "4h" | "24h" | "7d";
export const HOLDING_PERIODS: HoldingPeriod[] = ["1h", "4h", "24h", "7d"];

export interface SignalHypothesis {
  /** Matches MetricVerdict.id from evaluators.ts. */
  id: string;
  label: string;
  bullishCondition: string;
  bearishCondition: string;
  neutralCondition: string;
  entryCondition: string;
  exitCondition: string;
  holdingPeriods: HoldingPeriod[];
  successCriteria: string;
  failureCriteria: string;
  /**
   * Whether `scripts/backtest/` currently has a historical source that lets
   * this hypothesis actually be measured, not just stated. Metrics without
   * one (order flow, Coinbase premium, Deribit options, exchange netflow,
   * liquidations) still get a full hypothesis contract — the point of this
   * file is that every signal COULD be tested — but their report sections
   * must say "insufficient data" rather than fabricate a number.
   */
  hasHistoricalSource: boolean;
}

const ENTRY_CONDITION = (label: string) =>
  `${label}'s verdict reads bullish or bearish (see conditions above). Neutral readings are not entries — there is no direction to test.`;

const EXIT_CONDITION =
  "Time-based only: the position is marked closed once the holding period elapses. This is a descriptive backtest of what happened after the signal fired, not a trading strategy with stop-loss, take-profit, or position sizing.";

const SUCCESS_CRITERIA =
  "The forward return's sign matches the fired direction — positive after a bullish entry, negative after a bearish entry. No magnitude threshold.";

const FAILURE_CRITERIA =
  "The forward return's sign opposes the fired direction — negative after a bullish entry, positive after a bearish entry.";

function hypothesis(opts: {
  id: string;
  label: string;
  bullishCondition: string;
  bearishCondition: string;
  neutralCondition: string;
  hasHistoricalSource: boolean;
}): SignalHypothesis {
  return {
    id: opts.id,
    label: opts.label,
    bullishCondition: opts.bullishCondition,
    bearishCondition: opts.bearishCondition,
    neutralCondition: opts.neutralCondition,
    entryCondition: ENTRY_CONDITION(opts.label),
    exitCondition: EXIT_CONDITION,
    holdingPeriods: HOLDING_PERIODS,
    successCriteria: SUCCESS_CRITERIA,
    failureCriteria: FAILURE_CRITERIA,
    hasHistoricalSource: opts.hasHistoricalSource,
  };
}

const fundingBullish = FUNDING_BANDS.find((b) => b.label === "Bullish")!;
const fundingExtremeShorts = FUNDING_BANDS.find((b) => b.label === "Extreme Shorts")!;
const fundingBearish = FUNDING_BANDS.find((b) => b.label === "Bearish")!;
const fundingCrowdedLongs = FUNDING_BANDS.find((b) => b.label === "Crowded Longs")!;

const longShortMostlyLongs = LONG_SHORT_BANDS.find((b) => b.label === "Mostly Longs")!;
const longShortMostlyShorts = LONG_SHORT_BANDS.find((b) => b.label === "Mostly Shorts")!;

export const SIGNAL_HYPOTHESES: SignalHypothesis[] = [
  hypothesis({
    id: "funding",
    label: "Funding Rate",
    bullishCondition: `Funding sits in the "Bullish" band (${fundingBullish.min}% to ${fundingBullish.max}%/8h), OR in the "Extreme Shorts" band (below ${fundingExtremeShorts.max}%/8h) — faded: crowded shorts are read as exhaustion, not doubly bearish.`,
    bearishCondition: `Funding sits in the "Bearish" band (${fundingBearish.min}% to ${fundingBearish.max}%/8h), OR in the "Crowded Longs" band (above ${fundingCrowdedLongs.min}%/8h) — faded: crowded longs are read as the side exposed to an unwind, not doubly bullish.`,
    neutralCondition: `Funding sits inside the neutral band, ${FUNDING_BANDS.find((b) => b.label === "Neutral")!.min}% to ${FUNDING_BANDS.find((b) => b.label === "Neutral")!.max}%/8h.`,
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "openInterest",
    label: "Open Interest",
    bullishCondition: "Open interest rises more than 2% in 24h WHILE price rises more than 0.5% — new long positions opening into a rising price (mirrors evaluateOpenInterest's 2%/0.5% cutoffs in evaluators.ts).",
    bearishCondition: "Open interest rises more than 2% in 24h WHILE price falls more than 0.5% — new short positions opening into a falling price.",
    neutralCondition: "Open interest falls while price moves either way (covering or deleveraging, not fresh directional capital), or neither open interest nor price moves enough to say leverage is building.",
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "squeezeRisk",
    label: "Squeeze Setup",
    bullishCondition: `Shorts are the crowded side (score >= ${SQUEEZE_MEANINGFUL_SCORE}/100) — faded: a short squeeze forces buying, so this reads bullish for price, not bullish for the crowded shorts.`,
    bearishCondition: `Longs are the crowded side (score >= ${SQUEEZE_MEANINGFUL_SCORE}/100) — faded: a long squeeze forces selling.`,
    neutralCondition: `No side is clearly crowded (side is "balanced"), or the score is below ${SQUEEZE_MEANINGFUL_SCORE}/100 — not developed enough to count as a directional setup.`,
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "longShort",
    label: "Long/Short Positioning",
    bullishCondition: `Long share of open positions is in the "Mostly Longs" band (${longShortMostlyLongs.min}%-${longShortMostlyLongs.max}%). Unlike funding/squeezeRisk, this metric is read WITH the crowd, not faded against it — it measures trend confirmation, not exposure to an unwind.`,
    bearishCondition: `Long share of open positions is in the "Mostly Shorts" band (${longShortMostlyShorts.min}%-${longShortMostlyShorts.max}%).`,
    neutralCondition: "Long share sits in the balanced middle band.",
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "basis",
    label: "Basis vs Spot",
    bullishCondition: `Perps trade above spot by more than ${BASIS_NEUTRAL_PCT}% — leveraged demand paying up for exposure.`,
    bearishCondition: `Perps trade below spot by more than ${BASIS_NEUTRAL_PCT}% — perps discounted to spot, a sign of hedging or unwind pressure.`,
    neutralCondition: `The gap is within +/-${BASIS_NEUTRAL_PCT}% of spot.`,
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "orderFlow",
    label: "Order Flow",
    bullishCondition: `Buyers take ${DOMINANT_SHARE_HIGH}% or more of taker volume over the measured window.`,
    bearishCondition: `Sellers take enough share that buyers fall to ${DOMINANT_SHARE_LOW}% or below.`,
    neutralCondition: "Aggressive buying and selling are near balanced.",
    hasHistoricalSource: false, // no historical taker-flow/CVD source exists for the replay
  }),
  hypothesis({
    id: "technicals",
    label: "Price Action",
    bullishCondition: "The combined technical-indicator vote direction is bullish AND its strength is 20/100 or higher (mirrors TECHNICAL_MEANINGFUL_STRENGTH in evaluators.ts).",
    bearishCondition: "The combined technical-indicator vote direction is bearish AND its strength is 20/100 or higher.",
    neutralCondition: "Strength is below 20/100 — reported neutral regardless of which way the vote leans, since a weak trend read tends to mean-revert.",
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "etfFlows",
    label: "ETF Flows",
    bullishCondition: "Net daily ETF flow exceeds +50% of this asset's own typical day's flow (mirrors evaluateEtfFlows' 0.5x relative cutoff, judged against the complex's own scale rather than a fixed dollar figure).",
    bearishCondition: "Net daily ETF flow is more negative than -50% of the typical day's flow.",
    neutralCondition: "Net flow sits within +/-50% of a typical day.",
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "spotPerpVolume",
    label: "Spot vs Perp Volume",
    bullishCondition: "Spot turnover exceeds 10% of perp turnover (spot-led) AND price action's own direction is bullish — this metric borrows price action's direction, gated by whether spot is participating (mirrors evaluateSpotPerpVolume's 0.1 spot-led cutoff).",
    bearishCondition: "Spot turnover exceeds 10% of perp turnover (spot-led) AND price action's own direction is bearish.",
    neutralCondition: "Spot turnover is 10% or less of perp turnover (leverage-led, no confirming spot demand), or spot-led with no clear price direction to borrow.",
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "exchangeFlow",
    label: "Exchange Netflow",
    bullishCondition: "Tracked wallet balances net OUTFLOW from exchanges — coins leaving usually means accumulation into cold storage.",
    bearishCondition: "Tracked wallet balances net INFLOW to exchanges — coins arriving usually precedes selling.",
    neutralCondition: "Tracked wallet balances are roughly flat.",
    hasHistoricalSource: false, // no historical on-chain wallet-balance source exists for the replay
  }),
  hypothesis({
    id: "options",
    label: "Options Put/Call",
    bullishCondition: "Deribit put/call ratio is below 0.80 — more calls open than puts (mirrors deribitOptionsLean's neutral-low boundary in leans.ts).",
    bearishCondition: "Deribit put/call ratio is above 1.20 — more puts open than calls.",
    neutralCondition: "Put/call ratio sits between 0.80 and 1.20.",
    hasHistoricalSource: false, // no historical Deribit options source exists for the replay
  }),
  hypothesis({
    id: "coinbasePremium",
    label: "Coinbase Premium",
    bullishCondition: "Coinbase trades at a premium of +0.03% or more over the broader spot market (mirrors coinbasePremiumLean's boundary in leans.ts) — US buyers bidding more aggressively.",
    bearishCondition: "Coinbase trades at a discount of -0.03% or more.",
    neutralCondition: "Premium sits within +/-0.03%.",
    hasHistoricalSource: false, // no historical Coinbase-vs-market spot source exists for the replay
  }),
  hypothesis({
    id: "stablecoins",
    label: "Stablecoin Supply",
    bullishCondition: "Total stablecoin supply grew 0.2% or more over 7 days (mirrors stablecoinFlowLean's boundary in leans.ts) — fresh capital arriving as dry powder.",
    bearishCondition: "Total stablecoin supply shrank 0.2% or more over 7 days — capital leaving the ecosystem entirely.",
    neutralCondition: "7-day supply change sits within +/-0.2%.",
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "fearGreed",
    label: "Fear & Greed",
    bullishCondition: `Index reads ${FEAR_GREED_EXTREME_FEAR} or below (extreme fear) — faded: read contrarian at the extremes, the same "fade the crowd" rule funding and squeezeRisk use, since the marginal seller has likely already acted.`,
    bearishCondition: `Index reads ${FEAR_GREED_EXTREME_GREED} or above (extreme greed) — faded, for the same reason.`,
    neutralCondition: `Index sits between ${FEAR_GREED_EXTREME_FEAR} and ${FEAR_GREED_EXTREME_GREED} — inside this range, crowd mood carries no directional edge.`,
    hasHistoricalSource: true,
  }),
  hypothesis({
    id: "liquidations",
    label: "Liquidations",
    bullishCondition: "Never fires. Liquidations describe positions already forced out, not a lean on what happens next — evaluateLiquidations always returns neutral by design (see its own doc comment in evaluators.ts), and marketThesis.ts gives it weight 0 for the same reason.",
    bearishCondition: "Never fires, for the same reason.",
    neutralCondition: "Always — this metric has no directional verdict to test.",
    hasHistoricalSource: false, // has no direction at all, so there is nothing a replay could measure
  }),
];

export function getHypothesis(id: string): SignalHypothesis | undefined {
  return SIGNAL_HYPOTHESES.find((h) => h.id === id);
}
