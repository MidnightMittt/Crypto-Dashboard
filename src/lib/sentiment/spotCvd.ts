import { CvdPoint, SpotCvdSummary } from "@/types/market";
import { RawCvdPoint } from "@/lib/providers/okxOrderFlow";
import { DOMINANT_SHARE_HIGH, DOMINANT_SHARE_LOW } from "./orderFlow";

/**
 * Aggregates OKX's raw hourly spot taker-volume rows into one summary —
 * mirrors summarizeOrderFlow's cumulative-delta loop exactly (orderFlow.ts),
 * reusing the same DOMINANT_SHARE_LOW/HIGH bands so "buyers dominant" means
 * the identical threshold on both the perp and spot reads.
 *
 * Pure computation, no network call — split from the fetch layer for the
 * same reason every other derived metric in sentiment/ is.
 */
export function summarizeSpotCvd(takerVolume: RawCvdPoint[]): SpotCvdSummary | null {
  if (takerVolume.length === 0) return null;

  let cumulativeUsd = 0;
  const cvdHistory: CvdPoint[] = takerVolume.map((p) => {
    cumulativeUsd += p.buyUsd - p.sellUsd;
    return { t: p.t, buyUsd: p.buyUsd, sellUsd: p.sellUsd, cumulativeUsd };
  });

  const totalBuyUsd = takerVolume.reduce((s, p) => s + p.buyUsd, 0);
  const totalSellUsd = takerVolume.reduce((s, p) => s + p.sellUsd, 0);
  const total = totalBuyUsd + totalSellUsd;

  // Real zero volume is a meaningful, honest reading, not a missing one.
  const buyerSharePct = total > 0 ? (totalBuyUsd / total) * 100 : 50;

  const dominantSide: SpotCvdSummary["dominantSide"] =
    total <= 0
      ? "balanced"
      : buyerSharePct >= DOMINANT_SHARE_HIGH
        ? "buyers"
        : buyerSharePct <= DOMINANT_SHARE_LOW
          ? "sellers"
          : "balanced";

  const windowHours =
    cvdHistory.length >= 2 ? (cvdHistory[cvdHistory.length - 1].t - cvdHistory[0].t) / 3_600_000 : 0;

  return {
    cvdHistory,
    totalBuyUsd,
    totalSellUsd,
    dominantSide,
    buyerSharePct: Math.round(buyerSharePct * 10) / 10,
    windowHours,
    venue: "OKX",
  };
}
