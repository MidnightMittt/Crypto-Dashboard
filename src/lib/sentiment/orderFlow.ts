import { CvdPoint, OrderBookImbalance, OrderFlowSummary } from "@/types/market";
import { RawBookDepth, RawCvdPoint } from "@/lib/providers/okxOrderFlow";

/**
 * Aggregates OKX's raw book depth and hourly taker-volume rows into one
 * order-flow summary.
 *
 * Split from the fetch layer for the same reason every other derived metric
 * in sentiment/ is: pure computation, testable against fixed input with no
 * network call or live venue.
 *
 * Two genuinely different concepts live in one summary here, and they must
 * stay visually and semantically separate in anything that renders this:
 *   - bookImbalance: resting orders waiting to be filled (a snapshot)
 *   - cvdHistory / dominantFlow: taker volume that already executed (a trend)
 * Neither is a position, and neither is `longShortRatio` (account positions)
 * or `liquidations` (forced closes) — four different tenses of "who's
 * doing what", none interchangeable with another.
 */

/** Matches LONG_SHORT_BANDS' and liquidations.ts's balanced-zone convention. */
const DOMINANT_SHARE_LOW = 35;
const DOMINANT_SHARE_HIGH = 65;

export function summarizeOrderFlow(
  bookDepth: RawBookDepth | null,
  takerVolume: RawCvdPoint[]
): OrderFlowSummary | null {
  // Nothing from either source — genuinely unknown, not a zero reading.
  if (!bookDepth && takerVolume.length === 0) return null;

  const bookImbalance: OrderBookImbalance | null = bookDepth
    ? (() => {
        const total = bookDepth.bidUsd + bookDepth.askUsd;
        return {
          bid: { usd: bookDepth.bidUsd },
          ask: { usd: bookDepth.askUsd },
          imbalancePct: total > 0 ? ((bookDepth.bidUsd - bookDepth.askUsd) / total) * 100 : 0,
          depthLevels: bookDepth.depthLevels,
        };
      })()
    : null;

  let cumulativeUsd = 0;
  const cvdHistory: CvdPoint[] = takerVolume.map((p) => {
    cumulativeUsd += p.buyUsd - p.sellUsd;
    return { t: p.t, buyUsd: p.buyUsd, sellUsd: p.sellUsd, cumulativeUsd };
  });

  const totalBuyUsd = takerVolume.reduce((s, p) => s + p.buyUsd, 0);
  const totalSellUsd = takerVolume.reduce((s, p) => s + p.sellUsd, 0);
  const total = totalBuyUsd + totalSellUsd;

  // Real zero volume (venue reported, nothing traded) is a meaningful,
  // honest reading, not a missing one - a genuinely dead market.
  const buyerSharePct = total > 0 ? (totalBuyUsd / total) * 100 : 50;

  const dominantFlow: OrderFlowSummary["dominantFlow"] =
    total <= 0
      ? "balanced"
      : buyerSharePct >= DOMINANT_SHARE_HIGH
        ? "buyers"
        : buyerSharePct <= DOMINANT_SHARE_LOW
          ? "sellers"
          : "balanced";

  const windowHours =
    cvdHistory.length >= 2
      ? (cvdHistory[cvdHistory.length - 1].t - cvdHistory[0].t) / 3_600_000
      : 0;

  return {
    bookImbalance,
    cvdHistory,
    totalBuyUsd,
    totalSellUsd,
    dominantFlow,
    buyerSharePct: Math.round(buyerSharePct * 10) / 10,
    windowHours,
    venue: "OKX",
  };
}
