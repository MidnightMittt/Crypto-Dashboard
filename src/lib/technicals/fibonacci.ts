import { Candle, highs, lows } from "./indicators";
import { findSwingPoints } from "./divergence";

/**
 * PIVOT-ANCHORED Fibonacci — retracements and extensions.
 *
 * ── WHY THIS EXISTS ALONGSIDE indicators.ts's fibonacciRetracement ──────
 *
 * The existing `fibonacciRetracement` is correct for what it does and is left
 * untouched. But it anchors on the HIGHEST HIGH and LOWEST LOW of a trailing
 * 50-bar window, which are not necessarily swing points at all — the window's
 * extreme can be the very last bar, still forming, with nothing confirming it
 * as a pivot. Its own header is honest about this ("a defensible choice, not
 * the only correct one").
 *
 * For trade planning the anchors have to be CONFIRMED PIVOTS: a high with
 * lower highs on both sides of it, already closed. Otherwise the whole level
 * set slides every time a new extreme prints, and a "0.618 retracement" names
 * a different price each day.
 *
 * ── DIRECTION IS NOT COSMETIC ───────────────────────────────────────────
 *
 * A leg from a low UP to a high is retraced DOWNWARD from the high, and
 * extended UPWARD beyond it. A leg from a high DOWN to a low is the mirror.
 * Getting this backwards produces levels that look plausible and point the
 * wrong way, so the leg direction is returned explicitly rather than left for
 * a caller to infer from which number is larger.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────
 *
 * Not a signal. A price being at 0.618 means nothing on its own — measured
 * directly in this project, invented ratios (33/45/55%) performed as well as
 * the golden ratio on 9 years of BTC/ETH/SOL. These levels exist to say
 * "structure and this ratio agree here", never to trigger a trade alone.
 */

/** Bars either side required for a pivot. Matches ZONE_SWING_LOOKBACK so zones and fibs agree about what a swing is. */
const FIB_PIVOT_LOOKBACK = 3;
/** How close price must be to a level, as a fraction of the leg range, to count as "at" it. */
const AT_LEVEL_PCT = 0.02;

export const FIB_RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
export const FIB_EXTENSIONS = [1.272, 1.618] as const;

export type FibKind = "retracement" | "extension";

export interface FibLevel {
  ratio: number;
  price: number;
  kind: FibKind;
}

export interface FibLegResult {
  /** "up" = low→high (buy-the-dip context). "down" = high→low (sell-the-rally context). */
  direction: "up" | "down";
  anchorLow: number;
  anchorHigh: number;
  /** Index of each anchor in the candle array, so callers can age the leg. */
  anchorLowIndex: number;
  anchorHighIndex: number;
  levels: FibLevel[];
  /** The level price is currently sitting at, within AT_LEVEL_PCT of the leg range. */
  atLevel: FibLevel | null;
}

/**
 * Most recent CONFIRMED impulse leg and its Fibonacci levels.
 *
 * Returns null when there is no pair of opposite confirmed pivots — which is
 * the honest answer for a series too short or too flat to have an impulse,
 * and is preferable to anchoring on whatever extreme happens to exist.
 */
export function fibFromLastLeg(candles: Candle[], lookback = FIB_PIVOT_LOOKBACK): FibLegResult | null {
  if (candles.length < lookback * 2 + 2) return null;

  const highPivots = findSwingPoints(highs(candles), lookback).filter((p) => p.kind === "high");
  const lowPivots = findSwingPoints(lows(candles), lookback).filter((p) => p.kind === "low");
  if (!highPivots.length || !lowPivots.length) return null;

  const lastHigh = highPivots[highPivots.length - 1];
  const lastLow = lowPivots[lowPivots.length - 1];

  // The leg runs from the EARLIER pivot to the LATER one. Whichever came last
  // is the end of the move, and that decides direction.
  const direction: "up" | "down" = lastHigh.index > lastLow.index ? "up" : "down";
  const range = lastHigh.value - lastLow.value;
  if (!(range > 0)) return null;

  const levels: FibLevel[] = [];
  for (const r of FIB_RETRACEMENTS) {
    // Retrace back INTO the leg from its end.
    const price = direction === "up" ? lastHigh.value - r * range : lastLow.value + r * range;
    levels.push({ ratio: r, price, kind: "retracement" });
  }
  for (const r of FIB_EXTENSIONS) {
    // Project BEYOND the leg's end, in the direction of the move.
    const price = direction === "up" ? lastLow.value + r * range : lastHigh.value - r * range;
    levels.push({ ratio: r, price, kind: "extension" });
  }

  const price = candles[candles.length - 1].close;
  const tolerance = range * AT_LEVEL_PCT;
  let atLevel: FibLevel | null = null;
  let best = Infinity;
  for (const l of levels) {
    const d = Math.abs(price - l.price);
    if (d <= tolerance && d < best) {
      best = d;
      atLevel = l;
    }
  }

  return {
    direction,
    anchorLow: lastLow.value,
    anchorHigh: lastHigh.value,
    anchorLowIndex: lastLow.index,
    anchorHighIndex: lastHigh.index,
    levels: levels.sort((a, b) => a.price - b.price),
    atLevel,
  };
}

/**
 * The retracement levels traders actually act on. 0.236 and 0.786 are included
 * in the full set for completeness but are the shallowest and deepest of the
 * pullback band; 0.382/0.5/0.618 is the zone where continuation setups cluster.
 */
export function primaryRetracements(leg: FibLegResult): FibLevel[] {
  return leg.levels.filter((l) => l.kind === "retracement" && l.ratio >= 0.382 && l.ratio <= 0.618);
}

/** Extension prices, nearest first — candidate profit targets for a continuation. */
export function extensionTargets(leg: FibLegResult, fromPrice: number): FibLevel[] {
  return leg.levels
    .filter((l) => l.kind === "extension")
    .filter((l) => (leg.direction === "up" ? l.price > fromPrice : l.price < fromPrice))
    .sort((a, b) => Math.abs(a.price - fromPrice) - Math.abs(b.price - fromPrice));
}
