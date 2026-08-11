/**
 * The one place a swing trade's execution geometry is decided.
 *
 * Extracted from swingThesis.ts because two callers now need it: the
 * ACTIVATED thesis (a trade the evidence supports taking) and the PLANNED
 * setup (a conditional level we're waiting for price to reach). Those are
 * different products, but they must describe the same level the same way —
 * a planned entry at $1,800 that becomes a different entry at $1,800 the
 * moment a thesis activates would be indefensible.
 *
 * Everything here is pure and frozen-by-construction: given the same close
 * price, ATR and zones, it returns the same plan every time. Nothing reads
 * a clock or a live tick.
 */

import {
  StarRating,
  buildEntryQuality,
  EntryQualityInputs,
  MIN_RR,
  STRUCTURAL_STOP_MIN_ATR,
} from "./entryQuality";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";

export type TradeDirection = "long" | "short";

/**
 * Every execution number, fixed at the moment the plan was built. Nothing
 * in here is ever recomputed from a later tick — that recomputation was the
 * original source of entries and stops moving every 15 seconds.
 */
export interface TradePlan {
  /** Entry is a ZONE, not a tick. See `buildEntryZone`. */
  entryLow: number;
  entryHigh: number;
  entryBasis: string;
  /** The single reference price the plan's risk/reward was measured from. */
  entryRef: number;
  stopPrice: number;
  stopBasis: string;
  target1Price: number;
  target1Basis: string;
  target2Price: number;
  target2Basis: string;
  riskRewardRatio: number;
  riskRewardRatio2: number;
  stars: StarRating;
  starRationale: string;
  /** ATR in price terms when the plan was built, retained for context alongside the frozen levels. */
  atrAbs: number;
  /**
   * How far past the entry price may run before the setup reads MISSED.
   * Frozen onto the plan rather than read from config at tick time, so a
   * live plan keeps the geometry it was built with even if config is
   * retuned later.
   */
  missedDistance: number;
  /** The close price the plan was built from — the anchor "has price run away" is measured against. */
  anchorPrice: number;
  /** Structure snapshot, so displayed context can't drift out from under the frozen levels. */
  supportZone: SupportResistanceZone | null;
  resistanceZone: SupportResistanceZone | null;
}

export interface TradePlanConfig {
  /** A pullback zone farther than this many ATRs isn't a realistic swing entry; fall back to an at-market band. */
  entryPullbackMaxAtr: number;
  /** Half-width of the at-market entry band when no pullback level is in reach. */
  atMarketBandAtr: number;
  /** How far beyond the anchor price counts as "ran away". */
  missedAtr: number;
}

export const DEFAULT_TRADE_PLAN_CONFIG: TradePlanConfig = {
  entryPullbackMaxAtr: 1.5,
  atMarketBandAtr: 0.25,
  missedAtr: 1,
};

/**
 * Buffer placed beyond the retested zone when the plan enters INTO that
 * zone. A stop at the zone's own edge would sit inside the noise the zone
 * is made of.
 */
const PULLBACK_STOP_BUFFER_ATR = 0.25;

/**
 * Derives the entry ZONE.
 *
 * A swing entry is a pullback into structure, not "wherever price happened
 * to be when the engine polled". So the zone is the nearest protective S/R
 * zone — support for a long, resistance for a short — provided it sits
 * within `entryPullbackMaxAtr` of the anchor. When nothing is in reach,
 * waiting for a retest that structure doesn't support would be fiction, so
 * the zone collapses to an explicit at-market band and says so.
 */
export function buildEntryZone(
  direction: TradeDirection,
  anchorPrice: number,
  atrAbs: number,
  zone: SupportResistanceZone | null,
  config: TradePlanConfig = DEFAULT_TRADE_PLAN_CONFIG
): { entryLow: number; entryHigh: number; entryBasis: string; kind: "pullback" | "at-market" } {
  const isLong = direction === "long";

  if (zone) {
    // The edge price would reach FIRST on a pullback: the top of a support
    // zone for a long, the bottom of a resistance zone for a short.
    const nearEdge = isLong ? zone.priceHigh : zone.priceLow;
    const onTheCorrectSide = isLong ? nearEdge < anchorPrice : nearEdge > anchorPrice;

    if (onTheCorrectSide && Math.abs(anchorPrice - nearEdge) <= config.entryPullbackMaxAtr * atrAbs) {
      const touches = zone.reactionCount > 0 ? ` (${zone.reactionCount} touch${zone.reactionCount === 1 ? "" : "es"})` : "";
      return {
        entryLow: zone.priceLow,
        entryHigh: zone.priceHigh,
        entryBasis: `Pullback into the ${zone.timeframe === "both" ? "daily + 4H" : zone.timeframe} ${zone.kind} zone${touches}`,
        kind: "pullback",
      };
    }
  }

  const band = config.atMarketBandAtr * atrAbs;
  return {
    entryLow: anchorPrice - band,
    entryHigh: anchorPrice + band,
    entryBasis: `At market — no ${isLong ? "support" : "resistance"} zone within ${config.entryPullbackMaxAtr} ATR to retest`,
    kind: "at-market",
  };
}

export interface TradePlanInputs {
  direction: TradeDirection;
  /** Close price the plan is anchored to — never a live tick. */
  anchorPrice: number;
  atrPct: number | null;
  zones: SupportResistanceZone[];
  /**
   * Everything `buildEntryQuality` needs for the structural stop/targets and
   * star rating. `verdict` is excluded because `direction` already fixes it —
   * passing both invites the two disagreeing.
   */
  quality: Omit<EntryQualityInputs, "price" | "atrPct" | "supportResistance" | "verdict">;
  config?: TradePlanConfig;
  /**
   * Refuse to build a plan whose entry resolves to the at-market band.
   *
   * Set by PLANNED setups, whose entire premise is "a level we wait for
   * price to reach" — an at-market planned entry is a contradiction in
   * terms, and would quietly present a volatility-stopped market order as
   * though it were a structural setup. The THESIS path leaves this off:
   * when evidence says act now, entering at market is a legitimate answer.
   */
  requirePullbackEntry?: boolean;
}

/**
 * Builds the plan, or returns null when no honest one exists.
 *
 * Returns null — rather than a degraded plan — when there is no ATR, no
 * placeable stop, a stop so tight it sits inside the noise, or a
 * reward/risk below the module's own minimum once measured from the real
 * entry. A plan the geometry doesn't support is worse than no plan.
 */
export function buildTradePlan(inputs: TradePlanInputs): TradePlan | null {
  const { direction, anchorPrice, atrPct, zones, quality } = inputs;
  const config = inputs.config ?? DEFAULT_TRADE_PLAN_CONFIG;

  if (atrPct === null || atrPct <= 0 || anchorPrice <= 0) return null;

  const eq = buildEntryQuality({
    ...quality,
    verdict: direction === "long" ? "bullish" : "bearish",
    price: anchorPrice,
    atrPct,
    supportResistance: zones,
  });
  if (!eq) return null;

  const isLong = direction === "long";
  const atrAbs = (atrPct / 100) * anchorPrice;
  const protectiveZone = isLong ? eq.nearestSupport : eq.nearestResistance;
  const entry = buildEntryZone(direction, anchorPrice, atrAbs, protectiveZone, config);
  if (inputs.requirePullbackEntry && entry.kind !== "pullback") return null;

  /*
   * `buildEntryQuality` places its stop assuming entry AT the anchor price
   * — for a long, at the top edge of the nearest support zone ("we're wrong
   * if we lose support"). That is correct for an at-market entry and wrong
   * for a pullback entry, because the pullback entry is INSIDE that same
   * zone: the plan would be stopped out the instant it filled.
   *
   * So when the entry is a retest, the stop moves beyond the zone being
   * retested, and risk/reward is re-measured from where the trade actually
   * enters rather than from the anchor. Both numbers are strictly more
   * honest than reporting a ratio the trader could never have obtained.
   */
  /*
   * The reference price is the WORST fill inside the entry zone — the
   * highest price a long would pay, the lowest a short would take — not the
   * midpoint.
   *
   * A retest zone can be wide (a real ETH support zone measured 1.2 ATR
   * across), and with a stop just beyond it the fill price dominates the
   * risk. Quoting the midpoint turned a believable 4:1 into 7.7:1 purely
   * because of where inside its own zone the plan chose to stand. Pricing
   * the worst fill makes every ratio a FLOOR: an actual fill anywhere else
   * in the zone can only improve it, and the number can never flatter the
   * setup. Same pessimism the backtest's intrabar resolution already
   * applies.
   */
  const entryRef = isLong ? entry.entryHigh : entry.entryLow;
  let stopPrice = eq.stopPrice;
  let stopBasis = eq.stopBasis;

  if (entry.kind === "pullback" && protectiveZone) {
    stopPrice = isLong
      ? protectiveZone.priceLow - PULLBACK_STOP_BUFFER_ATR * atrAbs
      : protectiveZone.priceHigh + PULLBACK_STOP_BUFFER_ATR * atrAbs;
    stopBasis = `Beyond the ${protectiveZone.kind} zone being retested`;
  }

  const riskDistance = Math.abs(entryRef - stopPrice);
  if (riskDistance <= 0) return null;

  /*
   * The stop stays where structure puts it; what gets rejected is the PLAN.
   * Widening a structural stop to manufacture an acceptable risk distance
   * would quietly detach it from the level it represents, so a retest zone
   * too narrow to leave room for a non-noise stop simply doesn't produce a
   * plan. Threshold reused from entryQuality's own answer to "how close is
   * too close for a stop".
   */
  if (riskDistance < STRUCTURAL_STOP_MIN_ATR * atrAbs) return null;

  const riskRewardRatio = Math.abs(eq.targetPrice - entryRef) / riskDistance;
  const riskRewardRatio2 = Math.abs(eq.target2Price - entryRef) / riskDistance;
  if (riskRewardRatio < MIN_RR) return null;

  return {
    entryLow: entry.entryLow,
    entryHigh: entry.entryHigh,
    entryBasis: entry.entryBasis,
    entryRef,
    stopPrice,
    stopBasis,
    target1Price: eq.targetPrice,
    target1Basis: eq.targetBasis,
    target2Price: eq.target2Price,
    target2Basis: eq.target2Basis,
    riskRewardRatio,
    riskRewardRatio2,
    stars: eq.stars,
    starRationale: eq.starRationale,
    atrAbs,
    missedDistance: config.missedAtr * atrAbs,
    anchorPrice,
    supportZone: eq.nearestSupport,
    resistanceZone: eq.nearestResistance,
  };
}
