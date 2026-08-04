import { Candle, FibonacciResult } from "./indicators";

/**
 * Volume profile and support/resistance — approximated from the SAME daily
 * OHLCV candles already fetched for `buildTechnicalRead` (no new provider,
 * no new fetch). Sibling to `indicators.ts`, same pure-math-no-I/O
 * convention, kept in its own file because this is market STRUCTURE
 * (where does price sit relative to where volume/swings have concentrated),
 * a different question from `indicators.ts`'s trend/momentum math.
 *
 * Feeds the Liquidity Map dashboard section — a structural read, not a
 * directional bullish/bearish one, so nothing here returns a Verdict.
 */

export interface VolumeProfileLevel {
  priceLow: number;
  priceHigh: number;
  volumeUsd: number;
}

export interface VolumeProfileResult {
  levels: VolumeProfileLevel[];
  /** The single price bucket with the most traded volume — the "fair value" area. */
  pointOfControl: VolumeProfileLevel;
  /** Contiguous bucket range holding ~70% of total volume, the conventional "value area". */
  valueAreaHigh: number;
  valueAreaLow: number;
}

const VOLUME_PROFILE_BUCKETS = 24;
const VOLUME_PROFILE_WINDOW = 90;
/** Standard value-area definition: the price range containing 70% of traded volume. */
const VALUE_AREA_PCT = 0.7;

/**
 * Approximates a volume profile from OHLCV: no tick data exists in this
 * app, so each daily bar's volume is distributed across the price buckets
 * its own `[low, high]` range overlaps, weighted by overlap fraction — the
 * standard approach for building a volume profile when only OHLCV is
 * available. Disclosed in the UI as an approximation, same convention as
 * `fibonacciRetracement`'s window disclosure, never presented as a
 * tick-accurate reconstruction.
 */
export function buildVolumeProfile(candles: Candle[], window = VOLUME_PROFILE_WINDOW): VolumeProfileResult | null {
  if (candles.length < window) return null;
  const recent = candles.slice(candles.length - window);

  const high = Math.max(...recent.map((c) => c.high));
  const low = Math.min(...recent.map((c) => c.low));
  if (high <= low) return null;

  const bucketSize = (high - low) / VOLUME_PROFILE_BUCKETS;
  const levels: VolumeProfileLevel[] = Array.from({ length: VOLUME_PROFILE_BUCKETS }, (_, i) => ({
    priceLow: low + i * bucketSize,
    priceHigh: low + (i + 1) * bucketSize,
    volumeUsd: 0,
  }));

  for (const c of recent) {
    const barLow = Math.max(c.low, low);
    const barHigh = Math.min(c.high, high);
    if (barHigh <= barLow) continue;
    for (const level of levels) {
      const overlapLow = Math.max(level.priceLow, barLow);
      const overlapHigh = Math.min(level.priceHigh, barHigh);
      if (overlapHigh <= overlapLow) continue;
      const overlapFrac = (overlapHigh - overlapLow) / (barHigh - barLow);
      level.volumeUsd += c.volumeUsd * overlapFrac;
    }
  }

  let pointOfControl = levels[0];
  for (const l of levels) {
    if (l.volumeUsd > pointOfControl.volumeUsd) pointOfControl = l;
  }

  // Value area: expand outward from the POC bucket, adding whichever
  // neighbor (above/below) has more volume, until VALUE_AREA_PCT of total
  // volume is enclosed — the standard value-area-expansion algorithm.
  const totalVolume = levels.reduce((s, l) => s + l.volumeUsd, 0);
  const pocIndex = levels.indexOf(pointOfControl);
  let lo = pocIndex;
  let hi = pocIndex;
  let enclosed = pointOfControl.volumeUsd;
  while (enclosed < totalVolume * VALUE_AREA_PCT && (lo > 0 || hi < levels.length - 1)) {
    const below = lo > 0 ? levels[lo - 1].volumeUsd : -1;
    const above = hi < levels.length - 1 ? levels[hi + 1].volumeUsd : -1;
    if (above >= below) {
      hi++;
      enclosed += levels[hi].volumeUsd;
    } else {
      lo--;
      enclosed += levels[lo].volumeUsd;
    }
  }

  return {
    levels,
    pointOfControl,
    valueAreaHigh: levels[hi].priceHigh,
    valueAreaLow: levels[lo].priceLow,
  };
}

export interface SupportResistanceLevel {
  price: number;
  kind: "support" | "resistance";
  /** Where this level came from, so the UI's "why" line doesn't need a separate lookup. */
  source: "swing-high" | "swing-low" | "fib-level" | "volume-poc" | "value-area-edge";
}

/**
 * Reuses `fibonacciRetracement`'s already-computed swing high/low and ratio
 * levels rather than reinventing swing detection — those two extremes are
 * the two hardest, most obvious S/R levels; the ratio levels in between are
 * secondary, softer ones. Adds the volume profile's point of control and
 * value-area edges alongside (a genuinely independent method — price-range
 * geometry vs. volume distribution — so agreement between the two is itself
 * useful information for the UI to show, not redundant).
 */
export function buildSupportResistance(
  candles: Candle[],
  fib: FibonacciResult | null,
  profile: VolumeProfileResult | null
): SupportResistanceLevel[] {
  const price = candles.length ? candles[candles.length - 1].close : null;
  if (price === null) return [];

  const levels: SupportResistanceLevel[] = [];

  if (fib) {
    levels.push({ price: fib.swingHigh, kind: "resistance", source: "swing-high" });
    levels.push({ price: fib.swingLow, kind: "support", source: "swing-low" });
    for (const l of fib.levels) {
      if (l.ratio === 0 || l.ratio === 1) continue; // already added above as swing high/low
      levels.push({ price: l.price, kind: l.price > price ? "resistance" : "support", source: "fib-level" });
    }
  }

  if (profile) {
    const pocMid = (profile.pointOfControl.priceLow + profile.pointOfControl.priceHigh) / 2;
    levels.push({ price: pocMid, kind: pocMid > price ? "resistance" : "support", source: "volume-poc" });
    levels.push({ price: profile.valueAreaHigh, kind: "resistance", source: "value-area-edge" });
    levels.push({ price: profile.valueAreaLow, kind: "support", source: "value-area-edge" });
  }

  return levels.sort((a, b) => a.price - b.price);
}
