import { Bar } from "./types";
import { survivalAt } from "./stopViability";
import { reachAt } from "./exitDesign";

/**
 * THE DISTANCE TABLE — the one artefact that was right every time.
 *
 * A full live session ran with the site beside it, and every narrative
 * built that day expired within the hour: a "steady bleed" that was a
 * liquidity vacuum, an order book that inverted in thirteen minutes, a
 * one-way divergence that lasted one tick. The table of distances from
 * price to armed levels was right every single time, and it was computed
 * by hand roughly twenty times. This endpoint is that table.
 *
 * STATELESS BY DESIGN. The broker is the source of truth for the book and
 * a copy here would drift, so positions and levels arrive in the request
 * and nothing is stored. What the site adds is the half the caller cannot
 * compute from a quote screen: for each level's CURRENT distance, how
 * often a single session travels that far on this name's own history —
 * the difference between "9.9% away" meaning safe and meaning routinely
 * touched. A level below price uses lows (does a session fall that far);
 * a level above uses highs (does a session reach that far). Horizon is
 * one session, so the windows do not overlap and n IS the honest count.
 */

export interface DistanceItem {
  symbol: string;
  /** The caller's live price. The site must not hold or invent the book. */
  price: number;
  level: number;
  /** Caller's own name for the level, echoed. */
  label?: string;
}

export interface TouchStat {
  /** Share of single sessions that travelled at least this far, 0-100. */
  pct: number;
  n: number;
}

export interface DistanceRow {
  symbol: string;
  label: string | null;
  price: number;
  level: number;
  /** Where the level sits relative to price. */
  direction: "below" | "above";
  distance_usd: number;
  distance_pct: number;
  /**
   * How often ONE session moves this far in this direction, from committed
   * daily bars. Null with a reason when the panel cannot say — unmeasured
   * is not the same as far.
   */
  single_session_touch: TouchStat | { reason: string };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * One row. Bars may be null when the symbol is not in the panel; the
 * distance is still computed (it needs only the caller's numbers), and the
 * touch stat says why it cannot be.
 */
export function distanceRow(item: DistanceItem, bars: readonly Bar[] | null): DistanceRow {
  const { symbol, price, level } = item;
  const direction: "below" | "above" = level <= price ? "below" : "above";
  const distanceUsd = Math.abs(price - level);
  const distancePct = (distanceUsd / price) * 100;

  let touch: DistanceRow["single_session_touch"];
  if (!bars || bars.length === 0) {
    touch = { reason: `${symbol} is not in the bars panel — distance is computed, frequency is not.` };
  } else if (direction === "below") {
    const cell = survivalAt(bars, distancePct, 1);
    touch = cell
      ? { pct: r2(100 - cell.survivalPct), n: cell.n }
      : { reason: "too little history to measure single-session moves this size" };
  } else {
    const cell = reachAt(bars, distancePct, 1);
    touch = cell
      ? { pct: r2(cell.reachPct), n: cell.n }
      : { reason: "too little history to measure single-session moves this size" };
  }

  return {
    symbol,
    label: item.label ?? null,
    price,
    level,
    direction,
    distance_usd: r2(distanceUsd),
    distance_pct: r2(distancePct),
    single_session_touch: touch,
  };
}

/** Closest level first — the sort IS the point of the table. */
export function sortByDistance(rows: DistanceRow[]): DistanceRow[] {
  return [...rows].sort((a, b) => a.distance_pct - b.distance_pct);
}
