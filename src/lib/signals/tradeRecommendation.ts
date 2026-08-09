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

export type SuggestedAction = "enter-long" | "enter-short" | "wait";

export interface TradeRecommendation {
  action: SuggestedAction;
  label: string;
  reason: string;
  blockingLayer: "thesis" | "technicals" | null;
  nextTrigger: string | null;
}

const ACTION_LABEL: Record<SuggestedAction, string> = {
  "enter-long": "ENTER LONG",
  "enter-short": "ENTER SHORT",
  wait: "WAIT FOR CONFIRMATION",
};

export function buildTradeRecommendation(
  bias: MarketBias,
  thesis: MarketThesis | null,
  technicals: TechnicalRead | null
): TradeRecommendation {
  const agreement = thesis && technicals ? technicalAgreement(technicals, thesis.dominant) : "not-yet-confirmed";

  if (bias.verdict !== "neutral" && agreement === "confirms") {
    const action: SuggestedAction = bias.verdict === "bullish" ? "enter-long" : "enter-short";
    return {
      action,
      label: ACTION_LABEL[action],
      reason: `${bias.headline} Technicals confirm — price action backs the same direction.`,
      blockingLayer: null,
      nextTrigger: null,
    };
  }

  // Layer 1 hasn't crossed the directional threshold yet — the thesis
  // itself is the blocker, regardless of what technicals show.
  if (bias.verdict === "neutral") {
    const watch = bias.watchNext[0] ?? null;
    return {
      action: "wait",
      label: ACTION_LABEL.wait,
      reason: bias.headline,
      blockingLayer: "thesis",
      nextTrigger: watch ? `${watch.label} — ${watch.nextTrigger}` : "No metric is currently close enough to a threshold to name a specific level to watch.",
    };
  }

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
      action: "wait",
      label: ACTION_LABEL.wait,
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
    action: "wait",
    label: ACTION_LABEL.wait,
    reason,
    blockingLayer: "technicals",
    nextTrigger: confirmationLine
      ? `Technical confirmation needed: price action turning to back the ${direction} thesis (trend strengthening, momentum and structure aligning) rather than the current read.`
      : "Technical confirmation needed, but no technical read is available yet for this asset.",
  };
}
