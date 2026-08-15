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

export type ConfluenceTag = "swing-cluster" | "volume-poc" | "value-area-edge" | "multi-timeframe";

/**
 * Which chart a level came from. `"both"` means the daily and 4H series
 * independently produced an overlapping zone — the strongest confirmation
 * available here, since the two are computed from different bar sets rather
 * than one being a resample of the other.
 */
export type ZoneTimeframe = "1D" | "4H" | "both";
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
  /** Which chart produced this level. See ZoneTimeframe. */
  timeframe: ZoneTimeframe;
}

/** Swing touches within this many ATRs of a cluster's running mean join that cluster — adapts to the asset's own volatility rather than a flat percentage. */
const CLUSTER_TOLERANCE_ATR_MULT = 0.5;
/**
 * A zone may span at most this many ATRs, end to end.
 *
 * ── Why a cap is needed at all ────────────────────────────────────────
 *
 * The tolerance above bounds each STEP, not the total extent, and it is
 * measured against the cluster's RUNNING MEAN — which moves toward every
 * touch that joins. So a chain of touches, each individually within half an
 * ATR of a drifting centre, walks the cluster across an unbounded range.
 * Classic single-linkage chaining.
 *
 * It reached production: CIFR carried a "support" spanning $11.01–$19.39 —
 * 3.3 ATR, 50% of the share price, straddling spot — built from 22 touches
 * on a 0.5 ATR tolerance. A band that wide is not a level. You cannot place
 * an entry at it, you cannot place a stop beyond it, and price moving from
 * one edge to the other is a multi-day move.
 *
 * ── Why 1.0 ────────────────────────────────────────────────────────────
 *
 * Not tuned. The tolerance is a RADIUS of 0.5 ATR around a level's centre,
 * so the widest thing that tolerance can honestly describe is 2 x 0.5 = 1.0
 * ATR end to end. This constant makes `CLUSTER_TOLERANCE_ATR_MULT` mean what
 * its name already claimed; picking anything larger would be choosing a
 * number because it changed fewer zones.
 */
const MAX_ZONE_WIDTH_ATR_MULT = 1.0;
const ZONE_SWING_LOOKBACK = 3;
/** Reaction count saturates the strength contribution at this many touches — a 5th touch shouldn't keep mattering as much as the jump from 1 to 4 did. */
const STRENGTH_TOUCH_SATURATION = 4;
/** Confluence-tag count saturates at this many independent methods agreeing. */
const STRENGTH_CONFLUENCE_SATURATION = 2;
/** Recency window for the strength score's decay term — reuses VOLUME_PROFILE_WINDOW's own 90-day horizon rather than inventing a second constant for the same "how far back still counts" question. */
const STRENGTH_RECENCY_WINDOW_BARS = VOLUME_PROFILE_WINDOW;
/**
 * How much history a level can be built from. Matches OKX's own 300-candle
 * cap, which is what every crypto caller was already bounded by — see the
 * long note in `buildSupportResistanceZones`. Roughly 14 months of dailies:
 * long enough to hold several full swings, short enough that the clustering
 * tolerance (a fraction of CURRENT ATR) stays meaningful across the range.
 */
const STRUCTURE_WINDOW_BARS = 300;
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

/**
 * Greedy 1D clustering by running-cluster-mean, BOUNDED IN TOTAL EXTENT.
 *
 * A touch joins the current cluster when it is both within `tolerance` of
 * that cluster's mean so far AND close enough that the cluster's full span
 * stays inside `maxWidth`. Otherwise it starts a new one. Input must already
 * be sorted by price.
 *
 * The second condition is the one that matters. Without it the tolerance
 * bounds each step while the mean drifts toward every new member, so touches
 * chain outward indefinitely — see `MAX_ZONE_WIDTH_ATR_MULT` for the zone
 * this produced in production.
 *
 * `maxWidth` is optional so the existing tests, which pass a bare tolerance,
 * keep describing the clustering rule rather than the cap. Callers inside
 * this module always supply it.
 */
export function clusterTouches(
  sortedByPrice: SwingTouch[],
  tolerance: number,
  maxWidth = Infinity
): SwingTouch[][] {
  if (sortedByPrice.length === 0) return [];
  const clusters: SwingTouch[][] = [[sortedByPrice[0]]];
  for (let i = 1; i < sortedByPrice.length; i++) {
    const touch = sortedByPrice[i];
    const cluster = clusters[clusters.length - 1];
    const clusterMean = cluster.reduce((sum, t) => sum + t.price, 0) / cluster.length;

    /*
     * Sorted ascending, so the cluster's low is its first member and the
     * candidate is always the new high. No need to scan.
     *
     * Tolerance is checked against the running MEAN, which admits more than
     * `tolerance` of total span: the mean sits at most span/k below the top,
     * so the bound is k×tolerance, growing with cluster size. Reaching it
     * needs mass piled at the leading edge, which separated swing pivots do
     * not produce — capping this alone left the real 60-instrument panel
     * byte-identical. It is kept as the bound on that path, not as the fix.
     * The fix is the identical cap in mergeOverlappingZones, which is where
     * the degenerate widths were actually being manufactured.
     */
    const spanIfJoined = touch.price - cluster[0].price;

    if (Math.abs(touch.price - clusterMean) <= tolerance && spanIfJoined <= maxWidth) {
      cluster.push(touch);
    } else {
      clusters.push([touch]);
    }
  }
  return clusters;
}

/** A single swing touch isn't a "level" by this feature's own definition — repeated reactions are the point. Clusters with only one touch are dropped. */
export function zonesFromClusters(
  clusters: SwingTouch[][],
  kind: "support" | "resistance",
  totalBars: number,
  timeframe: ZoneTimeframe = "1D"
): SupportResistanceZone[] {
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
        timeframe,
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
export function mergeOverlappingZones(
  zones: SupportResistanceZone[],
  tolerance: number,
  maxWidth = Infinity
): SupportResistanceZone[] {
  const bySupport = zones.filter((z) => z.kind === "support").sort((a, b) => a.priceLow - b.priceLow);
  const byResistance = zones.filter((z) => z.kind === "resistance").sort((a, b) => a.priceLow - b.priceLow);

  const mergeGroup = (group: SupportResistanceZone[]): SupportResistanceZone[] => {
    const merged: SupportResistanceZone[] = [];
    for (const zone of group) {
      const last = merged[merged.length - 1];
      /*
       * THE SECOND CHAINING SITE, and the one that actually produced the
       * degenerate bands. Capping `clusterTouches` alone changed nothing,
       * because this merge runs afterwards and re-widens: each zone starting
       * within `tolerance` of the running `priceHigh` extends it, so a row of
       * adjacent levels folds into one band of unbounded width.
       *
       * When merging would breach the cap the zones stay SEPARATE, which is
       * the honest reading — two levels close together are two levels, not
       * one wide one.
       */
      const spanIfMerged = last ? Math.max(last.priceHigh, zone.priceHigh) - Math.min(last.priceLow, zone.priceLow) : 0;
      if (last && zone.priceLow <= last.priceHigh + tolerance && spanIfMerged <= maxWidth) {
        last.priceLow = Math.min(last.priceLow, zone.priceLow);
        last.priceHigh = Math.max(last.priceHigh, zone.priceHigh);
        last.reactionCount += zone.reactionCount;
        const tags = new Set<ConfluenceTag>([...last.confluence, ...zone.confluence, last.source, zone.source]);
        /*
         * Two charts independently finding a level in the same place is the
         * strongest confirmation available here — the daily and 4H series
         * are separate bar sets, not a resample of one another, so this is
         * genuine agreement rather than the same evidence counted twice.
         */
        if (last.timeframe !== zone.timeframe) {
          last.timeframe = "both";
          tags.add("multi-timeframe");
        }
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
export function buildSupportResistanceZones(
  allCandles: Candle[],
  profile: VolumeProfileResult | null,
  timeframe: ZoneTimeframe = "1D"
): SupportResistanceZone[] {
  /*
   * WINDOWED HERE, not left to the caller.
   *
   * This function used to cluster whatever series it was handed. For crypto
   * that was harmless — OKX caps its candle endpoint at 300 with no
   * pagination, so the input was bounded by the API — and the replay sliced
   * to the same 300 to match. Nothing documented the dependency, because
   * nothing had violated it.
   *
   * Then equities arrived with 8,440 daily bars of SPY going back to 1993,
   * and the result was not a longer list of levels, it was WRONG levels: the
   * clustering tolerance is a fraction of CURRENT ATR (~$9 on a $770 index),
   * which is enormous relative to 1990s prices, so every level under $135
   * collapsed into one "zone" spanning 470% of its own low. Fifty-seven zones
   * came back, the widest of them meaningless, and they fed trade planning
   * and entry quality as well as the display.
   *
   * A function whose correctness depends on an undocumented caller invariant
   * is a trap, and this one has now been sprung. So the window lives here.
   * `buildVolumeProfile` already windows its own input the same way.
   *
   * 300 is a strict no-op for both existing callers — the OKX cap and the
   * replay's LIVE_CANDLE_LIMIT are both already 300 — so this changes no
   * crypto behaviour and no published statistic.
   */
  const candles = allCandles.slice(-STRUCTURE_WINDOW_BARS);
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

  const maxWidth = atrValue * MAX_ZONE_WIDTH_ATR_MULT;
  let zones: SupportResistanceZone[] = [
    ...zonesFromClusters(clusterTouches(highSwings, tolerance, maxWidth), "resistance", candles.length, timeframe),
    ...zonesFromClusters(clusterTouches(lowSwings, tolerance, maxWidth), "support", candles.length, timeframe),
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
      timeframe,
    });
  }

  zones = mergeOverlappingZones(zones, tolerance, maxWidth);

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

/**
 * Combines daily and 4H structure into one set of levels.
 *
 * The DAILY series is the authority for major structure and supplies the
 * clustering tolerance and the status classification — a level's meaning
 * ("testing", "breaking") is a statement about the swing chart, and
 * re-deriving it from 4H bars would make a level look reclaimed on a wick
 * the daily chart never registered.
 *
 * 4H zones exist to ADD PRECISION, never to override: they either overlap a
 * daily zone (merging into it, which marks the level `"both"` and tags it
 * multi-timeframe) or they stand alone as a finer level between the major
 * ones. A 4H-only level can therefore tighten an entry, but can never move
 * a daily level or invent a major one.
 *
 * Both series are already fetched and swr-cached by the aggregator, so this
 * costs no additional requests.
 */
export function mergeTimeframeZones(
  dailyZones: SupportResistanceZone[],
  fourHourZones: SupportResistanceZone[],
  dailyCandles: Candle[]
): SupportResistanceZone[] {
  const atrValue = atr(dailyCandles);
  if (atrValue === null || atrValue <= 0) return dailyZones;

  // Daily first: mergeOverlappingZones folds later zones into earlier ones,
  // so leading with daily keeps the daily range as the anchor a 4H zone
  // widens, rather than the other way round.
  //
  // That widening is capped for the same reason it is inside a single
  // timeframe. Both inputs already respect the cap, so a merge is only
  // declined when the union genuinely exceeds it — meaning the two barely
  // overlap and folding them would manufacture a band wider than either
  // chart found. Declining costs the multi-timeframe tag on that pair, which
  // is the right trade: they were not the same level.
  const merged = mergeOverlappingZones(
    [...dailyZones, ...fourHourZones],
    atrValue * CLUSTER_TOLERANCE_ATR_MULT,
    atrValue * MAX_ZONE_WIDTH_ATR_MULT
  );

  for (const zone of merged) {
    zone.strength = scoreZoneStrength(zone);
    zone.status = classifyZoneStatus(zone, dailyCandles, atrValue);
  }

  return merged.sort((a, b) => a.priceLow - b.priceLow);
}


/**
 * THE NEAREST LEVEL EITHER SIDE OF PRICE — one definition, three consumers.
 *
 * The research page shows these as levels to watch, the nightly job
 * registers them as forward predictions, and the replay measured how often
 * price reaches them. Those three MUST select the same zone from the same
 * price or the published odds describe one level, the record scores a
 * second, and the reader is shown a third.
 *
 * That is not a hypothetical: this rule existed as four separate copies
 * before it was extracted here, with a comment in one of them warning that
 * they must not diverge — which is a note, not a mechanism.
 *
 * The EDGE is what price reaches first: the TOP of a support zone coming
 * down, the BOTTOM of a resistance zone coming up. Using a zone's midpoint
 * would systematically overstate the distance and understate the odds.
 */
export interface NearestStructure {
  support: SupportResistanceZone | null;
  resistance: SupportResistanceZone | null;
}

export function nearestWatchLevels(zones: SupportResistanceZone[], price: number): NearestStructure {
  return {
    support:
      zones
        .filter((z) => z.kind === "support" && z.priceHigh < price)
        .sort((a, b) => b.priceHigh - a.priceHigh)[0] ?? null,
    resistance:
      zones
        .filter((z) => z.kind === "resistance" && z.priceLow > price)
        .sort((a, b) => a.priceLow - b.priceLow)[0] ?? null,
  };
}

/** The price a zone is first reached at, given the side approaching it. */
export function watchEdge(zone: SupportResistanceZone, direction: "long" | "short"): number {
  return direction === "long" ? zone.priceHigh : zone.priceLow;
}
