import { Candle, ema, sma, atr, closes } from "./indicators";
import { SupportResistanceZone, zoneTier } from "./marketStructure";
import { FibLegResult, primaryRetracements } from "./fibonacci";

/**
 * CONFLUENCE ASSESSMENT — does independent evidence agree about this price?
 *
 * ── WHY THIS IS SEPARATE FROM scoreZoneStrength ─────────────────────────
 *
 * `scoreZoneStrength` (0.5·touches + 0.3·confluence + 0.2·recency) is
 * deliberately NOT touched by this file. Its weights are unvalidated — the
 * confluence term in particular measured FLAT in this project's own testing
 * (win rate by tag count 48.0/50.3/49.4/49.5/54.5, Spearman +0.70 but not
 * monotone, overall 49.77% on 10,000 trades). Feeding a richer confluence
 * signal into a formula whose confluence weight has no demonstrated value
 * would quietly change every zone's strength with no evidence behind it.
 *
 * So this produces a SEPARATE assessment for trade decisions, and
 * `scoreZoneStrength` keeps returning exactly what it returned before.
 *
 * ── THE ANTI-DOUBLE-COUNTING RULE IS STRUCTURAL ─────────────────────────
 *
 * Factors are grouped into FAMILIES and a family can contribute AT MOST ONCE.
 * That is enforced by construction — the builder writes into a Map keyed by
 * family — not by a convention a future edit can forget.
 *
 * It matters because the obvious failure is seductive: the 20, 50, 100 and
 * 200 EMA all sloping up looks like four confirmations and is one observation
 * about trend. A weekly AND a monthly zone at the same price looks like two
 * and is one observation about higher-timeframe agreement. Counting those
 * separately is how a setup scores 7/7 on what is really 3 pieces of
 * information.
 *
 * ── WHAT A MOVING AVERAGE HAS TO DO TO COUNT ────────────────────────────
 *
 * Not merely exist. An MA is only confluence when it sits AT the zone — then
 * it is a second, independent reason that price might react there. A 200 EMA
 * 20% away tells you about trend, and trend is handled by `maTrendContext`,
 * not counted again here.
 *
 * ── WHERE THIS SHOULD BE CONSUMED (documented, not yet rewired) ─────────
 *
 * Nothing here emits a bullish/bearish verdict, deliberately. The charter
 * allows exactly one market thesis, and that is `signals/marketBias.ts`.
 * This file produces EVIDENCE ABOUT A PRICE; direction stays upstream.
 *
 * The intended consumption points, in the order they should be taken:
 *
 *   tradePlan.ts      `zone.timeframe` already renders in `entryBasis`. It
 *                     should prefer a zone whose `assessConfluence` quality is
 *                     moderate/strong when several candidate zones exist, and
 *                     `extensionTargets()` from fibonacci.ts is the natural
 *                     basis for a target beyond the next structural level.
 *                     (NOT changed here — the two-target system is frozen for
 *                     this phase by instruction.)
 *
 *   entryQuality.ts   `familyCount` is the honest input to a quality rating:
 *                     it counts independent KINDS of evidence, which is what
 *                     a star rating is trying to express.
 *
 *   plannedSetup.ts   `maTrendContext().pullbackInTrend` is precisely the
 *                     "waiting / approaching" condition this module models.
 *
 *   marketBias.ts     should remain the sole owner of direction. If anything
 *                     here ever starts voting on direction, that is the defect.
 *
 * KNOWN ARCHITECTURAL DEBT, surfaced rather than fixed in this phase:
 * `evaluators.ts`, `hypothesis.ts` and `swingThesis.ts` currently form their
 * own directional opinions without importing `marketBias`. Only
 * `exchanges/aggregator.ts` consumes it. Consolidating them is a separate,
 * larger piece of work and was explicitly out of scope here.
 */

export type ConfluenceFamily =
  | "structure"
  | "higher-timeframe"
  | "moving-average"
  | "fibonacci"
  | "price-action";

export interface ConfluenceFactor {
  family: ConfluenceFamily;
  /** Plain-English reason, for the explain-everything requirement. */
  detail: string;
  /** The price this factor points at, where it has one. */
  price?: number;
}

export interface ConfluenceAssessment {
  /** At most one per family, strongest-first. */
  factors: ConfluenceFactor[];
  /** Number of INDEPENDENT families agreeing. Not a count of indicators. */
  familyCount: number;
  /** Shorthand for callers that want a gate rather than a list. */
  quality: "none" | "weak" | "moderate" | "strong";
}

/** How close an MA or fib must be to a zone to count as "at" it, in ATRs. */
const AT_ZONE_ATR_MULT = 0.35;

export interface MovingAverages {
  ema20: number | null;
  ema21: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  sma200: number | null;
}

export function computeMovingAverages(candles: Candle[]): MovingAverages {
  const c = closes(candles);
  return {
    ema20: ema(c, 20),
    ema21: ema(c, 21),
    ema50: ema(c, 50),
    ema100: ema(c, 100),
    ema200: ema(c, 200),
    sma200: sma(c, 200),
  };
}

export type TrendDirection = "up" | "down" | "mixed" | "unknown";

export interface MaTrendContext {
  mas: MovingAverages;
  /** Price above/below each available average, collapsed to one read. */
  direction: TrendDirection;
  /** How many of the available averages price sits above. */
  above: number;
  available: number;
  /** Slope of the 200 EMA over the last 20 bars, as a percent of its own value. */
  longSlopePct: number | null;
  /** Distance from the 20/21 EMA in ATRs — how extended price is right now. */
  extensionAtr: number | null;
  /** True when price is pulling back toward the fast EMA inside an aligned trend. */
  pullbackInTrend: boolean;
}

/**
 * TREND CONTEXT — deliberately one read, not six.
 *
 * Six averages produce six numbers but one piece of information: where price
 * sits relative to its own history at several horizons. Collapsing them here
 * is what stops the decision engine treating "price is above the 20, 50, 100
 * and 200" as four independent bullish confirmations.
 */
export function maTrendContext(candles: Candle[]): MaTrendContext {
  const mas = computeMovingAverages(candles);
  const price = candles.length ? candles[candles.length - 1].close : null;
  /*
   * THE FAST EMA GETS NO VOTE ON TREND DIRECTION.
   *
   * Direction is read from the 50/100/200 EMA and 200 SMA only. The 20/21 EMA
   * is the PULLBACK REFERENCE, and including it is self-defeating: a healthy
   * pullback in an uptrend is precisely price dipping to or through the fast
   * average, which would flip `direction` to "mixed" at the exact moment the
   * setup becomes interesting. Caught by a test that asserted a trend stayed
   * "up" through a retrace and found it did not.
   */
  const list = [mas.ema50, mas.ema100, mas.ema200, mas.sma200].filter(
    (v): v is number => v !== null
  );
  const available = list.length;
  const above = price === null ? 0 : list.filter((v) => price > v).length;

  let direction: TrendDirection = "unknown";
  if (available >= 2 && price !== null) {
    if (above === available) direction = "up";
    else if (above === 0) direction = "down";
    else direction = "mixed";
  }

  // 200 EMA slope: compare it now against its value 20 bars ago. A rising
  // long average with price above it is the textbook healthy uptrend; the
  // slope is what separates that from price merely being above a flat line.
  let longSlopePct: number | null = null;
  if (candles.length >= 220) {
    const now = ema(closes(candles), 200);
    const then = ema(closes(candles.slice(0, candles.length - 20)), 200);
    if (now !== null && then !== null && then !== 0) longSlopePct = ((now - then) / then) * 100;
  }

  const a = atr(candles);
  const fast = mas.ema21 ?? mas.ema20;
  const extensionAtr = a && a > 0 && price !== null && fast !== null ? (price - fast) / a : null;

  // A pullback in trend: averages aligned, but price has come back to within
  // ~1 ATR of the fast EMA. That is the setup; being extended 4 ATRs above it
  // is the opposite of one.
  const pullbackInTrend =
    (direction === "up" || direction === "down") &&
    extensionAtr !== null &&
    Math.abs(extensionAtr) <= 1;

  return { mas, direction, above, available, longSlopePct, extensionAtr, pullbackInTrend };
}

function nearZone(price: number, zone: SupportResistanceZone, tol: number): boolean {
  return price >= zone.priceLow - tol && price <= zone.priceHigh + tol;
}

export interface ConfluenceInputs {
  zone: SupportResistanceZone;
  candles: Candle[];
  /** Higher-timeframe zones (1W/1M) to test for agreement. */
  higherZones?: SupportResistanceZone[];
  mas?: MovingAverages;
  fib?: FibLegResult | null;
}

/**
 * Assess what independently agrees with this zone.
 *
 * The returned `factors` array holds AT MOST ONE entry per family — see the
 * header. `familyCount` is therefore a count of independent kinds of evidence,
 * which is the thing worth knowing, rather than a tally of indicators.
 */
export function assessConfluence(input: ConfluenceInputs): ConfluenceAssessment {
  const { zone, candles, higherZones = [], mas, fib } = input;
  const byFamily = new Map<ConfluenceFamily, ConfluenceFactor>();
  const a = atr(candles);
  const tol = a && a > 0 ? a * AT_ZONE_ATR_MULT : (zone.priceHigh - zone.priceLow) * 0.5;
  const mid = (zone.priceLow + zone.priceHigh) / 2;

  // 1. STRUCTURE — the zone itself. Only counts when real touches formed it;
  //    a volume-profile-only zone has no discrete reaction history.
  if (zone.reactionCount >= 2) {
    byFamily.set("structure", {
      family: "structure",
      detail: `${zone.kind} zone with ${zone.reactionCount} prior reactions`,
      price: mid,
    });
  }

  // 2. HIGHER TIMEFRAME — weekly/monthly agreement. ONE factor even if BOTH
  //    weekly and monthly overlap; two higher timeframes agreeing is one kind
  //    of agreement. Prefer the more significant tier in the description.
  const overlapping = higherZones
    .filter((h) => h.kind === zone.kind && h.priceLow <= zone.priceHigh && zone.priceLow <= h.priceHigh)
    .sort((x, y) => (zoneTier(y.timeframe) === "major" ? 1 : 0) - (zoneTier(x.timeframe) === "major" ? 1 : 0));
  if (overlapping.length || zone.confluence.includes("multi-timeframe")) {
    const top = overlapping[0];
    byFamily.set("higher-timeframe", {
      family: "higher-timeframe",
      detail: top
        ? `${zoneTier(top.timeframe)} ${top.timeframe} ${top.kind} at the same price`
        : "higher-timeframe structure at the same price",
      price: top ? (top.priceLow + top.priceHigh) / 2 : undefined,
    });
  }

  // 3. MOVING AVERAGE — only when one sits AT the zone. An average far away
  //    is trend information and belongs to maTrendContext, not here.
  if (mas) {
    const candidates: Array<[string, number | null]> = [
      ["200 SMA", mas.sma200],
      ["200 EMA", mas.ema200],
      ["100 EMA", mas.ema100],
      ["50 EMA", mas.ema50],
      ["21 EMA", mas.ema21 ?? mas.ema20],
    ];
    // Longest average first: if several coincide, name the most significant
    // one. Still a SINGLE factor — "the 50 and 200 both here" is one reason
    // price may react, not two.
    const hit = candidates.find(([, v]) => v !== null && nearZone(v, zone, tol));
    if (hit) {
      byFamily.set("moving-average", {
        family: "moving-average",
        detail: `${hit[0]} sits inside the zone`,
        price: hit[1] ?? undefined,
      });
    }
  }

  // 4. FIBONACCI — only the 0.382-0.618 pullback band, and only when it lands
  //    on the zone. A fib level elsewhere is not evidence about THIS price.
  if (fib) {
    const hit = primaryRetracements(fib).find((l) => nearZone(l.price, zone, tol));
    if (hit) {
      byFamily.set("fibonacci", {
        family: "fibonacci",
        detail: `${(hit.ratio * 100).toFixed(1)}% retracement of the last ${fib.direction}-leg lands here`,
        price: hit.price,
      });
    }
  }

  // 5. PRICE ACTION — a demonstrated reaction, not a proximity. "rejecting"
  //    and "reclaiming" are events; "testing" is merely where price is.
  if (zone.status === "rejecting" || zone.status === "reclaiming") {
    byFamily.set("price-action", {
      family: "price-action",
      detail: zone.status === "reclaiming" ? "level was lost and has been reclaimed" : "price rejected from the zone",
      price: mid,
    });
  }

  const order: ConfluenceFamily[] = ["structure", "higher-timeframe", "price-action", "moving-average", "fibonacci"];
  const factors = order.map((f) => byFamily.get(f)).filter((f): f is ConfluenceFactor => f !== undefined);

  const familyCount = factors.length;
  const quality: ConfluenceAssessment["quality"] =
    familyCount >= 4 ? "strong" : familyCount === 3 ? "moderate" : familyCount >= 1 ? "weak" : "none";

  return { factors, familyCount, quality };
}
