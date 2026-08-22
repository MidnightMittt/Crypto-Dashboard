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
  /**
   * The adverse move (% of entry) that winning trades in this side+regime
   * typically endured before working — winners' median MAE. What a holder
   * of this plan should EXPECT to sit through, stated up front instead of
   * discovered mid-trade. Null when no excursion record covers this plan.
   */
  expectedDrawdownPct: number | null;
  /** Expectancy % per trade for this side+regime with the win rate at its Wilson lower bound. Null when ungated (no record). */
  evLowerPct: number | null;
}

/**
 * Measured constraints from the execution replay's excursion record
 * (scripts/backtest/plannerStats.ts), for THIS plan's side and the current
 * volatility regime. Optional and null-tolerant by design: the equity path
 * and the backtest replay pass nothing — the replay MUST stay ungated so
 * these numbers keep describing the raw strategy (measurement vs policy;
 * see plannerStats.ts) — and every field is independently nullable so a
 * thin cell constrains nothing rather than constraining from noise.
 */
export interface PlanConstraints {
  /** e.g. "short:low-vol" — named so a refusal can cite its own bucket. */
  cellKey: string;
  /** Trades behind these numbers. */
  n: number;
  /** Expectancy % per trade with the win rate at its Wilson 95% lower bound. ≤ 0 refuses the plan. */
  evLowerPct: number;
  /**
   * The POINT estimate of the same expectancy, carried so a refusal can name
   * both. The gate acts on the pessimistic bound; when the point estimate is
   * positive and the bound is not, the reader deserves both numbers — a
   * refusal citing only "lost money" over a record whose average made money
   * is a sentence nobody can argue with, which is a sentence nobody reads.
   */
  evPointPct?: number | null;
  /** Point-estimate win rate for the same cell, for the refusal sentence. */
  winRatePct?: number | null;
  /** Median sessions held, so the claim carries its horizon. */
  medianHoldSessions?: number | null;
  /** Adverse move (% of entry) that winning trades typically endured — the plan's honest "expected drawdown". */
  winnersMaeP50Pct: number | null;
  /** A stop closer than this stops out winners: 80% of winning trades drew down less than this before working. */
  winnersMaeP80Pct: number | null;
  /** 75% of winners never ran farther than this — a primary target beyond it is priced on trades this strategy does not produce. */
  winnersMfeP75Pct: number | null;
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
  /** Measured excursion/EV constraints for this side+regime. Omitted by the equity path and the (deliberately ungated) backtest replay. */
  constraints?: PlanConstraints | null;
}

/**
 * Why no plan exists. Every refusal in `buildTradePlanOutcome` names itself,
 * so a surface can tell a reader WHICH condition failed instead of the
 * uninformative "no setup".
 *
 * These are refusals, not errors. Each one is a case where the geometry does
 * not support an honest plan, and the engine declining to invent one is the
 * correct behaviour — the reader should come away understanding that, not
 * suspecting something broke.
 */
export type TradePlanRefusal =
  | "no-volatility"
  | "no-structure"
  | "no-pullback-entry"
  | "stop-at-entry"
  | "stop-inside-noise"
  | "reward-too-small"
  | "negative-expectancy"
  | "earnings-imminent"
  | "stop-tighter-than-winners-drawdown"
  | "target-beyond-winners-reach";

export const TRADE_PLAN_REFUSAL_TEXT: Record<TradePlanRefusal, string> = {
  "no-volatility":
    "No usable volatility reading. Every level in a plan is sized in ATRs, so without one there is no principled distance to place a stop or a target at.",
  "no-structure":
    "No support/resistance structure to anchor to. A stop needs a level it represents — placed on volatility alone it is an arbitrary distance, and a target without structure is a guess.",
  "no-pullback-entry":
    "The only available entry is at market, and this setup requires a retest. Waiting for a level price has not offered is the whole premise; entering at market instead would be a different trade wearing this one's risk/reward.",
  "stop-at-entry":
    "The structural stop resolves to the entry price itself, leaving no risk distance to measure a reward against.",
  "stop-inside-noise":
    "The structural stop sits closer than the market's own daily noise. It would be taken out by ordinary movement rather than by the thesis being wrong, so the plan is refused rather than the stop widened — widening it would detach it from the level it represents.",
  "reward-too-small":
    "Reward-to-risk falls below the engine's minimum once measured from the real entry, not from the anchor price. The direction may still be right; the geometry does not pay enough for the risk it requires.",
  "earnings-imminent":
    "Earnings are within the veto window. A stop is a statement about structure, and an earnings gap jumps stops rather than trading through them — the plan's printed risk was never available across that event, so no plan is offered until the report is out.",
  "negative-expectancy":
    "Trades of this side in this volatility regime have NEGATIVE expectancy at the 95% lower bound of their own replayed record. The engine does not plan trades its own history says lose money — this gate re-opens automatically if the record turns positive on a future regeneration.",
  "stop-tighter-than-winners-drawdown":
    "The structural stop sits inside the drawdown that WINNING trades in this regime routinely endured before working (80% of winners drew down further than this stop allows). It would convert winners into losers by construction, so the plan is refused rather than the stop detached from its level.",
  "target-beyond-winners-reach":
    "The primary target sits beyond where 75% of winning trades in this regime ever reached. A plan priced on excursions this strategy does not produce is fantasy with a risk/reward attached.",
};

/**
 * The same refusals in ONE PLAIN SENTENCE, for the headline.
 *
 * The full texts above are the reasoning and stay available underneath —
 * they are what make a refusal auditable. But a reader arriving at the page
 * needs to know why there is no trade before they need to know how the
 * engine reached that view, and "reward-to-risk falls below the engine's
 * minimum once measured from the real entry" is a sentence you have to work
 * at. Same claim, no working required, and never softer: if the reason a
 * trade is refused is that it loses money, the short version says so.
 */
export const TRADE_PLAN_REFUSAL_SHORT: Record<TradePlanRefusal, string> = {
  "no-volatility": "Not enough price history to judge how far this normally moves, so any stop would be arbitrary.",
  "no-structure": "There is no clear support or resistance nearby to place a stop against.",
  "no-pullback-entry": "Price has already run. This setup needs a pullback, and buying here would be a different trade.",
  "stop-at-entry": "The stop would sit on top of the entry, leaving nothing to measure the risk against.",
  "stop-inside-noise": "The stop would sit inside this asset's normal daily movement — ordinary noise would take it out.",
  "reward-too-small": "The direction may be right, but the move on offer does not pay enough for the risk it takes.",
  "earnings-imminent": "Earnings land within three trading days, and price can gap straight past a stop through a report.",
  "negative-expectancy": "Trades like this one have lost money on our own measured record, so no plan is offered.",
  "stop-tighter-than-winners-drawdown":
    "The stop is tighter than the dip most winning trades sat through first — it would turn winners into losers.",
  "target-beyond-winners-reach": "The target is further than trades like this one usually reach, so the reward is not realistic.",
};

/** A plan, or a named reason there is none. Never a degraded plan. */
export type TradePlanOutcome =
  | { plan: TradePlan; refusal: null; refusalDetail?: null }
  | {
      plan: null;
      refusal: TradePlanRefusal;
      /**
       * The refusal with ITS OWN NUMBERS in the sentence — statistic,
       * horizon, sample — where the constraints carry them. The static
       * texts above state the rule; this states the measurement, so the
       * reader can disagree with a specific figure instead of a verdict.
       */
      refusalDetail?: string;
    };

/**
 * Builds the plan, or returns null when no honest one exists.
 *
 * Thin wrapper over `buildTradePlanOutcome`, kept because most callers only
 * need "plan or not". Surfaces that must EXPLAIN the absence call the outcome
 * form directly. One implementation either way — a second copy that computed
 * the reason separately could disagree with the plan about whether one exists.
 */
export function buildTradePlan(inputs: TradePlanInputs): TradePlan | null {
  return buildTradePlanOutcome(inputs).plan;
}

/**
 * The same construction, with the refusal named.
 *
 * Returns a refusal — rather than a degraded plan — when there is no ATR, no
 * placeable stop, a stop so tight it sits inside the noise, or a
 * reward/risk below the module's own minimum once measured from the real
 * entry. A plan the geometry doesn't support is worse than no plan.
 */
export function buildTradePlanOutcome(inputs: TradePlanInputs): TradePlanOutcome {
  const { direction, anchorPrice, atrPct, zones, quality } = inputs;
  const config = inputs.config ?? DEFAULT_TRADE_PLAN_CONFIG;
  const constraints = inputs.constraints ?? null;

  /*
   * THE EV GATE (redesign §10), checked before any geometry: it is a
   * property of the side and regime, not of this plan's levels, so no
   * arrangement of entries and stops can rescue a bucket whose own replayed
   * record loses money at the pessimistic bound. Measured at the time this
   * was wired: every short cell was negative at the Wilson lower bound
   * (986 replayed shorts, −0.04% at the point estimate net of costs) and
   * every long cell positive — so this line refuses shorts until their
   * record earns them back. Policy, not measurement: the replay that
   * produces the record never passes constraints, so the gate cannot
   * starve its own evidence.
   */
  if (constraints && constraints.evLowerPct <= 0) {
    const c = constraints;
    const f = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    const side = c.cellKey.startsWith("short") ? "Shorts" : "Longs";
    return {
      plan: null,
      refusal: "negative-expectancy",
      refusalDetail:
        `${side} in ${c.cellKey} read ${f(c.evLowerPct)} expectancy per trade at the 95% ` +
        `lower bound of their replayed win rate` +
        (c.evPointPct != null && c.winRatePct != null
          ? ` (point estimate ${f(c.evPointPct)}, win rate ${c.winRatePct.toFixed(0)}%` +
            (c.medianHoldSessions != null ? `, median hold ${c.medianHoldSessions} sessions` : "") +
            `, n=${c.n.toLocaleString()})`
          : ` (n=${c.n.toLocaleString()})`) +
        `. The gate refuses on the pessimistic bound, never the average — disagree with the ` +
        `bound, not with the word.`,
    };
  }

  if (atrPct === null || atrPct <= 0 || anchorPrice <= 0) {
    return { plan: null, refusal: "no-volatility" };
  }

  const eq = buildEntryQuality({
    ...quality,
    verdict: direction === "long" ? "bullish" : "bearish",
    price: anchorPrice,
    atrPct,
    supportResistance: zones,
  });
  if (!eq) return { plan: null, refusal: "no-structure" };

  const isLong = direction === "long";
  const atrAbs = (atrPct / 100) * anchorPrice;
  const protectiveZone = isLong ? eq.nearestSupport : eq.nearestResistance;
  const entry = buildEntryZone(direction, anchorPrice, atrAbs, protectiveZone, config);
  if (inputs.requirePullbackEntry && entry.kind !== "pullback") {
    return { plan: null, refusal: "no-pullback-entry" };
  }

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
  if (riskDistance <= 0) return { plan: null, refusal: "stop-at-entry" };

  /*
   * The stop stays where structure puts it; what gets rejected is the PLAN.
   * Widening a structural stop to manufacture an acceptable risk distance
   * would quietly detach it from the level it represents, so a retest zone
   * too narrow to leave room for a non-noise stop simply doesn't produce a
   * plan. Threshold reused from entryQuality's own answer to "how close is
   * too close for a stop".
   */
  if (riskDistance < STRUCTURAL_STOP_MIN_ATR * atrAbs) {
    return { plan: null, refusal: "stop-inside-noise" };
  }

  /*
   * Excursion floors and ceilings — geometry proposes, the excursion record
   * disposes. Percent-of-entry, matching how MAE/MFE were recorded.
   */
  const riskPct = (riskDistance / entryRef) * 100;
  if (constraints?.winnersMaeP80Pct != null && riskPct < constraints.winnersMaeP80Pct) {
    return { plan: null, refusal: "stop-tighter-than-winners-drawdown" };
  }
  const target1DistancePct = (Math.abs(eq.targetPrice - entryRef) / entryRef) * 100;
  if (constraints?.winnersMfeP75Pct != null && target1DistancePct > constraints.winnersMfeP75Pct) {
    return { plan: null, refusal: "target-beyond-winners-reach" };
  }
  const target2DistancePct = (Math.abs(eq.target2Price - entryRef) / entryRef) * 100;
  const target2BeyondReach =
    constraints?.winnersMfeP75Pct != null && target2DistancePct > constraints.winnersMfeP75Pct;

  const riskRewardRatio = Math.abs(eq.targetPrice - entryRef) / riskDistance;
  const riskRewardRatio2 = Math.abs(eq.target2Price - entryRef) / riskDistance;
  if (riskRewardRatio < MIN_RR) return { plan: null, refusal: "reward-too-small" };

  const plan: TradePlan = {
    entryLow: entry.entryLow,
    entryHigh: entry.entryHigh,
    entryBasis: entry.entryBasis,
    entryRef,
    stopPrice,
    stopBasis,
    target1Price: eq.targetPrice,
    target1Basis: eq.targetBasis,
    target2Price: eq.target2Price,
    // The stretch target keeps its structural level but must say when it
    // sits beyond what 75% of winners ever reached — annotated, not capped,
    // because moving it would detach it from the level it represents.
    target2Basis: target2BeyondReach
      ? `${eq.target2Basis} — beyond the excursion 75% of winning trades in this regime ever reached; treat as best-case, not base-case`
      : eq.target2Basis,
    riskRewardRatio,
    riskRewardRatio2,
    stars: eq.stars,
    starRationale: eq.starRationale,
    atrAbs,
    missedDistance: config.missedAtr * atrAbs,
    anchorPrice,
    supportZone: eq.nearestSupport,
    resistanceZone: eq.nearestResistance,
    expectedDrawdownPct: constraints?.winnersMaeP50Pct ?? null,
    evLowerPct: constraints?.evLowerPct ?? null,
  };
  return { plan, refusal: null };
}
