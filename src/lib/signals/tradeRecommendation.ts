import { MarketBias } from "./types";
import { MarketThesis, TechnicalRead } from "@/types/market";
import { technicalAgreement } from "@/lib/sentiment/technicals";

/**
 * The gated "what should I actually do" recommendation — Dashboard V2's
 * three-layer decision framework, made concrete. A trade is recommended
 * ONLY when BOTH layers agree:
 *
 *   Layer 1 (Market Thesis)         -> `bias.verdict` (already synthesizes
 *                                       positioning/marketStructure/
 *                                       leadingDrivers/risk — see
 *                                       marketBias.ts)
 *   Layer 2 (Technical Confirmation) -> `technicalAgreement()` (already
 *                                       exists in sentiment/technicals.ts,
 *                                       previously informational only)
 *
 * New-entry actions only — confirmed scope decision: Hold/Take Partial
 * Profits/Exit/Reduce Risk stay out until this app tracks real open
 * positions (entry price/side/size), which it does not today. Recommending
 * a position-management action without knowing whether one exists would be
 * actively misleading, not just incomplete.
 *
 * Nothing here fabricates a number: every reason/next-trigger string cites
 * a real, already-computed value (bias.headline's leaning logic,
 * bias.watchNext's real band-boundary text, thesis.technicalConfirmation's
 * real qualitative analysis) — never a fabricated confidence or an invented
 * numeric trigger level the underlying technical read doesn't actually
 * compute.
 */

/**
 * Five states, not three — the two "wait" cases used to collapse into one
 * undifferentiated label, hiding a real distinction. "no-trade" (Layer 1
 * blocked) means there's no real directional lean yet — nothing to wait
 * FOR. "wait-long/short-confirmation" (Layer 2 blocked) means a real
 * directional thesis already exists and technicals just haven't caught up
 * — a meaningfully different, more actionable state to be in.
 *
 * Deliberately NOT including Hold/Reduce Risk/Take Profit/Exit — this app
 * doesn't track a user's actual open positions (entry price/side/size), so
 * recommending a position-management action would fabricate context it
 * doesn't have. Also deliberately NOT including a DATA INVALID state here:
 * a null `bias` is handled entirely by this function's caller (see
 * EntryQualityCard's own early-return empty state) before this function is
 * ever called — `bias` is required, not optional, so there's no code path
 * inside this function that could honestly return that state.
 */
export type SuggestedAction = "enter-long" | "enter-short" | "wait-long-confirmation" | "wait-short-confirmation" | "no-trade";

export interface TradeRecommendation {
  action: SuggestedAction;
  label: string;
  reason: string;
  blockingLayer: "thesis" | "technicals" | "record" | null;
  nextTrigger: string | null;
}

const ACTION_LABEL: Record<SuggestedAction, string> = {
  "enter-long": "ENTER LONG",
  "enter-short": "ENTER SHORT",
  "wait-long-confirmation": "WAIT FOR LONG CONFIRMATION",
  "wait-short-confirmation": "WAIT FOR SHORT CONFIRMATION",
  "no-trade": "NO TRADE",
};

export function buildTradeRecommendation(
  bias: MarketBias,
  thesis: MarketThesis | null,
  technicals: TechnicalRead | null,
  /**
   * The same technical read, computed against 4-hour candles — live-only
   * (see okxCandles.ts), always null in the backtest replay, always
   * optional. Deliberately NOT a third gate: the spec this implements
   * against is explicit that "a lower-timeframe entry should not
   * automatically override a major higher-timeframe structural conflict"
   * — HTF disagreement rides along as a caveat on an otherwise-clearing
   * ENTER recommendation, never blocks one outright the way Layer 1/2 do.
   */
  technicals4h: TechnicalRead | null = null,
  /**
   * The measured excursion/EV constraints for the BIAS direction's side in
   * the current volatility regime (planConstraintsFor). When present and
   * EV-negative at the Wilson lower bound, an otherwise-clearing ENTER is
   * downgraded to NO TRADE with the record cited — the top-of-page word
   * must pass every honesty layer the platform has, and a side whose own
   * replayed history loses money does not pass. Optional so the backtest
   * replay (which must stay ungated — see plannerStats.ts) and older
   * callers are unchanged.
   */
  evConstraint: { evLowerPct: number; n: number; cellKey: string } | null = null
): TradeRecommendation {
  const agreement = thesis && technicals ? technicalAgreement(technicals, thesis.dominant) : "not-yet-confirmed";
  const htfAgreement = thesis && technicals4h ? technicalAgreement(technicals4h, thesis.dominant) : null;

  if (bias.verdict !== "neutral" && agreement === "confirms") {
    /*
     * Layer 3 — THE RECORD. Direction reads, technicals confirm, and yet:
     * if this side's own replayed trades lose money at the 95% lower bound
     * of their record, recommending the entry would be the engine
     * overruling its own evidence. The read is still stated (the reason
     * names the direction); only the ACTION is withheld.
     */
    if (evConstraint && evConstraint.evLowerPct <= 0) {
      const side = bias.verdict === "bullish" ? "long" : "short";
      return {
        action: "no-trade",
        label: ACTION_LABEL["no-trade"],
        reason:
          `${bias.headline} Technicals confirm the direction — but ${side}s in the current ` +
          `volatility regime carry NEGATIVE measured expectancy at the pessimistic bound of their ` +
          `own replayed record (${evConstraint.n} trades, ${evConstraint.cellKey}). The engine reads ` +
          `the market and still refuses the trade; this gate re-opens automatically if the record turns positive.`,
        blockingLayer: "record",
        nextTrigger: null,
      };
    }
    const action: SuggestedAction = bias.verdict === "bullish" ? "enter-long" : "enter-short";
    const htfCaveat =
      htfAgreement === "weakens" || htfAgreement === "contradicts"
        ? " Note: the 4-hour higher-timeframe read currently disagrees with this direction — a lower-conviction entry, size accordingly."
        : "";
    return {
      action,
      label: ACTION_LABEL[action],
      reason: `${bias.headline} Technicals confirm — price action backs the same direction.${htfCaveat}`,
      blockingLayer: null,
      nextTrigger: null,
    };
  }

  // Layer 1 hasn't crossed the directional threshold yet — the thesis
  // itself is the blocker, regardless of what technicals show. No real
  // lean exists to wait FOR yet, so this is NO TRADE, not a wait state.
  if (bias.verdict === "neutral") {
    const watch = bias.watchNext[0] ?? null;
    return {
      action: "no-trade",
      label: ACTION_LABEL["no-trade"],
      reason: bias.headline,
      blockingLayer: "thesis",
      nextTrigger: watch ? `${watch.label} — ${watch.nextTrigger}` : "No metric is currently close enough to a threshold to name a specific level to watch.",
    };
  }

  const waitAction: SuggestedAction = bias.verdict === "bullish" ? "wait-long-confirmation" : "wait-short-confirmation";

  // Layer 1 agrees directionally, but a REGULAR (reversal-warning)
  // divergence undercuts it — technicals nominally back the move, but
  // momentum itself isn't. Cited directly from the real divergence result,
  // never routed through thesis.technicalConfirmation[0] (which isn't
  // guaranteed to be about divergence that day).
  if (agreement === "weakens" && technicals) {
    const direction = bias.verdict === "bullish" ? "bullish" : "bearish";
    const opposingKind = direction === "bullish" ? "regular-bearish" : "regular-bullish";
    const source =
      technicals.rsiDivergence?.kind === opposingKind ? "RSI" : technicals.macdDivergence?.kind === opposingKind ? "MACD" : "Momentum";
    const divergenceLabel = direction === "bullish" ? "bearish" : "bullish";
    return {
      action: waitAction,
      label: ACTION_LABEL[waitAction],
      reason: `${bias.headline} Price action agrees directionally, but ${source} shows a regular ${divergenceLabel} divergence against this move — momentum isn't backing the trend yet.`,
      blockingLayer: "technicals",
      nextTrigger: `Technical confirmation needed: the ${source} divergence resolving — either price rolling over to match it, or momentum reconfirming the ${direction} move without the divergence.`,
    };
  }

  // Layer 1 has a real directional read, but technicals either contradict or
  // haven't been evaluated yet — technicals are the blocker.
  const direction = bias.verdict === "bullish" ? "bullish" : "bearish";
  const confirmationLine = thesis?.technicalConfirmation[0] ?? null;
  const reason = confirmationLine
    ? `${bias.headline} Price action hasn't confirmed yet: ${confirmationLine.charAt(0).toLowerCase()}${confirmationLine.slice(1)}`
    : `${bias.headline} No technical read is available yet to confirm this thesis.`;

  return {
    action: waitAction,
    label: ACTION_LABEL[waitAction],
    reason,
    blockingLayer: "technicals",
    nextTrigger: confirmationLine
      ? `Technical confirmation needed: price action turning to back the ${direction} thesis (trend strengthening, momentum and structure aligning) rather than the current read.`
      : "Technical confirmation needed, but no technical read is available yet for this asset.",
  };
}
