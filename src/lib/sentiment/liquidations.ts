import { LiquidationBucket, LiquidationSummary } from "@/types/market";
import { VenueLiquidations } from "@/lib/providers/coinalyze";

/**
 * Aggregates raw per-venue liquidation series (already unit-converted to USD
 * by coinalyze.ts) into one cross-venue summary.
 *
 * Kept separate from the fetch layer for the same reason every other derived
 * metric in sentiment/ is: this is pure computation, so it can be tested
 * against fixed input without a network call or an API key.
 *
 * "Liquidations" here means observed forced-close volume that ALREADY
 * happened, not a forward-looking risk score. Pair with `squeezeRisk`
 * (sentiment/positioning.ts) for "how primed is the market for the NEXT
 * one" — the two answer different tenses of the same question and should
 * never be merged into a single figure.
 */

/** Matches LONG_SHORT_BANDS' balanced zone, for the same reason: a share
 * inside 35-65% isn't a meaningful skew, it's noise around even. */
const DOMINANT_SHARE_LOW = 35;
const DOMINANT_SHARE_HIGH = 65;

export function summarizeLiquidations(
  venues: VenueLiquidations[]
): LiquidationSummary | null {
  // No venue returned anything — nothing to derive, not even a "zero"
  // reading, since we don't actually know what happened.
  if (venues.length === 0) return null;

  // Bucket by hour across venues. Points already arrive on hour boundaries
  // from a shared interval=1hour request, but timestamps are floored anyway
  // in case of any per-venue jitter — the same defensive bucketing used for
  // cross-venue OI history elsewhere in this codebase.
  const buckets = new Map<number, { longUsd: number; shortUsd: number }>();

  for (const venue of venues) {
    for (const p of venue.points) {
      const hour = Math.floor(p.t / 3_600_000) * 3_600_000;
      const existing = buckets.get(hour) ?? { longUsd: 0, shortUsd: 0 };
      existing.longUsd += p.longUsd;
      existing.shortUsd += p.shortUsd;
      buckets.set(hour, existing);
    }
  }

  const history: LiquidationBucket[] = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, v]) => ({ t, longUsd: v.longUsd, shortUsd: v.shortUsd }));

  const totalLongUsd = history.reduce((s, b) => s + b.longUsd, 0);
  const totalShortUsd = history.reduce((s, b) => s + b.shortUsd, 0);
  const total = totalLongUsd + totalShortUsd;

  // A real zero (venues reported, nothing was liquidated) is a meaningful,
  // honest reading — a genuinely quiet market — not a missing one, so this
  // still returns a summary rather than null.
  const longSharePct = total > 0 ? (totalLongUsd / total) * 100 : 50;

  const dominantSide: LiquidationSummary["dominantSide"] =
    total <= 0
      ? "balanced"
      : longSharePct >= DOMINANT_SHARE_HIGH
        ? "long"
        : longSharePct <= DOMINANT_SHARE_LOW
          ? "short"
          : "balanced";

  const windowHours =
    history.length >= 2 ? (history[history.length - 1].t - history[0].t) / 3_600_000 : 0;

  return {
    history,
    totalLongUsd,
    totalShortUsd,
    dominantSide,
    longSharePct: Math.round(longSharePct * 10) / 10,
    venues: Array.from(new Set(venues.map((v) => v.venueId))),
    windowHours,
  };
}
