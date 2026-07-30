import { LocalHistoryPoint } from "@/types/market";

/**
 * A metric's own recent trajectory, for drawing alongside its gauge.
 *
 * WHY: a gauge is a point in time, and a point in time is not a read. Funding
 * at +0.010% means one thing if it was +0.050% yesterday and the opposite if
 * it was -0.010%. Every gauge here showed only "now", so the reader had no way
 * to tell a crowded market from one that was crowded and is unwinding.
 */
export interface GaugeTrail {
  /** Chronological values for the sparkline. Empty when unavailable. */
  values: number[];
  /** Value from ~24h ago, or null when history doesn't reach back that far. */
  valueAgo: number | null;
}

const EMPTY: GaugeTrail = { values: [], valueAgo: null };

/** Points closer to now than this can't honestly be called "24h ago". */
const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const TARGET_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Pull one metric out of the recorded series.
 *
 * `pick` returns null/undefined for points where the metric wasn't available —
 * long/short is null when no venue published it, and the two derived scores
 * are absent entirely on points recorded before they were stored. Those points
 * are skipped rather than treated as zero, which would draw a cliff to the
 * bottom of the dial that never happened.
 */
export function gaugeTrail(
  history: LocalHistoryPoint[],
  pick: (point: LocalHistoryPoint) => number | null | undefined,
  maxPoints = 60
): GaugeTrail {
  if (!history || history.length === 0) return EMPTY;

  const usable: Array<{ t: number; v: number }> = [];
  for (const point of history) {
    const raw = pick(point);
    if (typeof raw === "number" && Number.isFinite(raw)) {
      usable.push({ t: point.t, v: raw });
    }
  }

  // One point is a dot, not a trend.
  if (usable.length < 2) return EMPTY;

  const now = Date.now();
  const old = usable.filter((p) => p.t <= now - MIN_AGE_MS);
  const valueAgo = old.length
    ? old.reduce((best, p) =>
        Math.abs(p.t - (now - TARGET_AGE_MS)) < Math.abs(best.t - (now - TARGET_AGE_MS)) ? p : best
      ).v
    : null;

  return {
    values: usable.slice(-maxPoints).map((p) => p.v),
    valueAgo,
  };
}
