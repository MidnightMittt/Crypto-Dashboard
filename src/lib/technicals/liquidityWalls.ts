import { RawBookLevel } from "@/lib/providers/okxOrderFlow";
import { SupportResistanceZone } from "./marketStructure";

/**
 * Real order-book wall detection — the one piece of live market data this
 * app fetches but has always discarded. `fetchOkxBookDepth()` already
 * requests OKX's 20-level book and gets full per-level [price, size] pairs
 * back; only the two USD totals were ever kept. This module reads the
 * levels it was already paying for.
 *
 * ── The measured scale problem, and why it shapes everything below ────────
 *
 * Pulled BTC and ETH's real 20-level books directly before writing this
 * file: the visible book spans roughly 0.004-0.01% of price on each side
 * (BTC: $64,639.90 down to $64,636.80 across 20 bid levels). Meanwhile
 * `entryQuality.ts`'s stops and targets sit 0.5-4 ATR away — commonly
 * 0.5-3%+ of price for daily crypto ATR. That is a 50-500x gap.
 *
 * Concretely: ENTRY (= current price) is the only execution-plan price
 * that can ever genuinely fall inside the visible book. Stop, TP1 and TP2
 * will resolve to "outside visible depth" in the overwhelming majority of
 * real setups. That is not a bug in `executionDistanceContext` below — it
 * is the honest answer, and the alternative (silently matching a wall to a
 * stop 2% away) would be exactly the false precision this codebase's own
 * conventions forbid. See that function's own comment for the one
 * legitimate way liquidity DOES reach S/R: via zones currently overlapping
 * price (status testing/rejecting/reclaiming/breaking).
 */

export type WallSide = "bid" | "ask";

export interface LiquidityWall {
  side: WallSide;
  price: number;
  usd: number;
  /** Iglewicz & Hoaglin modified z-score vs. the rest of the same side's visible levels — see detectWalls' own doc comment for why this threshold and not a dollar figure. */
  zScore: number;
}

/**
 * Standard robust-outlier threshold (Iglewicz & Hoaglin, 1993) for the
 * modified z-score below — not an invented number. Chosen over a plain
 * mean/stdev z-score specifically because a book with one enormous level
 * drags the mean and stdev toward itself, which can hide the very outlier
 * being searched for; the median and MAD are far more resistant to that.
 */
const MODIFIED_Z_THRESHOLD = 3.5;
/** 0.6745 = the standard scaling constant converting MAD to be comparable with a normal-distribution stdev — part of the same published formula, not a free parameter. */
const MAD_SCALE = 0.6745;
/** Below this many real levels, a MAD-based outlier read is not statistically meaningful — reported as insufficient rather than computed. */
const MIN_LEVELS_FOR_DETECTION = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface WallDetectionResult {
  walls: LiquidityWall[];
  /** False when the side had too few levels or a degenerate (near-zero MAD) distribution to detect outliers honestly — distinct from "checked, found none." */
  reliable: boolean;
}

/**
 * Flags price levels whose USD size is a statistical outlier versus the
 * rest of the SAME side of the book — the "relative size vs. surrounding
 * depth" and "percentile/rank within the visible book" factors, computed
 * as one scale-invariant statistic rather than two separate hand-tuned
 * ones. Works identically whether the book totals $10K or $10M, because
 * MAD is relative to that book's own median level size.
 *
 * A degenerate near-flat book (MAD ~ 0 — every level roughly the same
 * size) cannot honestly produce an outlier read: dividing by a
 * near-zero MAD would manufacture enormous z-scores from trivial size
 * differences. Reported as `reliable: false` rather than a fabricated wall.
 */
export function detectWalls(levels: RawBookLevel[], side: WallSide): WallDetectionResult {
  if (levels.length < MIN_LEVELS_FOR_DETECTION) return { walls: [], reliable: false };

  const sizes = levels.map((l) => l.usd);
  const med = median(sizes);
  const mad = median(sizes.map((s) => Math.abs(s - med)));

  // A near-zero MAD means every level is nearly identical — nothing to
  // detect as an outlier, and computing one would divide by ~0.
  if (mad < med * 1e-6) return { walls: [], reliable: false };

  const walls: LiquidityWall[] = [];
  for (const level of levels) {
    const zScore = (MAD_SCALE * (level.usd - med)) / mad;
    // Only the LARGE-side outliers are walls — a level unusually SMALL
    // relative to its neighbors is just thin, not meaningful either way.
    if (zScore >= MODIFIED_Z_THRESHOLD) {
      walls.push({ side, price: level.price, usd: level.usd, zScore });
    }
  }
  return { walls, reliable: true };
}

export type ZoneRelationship = "backs" | "weak" | "beyond";

export interface WallZoneRelationship {
  zone: SupportResistanceZone;
  relationship: ZoneRelationship;
  /** The specific wall driving a "backs"/"beyond" read; null for "weak" (the whole point is that none was found). */
  wall: LiquidityWall | null;
}

/** How far beyond the zone's outer edge a wall still counts as "just past it" rather than unrelated — small and symmetric, since the zone itself is already ATR-derived. */
const BEYOND_TOLERANCE_PCT = 0.001; // 0.1%

/**
 * Does real resting liquidity back this structural zone right now?
 *
 * Deliberately restricted to zones whose price range the visible book
 * genuinely overlaps — per this module's own header, that is a narrow set
 * in practice (mostly zones in an active testing/rejecting/reclaiming/
 * breaking state, since those are by construction close to current price).
 * A zone with no wall found anywhere near it, however far away, is simply
 * excluded from the result rather than reported as "weak" — "weak" is
 * reserved for a zone the book COULD have confirmed but didn't, not for
 * every zone the book physically cannot reach. This function never
 * invents a relationship between price points 2% apart just because both
 * happen to exist.
 *
 * Never creates a new zone from a wall, and never used to move a stop —
 * purely descriptive: "is the existing zone backed by real orders," not
 * "here is a new level."
 */
export function classifyWallVsZones(
  bidWalls: LiquidityWall[],
  askWalls: LiquidityWall[],
  zones: SupportResistanceZone[],
  bookPriceRange: { min: number; max: number } | null
): WallZoneRelationship[] {
  if (!bookPriceRange) return [];

  const results: WallZoneRelationship[] = [];
  for (const zone of zones) {
    const tolerance = zone.priceHigh * BEYOND_TOLERANCE_PCT;
    const lo = zone.priceLow - tolerance;
    const hi = zone.priceHigh + tolerance;

    // The visible book doesn't reach this zone at all — say nothing,
    // rather than defaulting to "weak" for a zone we never actually
    // checked.
    if (hi < bookPriceRange.min || lo > bookPriceRange.max) continue;

    const relevantWalls = zone.kind === "support" ? bidWalls : askWalls;
    const backingWall = relevantWalls
      .filter((w) => w.price >= lo && w.price <= hi)
      .sort((a, b) => b.zScore - a.zScore)[0];

    if (backingWall) {
      results.push({ zone, relationship: "backs", wall: backingWall });
      continue;
    }

    // A large wall just past the zone (support broken further down /
    // resistance capped further up) — a magnet beyond the structural
    // level, not a replacement for it. Same-side walls as `backingWall`
    // above, just on the far side of the zone's range.
    const beyondWall = relevantWalls
      .filter((w) => (zone.kind === "support" ? w.price < lo : w.price > hi))
      .sort((a, b) => b.zScore - a.zScore)[0];

    results.push({
      zone,
      relationship: beyondWall ? "beyond" : "weak",
      wall: beyondWall ?? null,
    });
  }
  return results;
}

export type ExecutionPoint = "entry" | "stop" | "tp1" | "tp2";

export interface ExecutionWallContext {
  point: ExecutionPoint;
  price: number;
  /** Null means genuinely checked and found nothing nearby — distinct from `withinVisibleDepth: false`, which means the check could not be run at all at that distance. */
  wall: LiquidityWall | null;
  withinVisibleDepth: boolean;
}

/** How close a wall must be to an execution price to count as "at" it — proportional to price, matching the zone tolerance above rather than a flat dollar band. */
const EXECUTION_PROXIMITY_PCT = 0.0005; // 0.05%

/**
 * For each execution-plan price, is there a real wall right there?
 *
 * `withinVisibleDepth` exists so the UI (and this module's own tests) can
 * assert the honest common case explicitly: per this file's header
 * finding, stop/TP1/TP2 sit 50-500x farther from price than the visible
 * book reaches, so `withinVisibleDepth` will be `false` for those in
 * essentially every real setup, and ONLY entry (= current price, which by
 * definition sits inside the book) can regularly resolve to `true`. That
 * asymmetry is expected and must not be "fixed" by widening the proximity
 * band — doing so would start matching walls to prices they have no real
 * relationship to.
 */
export function executionDistanceContext(
  points: Array<{ point: ExecutionPoint; price: number }>,
  bidWalls: LiquidityWall[],
  askWalls: LiquidityWall[],
  bookPriceRange: { min: number; max: number } | null
): ExecutionWallContext[] {
  return points.map(({ point, price }) => {
    const withinVisibleDepth = bookPriceRange !== null && price >= bookPriceRange.min && price <= bookPriceRange.max;
    if (!withinVisibleDepth) return { point, price, wall: null, withinVisibleDepth };

    const tolerance = price * EXECUTION_PROXIMITY_PCT;
    const candidates = [...bidWalls, ...askWalls]
      .filter((w) => Math.abs(w.price - price) <= tolerance)
      .sort((a, b) => b.zScore - a.zScore);
    return { point, price, wall: candidates[0] ?? null, withinVisibleDepth };
  });
}

/** The full visible book's price span, for the range checks above — null when either side is empty (can't bound a range from one side alone). */
export function bookPriceRangeOf(bidWalls: RawBookLevel[], askWalls: RawBookLevel[]): { min: number; max: number } | null {
  if (bidWalls.length === 0 || askWalls.length === 0) return null;
  const prices = [...bidWalls, ...askWalls].map((l) => l.price);
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
