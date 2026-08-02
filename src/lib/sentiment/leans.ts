import { Lean } from "@/components/ui/LeanGauge";
import { SqueezeRisk } from "@/types/market";

/**
 * Pure scoring functions behind the small LeanGauge shown on the 3 cards
 * whose underlying metric has a genuine bullish/bearish direction —
 * Coinbase Premium, Deribit Options (put/call), and Market Breadth
 * (stablecoin flow). Correlation deliberately has no equivalent function
 * here; it doesn't have a direction to score (see LeanGauge.tsx's doc
 * comment).
 *
 * Thresholds below are a defensible starting point, not settled science —
 * same framing this app already uses for FUNDING_BANDS, chartLean's
 * flat-price bands, and computeCompositeSentiment's weights.
 */

/**
 * Positive Coinbase premium (Coinbase priced above the rest of the market)
 * is the traditional "US buying pressure" bullish tell; negative is
 * bearish.
 */
export function coinbasePremiumLean(premiumPct: number): Lean {
  if (premiumPct >= 0.15) return "extreme-bullish";
  if (premiumPct >= 0.03) return "bullish";
  if (premiumPct <= -0.15) return "extreme-bearish";
  if (premiumPct <= -0.03) return "bearish";
  return "neutral";
}

/**
 * Extends DeribitOptionsIntelligence.tsx's existing 3-level badge
 * (PUT_CALL_NEUTRAL_LOW=0.8 / HIGH=1.2) to 5 levels rather than inventing a
 * separate scale — the two boundaries match exactly, so the badge and this
 * gauge never disagree about the same reading. High ratio = more puts open
 * = hedging/bearish-leaning; low ratio = more calls = bullish-leaning.
 */
export function deribitOptionsLean(putCallRatio: number): Lean {
  if (putCallRatio <= 0.5) return "extreme-bullish";
  if (putCallRatio < 0.8) return "bullish";
  if (putCallRatio <= 1.2) return "neutral";
  if (putCallRatio <= 2.0) return "bearish";
  return "extreme-bearish";
}

/**
 * Stablecoin minting (capital entering crypto as dry powder) is a bullish
 * precursor; burning (capital leaving entirely) is bearish. Scored on the
 * 7-DAY net change, not 24h — stablecoin supply moves slowly and a single
 * day's figure is noisier relative to its typical size.
 */
export function stablecoinFlowLean(netChange7dPct: number): Lean {
  if (netChange7dPct >= 1) return "extreme-bullish";
  if (netChange7dPct >= 0.2) return "bullish";
  if (netChange7dPct <= -1) return "extreme-bearish";
  if (netChange7dPct <= -0.2) return "bearish";
  return "neutral";
}

/**
 * Below this squeeze score, the setup isn't developed enough to count as a
 * directional lean — shared with marketThesis.ts's squeezeRiskEvidence so
 * the two can never disagree about when a squeeze becomes "meaningful."
 */
export const SQUEEZE_MEANINGFUL_SCORE = 40;

/**
 * squeezeRisk's score alone isn't inherently bullish or bearish — it's a
 * magnitude of "how crowded" (see LeanGauge.tsx's own doc comment on why
 * that distinction matters). Direction only comes from combining it with
 * which side is crowded, via the same "fade the extreme" rule already
 * documented in marketThesis.ts: a crowded, exposed side is bearish for
 * that side's holders, not bullish for them — this is a caution flag on the
 * crowded side, not a signal in its favor.
 */
export function squeezeLean(score: number, side: SqueezeRisk["side"]): Lean {
  if (side === "balanced" || score < SQUEEZE_MEANINGFUL_SCORE) return "neutral";
  const direction: "bullish" | "bearish" = side === "long" ? "bearish" : "bullish";
  const extreme = score >= 70;
  if (direction === "bearish") return extreme ? "extreme-bearish" : "bearish";
  return extreme ? "extreme-bullish" : "bullish";
}
