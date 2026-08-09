import { Candle, atr, highs, lows } from "./indicators";
import { findSwingPoints } from "./divergence";
import { clamp } from "../sentiment/compositeIndex";

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

// ─────────────────────────────────────────────────────────────────────────
// Support/resistance ZONES.
//
// Why this exists: a single fibonacci swing-window price is not "support" —
// real support is a PRICE AREA that has repeatedly turned price away.
// This module finds actual swing touches, clusters the ones that cluster
// (a real "level" needs >=2 independent touches, not one), and reports a
// price RANGE, a strength score driven by how many times and how
// independently that range has mattered, and the zone's current
// relationship to price (approaching/testing/rejecting/reclaiming/
// breaking/inactive) — never a bare precise number dressed up as a level.
// ─────────────────────────────────────────────────────────────────────────

export type ConfluenceTag = "swing-cluster" | "volume-poc" | "value-area-edge";
export type ZoneStatus = "approaching" | "testing" | "rejecting" | "reclaiming" | "breaking" | "inactive";

export interface SupportResistanceZone {
  priceLow: number;
  priceHigh: number;
  kind: "support" | "resistance";
  /** 0-100, same convention as TechnicalRead.strength — not a 1-5 star scale. */
  strength: number;
  /** Independent swing touches that cluster into this zone. 0 for a zone built purely from the volume profile — there is no discrete "touch" concept for volume, so 0 means "not applicable," not "no evidence." */
  reactionCount: number;
  /** Which independent methods agree this zone matters. Empty when only the zone's own source method found it. */
  confluence: ConfluenceTag[];
  status: ZoneStatus;
  /** Bars since the most recent swing touch. Null when reactionCount is 0 (no swing touches to measure from). */
  mostRecentTouchBarsAgo: number | null;
  source: "swing-cluster" | "volume-poc";
}

/** Swing touches within this many ATRs of a cluster's running mean join that cluster — adapts to the asset's own volatility rather than a flat percentage. */
const CLUSTER_TOLERANCE_ATR_MULT = 0.5;
const ZONE_SWING_LOOKBACK = 3;
/** Reaction count saturates the strength contribution at this many touches — a 5th touch shouldn't keep mattering as much as the jump from 1 to 4 did. */
const STRENGTH_TOUCH_SATURATION = 4;
/** Confluence-tag count saturates at this many independent methods agreeing. */
const STRENGTH_CONFLUENCE_SATURATION = 2;
/** Recency window for the strength score's decay term — reuses VOLUME_PROFILE_WINDOW's own 90-day horizon rather than inventing a second constant for the same "how far back still counts" question. */
const STRENGTH_RECENCY_WINDOW_BARS = VOLUME_PROFILE_WINDOW;
const STATUS_LOOKBACK_BARS = 5;
/** How close (in ATRs) price must be to count as "at" a zone for testing/breaking/reclaiming purposes. */
const STATUS_PROXIMITY_ATR_MULT = 0.25;
/** How many bars back a touch can have happened and still count toward "rejecting" (touched recently, now moving away). */
const STATUS_REJECT_WINDOW_BARS = 4;

interface SwingTouch {
  price: number;
  /** Index into the candles array this touch was found in. */
  index: number;
}

/** Greedy 1D clustering by running-cluster-mean: a touch joins the current cluster if it's within `tolerance` of that cluster's mean so far, otherwise it starts a new one. Input must already be sorted by price. */
export function clusterTouches(sortedByPrice: SwingTouch[], tolerance: number): SwingTouch[][] {
  if (sortedByPrice.length === 0) return [];
  const clusters: SwingTouch[][] = [[sortedByPrice[0]]];
  for (let i = 1; i < sortedByPrice.length; i++) {
    const touch = sortedByPrice[i];
    const cluster = clusters[clusters.length - 1];
    const clusterMean = cluster.reduce((sum, t) => sum + t.price, 0) / cluster.length;
    if (Math.abs(touch.price - clusterMean) <= tolerance) {
      cluster.push(touch);
    } else {
      clusters.push([touch]);
    }
  }
  return clusters;
}

/** A single swing touch isn't a "level" by this feature's own definition — repeated reactions are the point. Clusters with only one touch are dropped. */
export function zonesFromClusters(clusters: SwingTouch[][], kind: "support" | "resistance", totalBars: number): SupportResistanceZone[] {
  return clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => {
      const prices = cluster.map((t) => t.price);
      const mostRecentIndex = Math.max(...cluster.map((t) => t.index));
      return {
        priceLow: Math.min(...prices),
        priceHigh: Math.max(...prices),
        kind,
        strength: 0, // filled in after confluence tagging, see scoreZone
        reactionCount: cluster.length,
        confluence: [] as ConfluenceTag[],
        status: "inactive" as ZoneStatus, // filled in after, see classifyZoneStatus
        mostRecentTouchBarsAgo: totalBars - 1 - mostRecentIndex,
        source: "swing-cluster" as const,
      };
    });
}

/**
 * Merges zones of the SAME kind whose ranges overlap or sit within
 * `tolerance` of each other — this is where confluence actually happens:
 * a swing-cluster zone and a volume-poc zone landing in the same place
 * become ONE wider, stronger zone (union of range, summed reaction count,
 * combined confluence tags) rather than two separate near-duplicate
 * entries. Deliberately does NOT merge across kinds — a volume-poc zone
 * disagreeing in kind with an overlapping swing-cluster zone means price
 * has moved through that area since the swing formed, which is real,
 * distinct information (surfaced via status, not hidden by merging).
 */
export function mergeOverlappingZones(zones: SupportResistanceZone[], tolerance: number): SupportResistanceZone[] {
  const bySupport = zones.filter((z) => z.kind === "support").sort((a, b) => a.priceLow - b.priceLow);
  const byResistance = zones.filter((z) => z.kind === "resistance").sort((a, b) => a.priceLow - b.priceLow);

  const mergeGroup = (group: SupportResistanceZone[]): SupportResistanceZone[] => {
    const merged: SupportResistanceZone[] = [];
    for (const zone of group) {
      const last = merged[merged.length - 1];
      if (last && zone.priceLow <= last.priceHigh + tolerance) {
        last.priceLow = Math.min(last.priceLow, zone.priceLow);
        last.priceHigh = Math.max(last.priceHigh, zone.priceHigh);
        last.reactionCount += zone.reactionCount;
        const tags = new Set<ConfluenceTag>([...last.confluence, ...zone.confluence, last.source, zone.source]);
        last.confluence = [...tags];
        last.mostRecentTouchBarsAgo =
          last.mostRecentTouchBarsAgo === null
            ? zone.mostRecentTouchBarsAgo
            : zone.mostRecentTouchBarsAgo === null
              ? last.mostRecentTouchBarsAgo
              : Math.min(last.mostRecentTouchBarsAgo, zone.mostRecentTouchBarsAgo);
      } else {
        merged.push({ ...zone });
      }
    }
    return merged;
  };

  return [...mergeGroup(bySupport), ...mergeGroup(byResistance)];
}

export function scoreZoneStrength(zone: SupportResistanceZone): number {
  const touchComponent = clamp(zone.reactionCount / STRENGTH_TOUCH_SATURATION, 0, 1);
  const confluenceComponent = clamp(zone.confluence.length / STRENGTH_CONFLUENCE_SATURATION, 0, 1);
  const recencyComponent =
    zone.mostRecentTouchBarsAgo === null ? 0 : clamp(1 - zone.mostRecentTouchBarsAgo / STRENGTH_RECENCY_WINDOW_BARS, 0, 1);
  return Math.round(100 * (0.5 * touchComponent + 0.3 * confluenceComponent + 0.2 * recencyComponent));
}

type ZoneSide = "above" | "below" | "inside";

function sideOf(closePrice: number, zone: { priceLow: number; priceHigh: number }, band: number): ZoneSide {
  if (closePrice > zone.priceHigh + band) return "above";
  if (closePrice < zone.priceLow - band) return "below";
  return "inside";
}

/**
 * Status is relative to the zone's "safe" side (below, for resistance;
 * above, for support) and "broken" side (the opposite). Breaking = price
 * was on the safe side ~STATUS_LOOKBACK_BARS ago and has since moved to,
 * and held, the broken side. Reclaiming is the exact mirror: price was
 * recently on the broken side and has moved back to, and held, the safe
 * side. This is a deliberate simplification of real trading language (the
 * two are treated as strict mirrors of each other, not independently
 * defined) — documented here so the exact rule is transparent, not implied.
 *
 * Only ever inspects `candles.slice(-N)` of whatever array it's handed —
 * never anything outside the array, never `Date.now()` — so it stays
 * look-ahead-safe under the backtest's `candles.filter(c => c.t < t)`
 * convention the same way every other function in this file already is.
 */
export function classifyZoneStatus(
  zone: { priceLow: number; priceHigh: number; kind: "support" | "resistance" },
  candles: Candle[],
  atrValue: number
): ZoneStatus {
  const n = candles.length;
  if (n < STATUS_LOOKBACK_BARS + 2) return "inactive";

  const band = atrValue * STATUS_PROXIMITY_ATR_MULT;
  const safeSide: ZoneSide = zone.kind === "resistance" ? "below" : "above";
  const brokenSide: ZoneSide = zone.kind === "resistance" ? "above" : "below";
  const overlapsZone = (c: Candle) => c.low <= zone.priceHigh && c.high >= zone.priceLow;

  const recentBars = candles.slice(-STATUS_LOOKBACK_BARS);
  if (recentBars.slice(-2).some(overlapsZone)) return "testing";

  const last3Sides = candles.slice(-3).map((c) => sideOf(c.close, zone, band));
  const sustainedSafe = last3Sides.filter((s) => s === safeSide).length >= 2;
  const sustainedBroken = last3Sides.filter((s) => s === brokenSide).length >= 2;
  const priorSide = sideOf(recentBars[0].close, zone, band);

  if (priorSide === safeSide && sustainedBroken) return "breaking";
  if (priorSide === brokenSide && sustainedSafe) return "reclaiming";

  const rejectWindow = candles.slice(-STATUS_REJECT_WINDOW_BARS, -2);
  const touchedRecently = rejectWindow.some(overlapsZone);
  const currentSide = sideOf(candles[n - 1].close, zone, band);
  if (touchedRecently && currentSide === safeSide) return "rejecting";

  const distance = (close: number) => (close > zone.priceHigh ? close - zone.priceHigh : close < zone.priceLow ? zone.priceLow - close : 0);
  const currentDistance = distance(candles[n - 1].close);
  const priorDistance = distance(candles[n - 2].close);
  if (currentDistance > 0 && currentDistance <= band * 2 && currentDistance < priorDistance) return "approaching";

  return "inactive";
}

/**
 * The rich replacement for `buildSupportResistance()` — real swing
 * clustering (via `findSwingPoints` from divergence.ts, called once on
 * highs for resistance candidates and once on lows for support, not a
 * second detector) plus the volume profile's point of control, merged
 * where they overlap, scored, and given a live status. Fib-derived levels
 * are deliberately NOT their own zone source here (see this file's other
 * doc comments on avoiding duplicated signal) — they were always a weaker,
 * secondary read on the exact swing extremes this clustering now finds
 * directly and more richly.
 */
export function buildSupportResistanceZones(candles: Candle[], profile: VolumeProfileResult | null): SupportResistanceZone[] {
  const atrValue = atr(candles);
  if (atrValue === null || atrValue <= 0) return [];
  const price = candles.length ? candles[candles.length - 1].close : null;
  if (price === null) return [];

  const tolerance = atrValue * CLUSTER_TOLERANCE_ATR_MULT;

  const highSwings = findSwingPoints(highs(candles), ZONE_SWING_LOOKBACK)
    .filter((s) => s.kind === "high")
    .map((s): SwingTouch => ({ price: s.value, index: s.index }))
    .sort((a, b) => a.price - b.price);
  const lowSwings = findSwingPoints(lows(candles), ZONE_SWING_LOOKBACK)
    .filter((s) => s.kind === "low")
    .map((s): SwingTouch => ({ price: s.value, index: s.index }))
    .sort((a, b) => a.price - b.price);

  let zones: SupportResistanceZone[] = [
    ...zonesFromClusters(clusterTouches(highSwings, tolerance), "resistance", candles.length),
    ...zonesFromClusters(clusterTouches(lowSwings, tolerance), "support", candles.length),
  ];

  if (profile) {
    const pocMid = (profile.pointOfControl.priceLow + profile.pointOfControl.priceHigh) / 2;
    zones.push({
      priceLow: profile.pointOfControl.priceLow,
      priceHigh: profile.pointOfControl.priceHigh,
      kind: pocMid > price ? "resistance" : "support",
      strength: 0,
      reactionCount: 0,
      confluence: [],
      status: "inactive",
      mostRecentTouchBarsAgo: null,
      source: "volume-poc",
    });
  }

  zones = mergeOverlappingZones(zones, tolerance);

  if (profile) {
    for (const zone of zones) {
      const nearEdge = (edge: number) => edge >= zone.priceLow - tolerance && edge <= zone.priceHigh + tolerance;
      if (nearEdge(profile.valueAreaHigh) || nearEdge(profile.valueAreaLow)) {
        if (!zone.confluence.includes("value-area-edge")) zone.confluence.push("value-area-edge");
      }
    }
  }

  for (const zone of zones) {
    zone.strength = scoreZoneStrength(zone);
    zone.status = classifyZoneStatus(zone, candles, atrValue);
  }

  return zones.sort((a, b) => a.priceLow - b.priceLow);
}
