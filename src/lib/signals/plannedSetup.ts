/**
 * The forward-looking half of the engine: where we would enter, waiting for
 * price to come to us.
 *
 * WHY THIS EXISTS. The swing thesis only produces a plan once evidence
 * clears its activation gate — historically ~24% of days. The other 76% the
 * page had nothing to say about entries at all, which is the opposite of how
 * a swing trader works: you always know the level you want, and you wait.
 *
 * So this separates two things that were previously fused:
 *
 *   - THE PLAN     — where the entry is, what it risks, what it targets.
 *                    A statement about STRUCTURE. Always available when
 *                    structure supports one.
 *   - THE THESIS   — whether the evidence justifies taking it.
 *                    A statement about EVIDENCE. Gated, and much rarer.
 *
 * A planned setup is deliberately CONDITIONAL, never a prediction: "if price
 * reaches 1,794 that entry offers 2.5:1 against structure" is a claim about
 * geometry, and stays true whether or not the composite has an opinion. That
 * is what makes it honest to show a long setup and a short setup at the same
 * time in a range — both levels are real, and picking one would invent a
 * directional call the evidence doesn't support.
 *
 * STABILITY IS STRUCTURAL, NOT A THRESHOLD. The frozen half
 * (`PlannedSetupsFrozen`) contains no price-dependent field at all, and is
 * rebuilt only at a daily close. Everything that moves with price —
 * distance, status — is derived at render time by `readPlannedSetups` and
 * never stored. It is therefore impossible for a poll to change an entry,
 * a stop, a target or an R:R: there is no code path that writes them
 * outside a daily close.
 */

import { TradePlan, TradeDirection, buildTradePlan, PlanConstraints } from "./tradePlan";
import { EntryQualityInputs } from "./entryQuality";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { Verdict } from "./types";

/**
 * `invalidated` means the LEVEL is gone — price closed through the side the
 * setup was defending, so the structure it was built on no longer exists.
 * Deliberately no "triggered" state: a planned setup is a level, not a
 * tracked position. Once a trade is actually taken, swingThesis.ts owns it.
 */
export type SetupStatus = "waiting" | "approaching" | "at-entry" | "invalidated";

/** Within this many ATRs of the entry zone, the setup is close enough that the order book becomes worth consulting. */
export const APPROACH_ATR = 0.75;

export interface PlannedSetupsFrozen {
  /** The daily close this was built at. Nothing here changes until the next one. */
  builtAt: number;
  /** The close price the plans were anchored to. */
  anchorPrice: number;
  long: TradePlan | null;
  short: TradePlan | null;
  /**
   * The side the higher timeframes favour, or null when daily and 4H
   * disagree or are neutral — in which case both setups stand equal and the
   * UI must not imply one is preferred.
   */
  favoured: TradeDirection | null;
  /** One sentence naming why that side is favoured, or why neither is. */
  rationale: string;
}

export interface PlannedSetupView {
  direction: TradeDirection;
  plan: TradePlan;
  status: SetupStatus;
  /** Signed distance from price to the near edge of the entry zone, as a percentage of price. */
  distancePct: number;
  /** The same distance in ATRs — the unit that decides `approaching`. */
  distanceAtr: number;
  /** True when this is the side the higher timeframes favour. */
  primary: boolean;
  /** Plain-English statement of what has to happen for this entry to come live. Never embeds a price — see `triggerPrice`. */
  trigger: string;
  /**
   * The price the trigger sentence refers to, left unformatted so the UI can
   * render it with the same `formatPrice` as every other level on the page.
   * Embedding a `toFixed` here produced "1855.75" sitting next to "$1,856"
   * in the same block.
   */
  triggerPrice: number | null;
}

export interface PlannedSetupsView {
  builtAt: number;
  anchorPrice: number;
  setups: PlannedSetupView[];
  favoured: TradeDirection | null;
  rationale: string;
}

export interface PlannedSetupInputs {
  /** Measured excursion/EV constraints per side. Absent in the (deliberately ungated) backtest replay — see plannerStats.ts. */
  constraintsBySide?: { long: PlanConstraints | null; short: PlanConstraints | null } | null;
  /** Daily close timestamp — the only cadence at which plans are built. */
  t: number;
  closePrice: number;
  atrPct: number | null;
  /** Merged daily + 4H structure. See marketStructure.mergeTimeframeZones. */
  zones: SupportResistanceZone[];
  /** Absolute direction of the daily technical read. */
  dailyDirection: Verdict | null;
  /** Absolute direction of the faster technical read. */
  fourHourDirection: Verdict | null;
  /** Display name for that faster timeframe. Defaults to 4H for crypto. */
  fastLabel?: string;
  /** Star-rating inputs, shared with the thesis path so ratings agree. */
  quality: Omit<EntryQualityInputs, "price" | "atrPct" | "supportResistance" | "verdict">;
}

/**
 * Which side, if any, the two swing timeframes agree on.
 *
 * Agreement is required. A daily/4H conflict is exactly the range condition
 * where both levels matter and neither deserves to be called primary, so it
 * returns null rather than letting the daily quietly win.
 */
export function favouredDirection(
  daily: Verdict | null,
  fourHour: Verdict | null,
  /**
   * What the faster timeframe is CALLED. Crypto runs 4H candles; equities
   * have a 6.5-hour session, so their faster read is hourly. Printing "4H"
   * on a page built from hourly bars would be a small, silent lie about
   * the evidence — hence a parameter rather than a constant.
   */
  fastLabel = "4H"
): { direction: TradeDirection | null; rationale: string } {
  if (daily === null || daily === "neutral") {
    return { direction: null, rationale: "Daily has no clear direction — both levels are live until it picks a side." };
  }
  if (fourHour === null) {
    const direction = daily === "bullish" ? "long" : "short";
    return { direction, rationale: `Daily is ${daily}; no ${fastLabel} read available to confirm it.` };
  }
  if (fourHour === "neutral") {
    const direction = daily === "bullish" ? "long" : "short";
    return { direction, rationale: `Daily is ${daily} and ${fastLabel} is neutral — the daily sets the lean.` };
  }
  if (daily !== fourHour) {
    return {
      direction: null,
      rationale: `Daily is ${daily} but ${fastLabel} is ${fourHour} — the timeframes conflict, so neither side is favoured yet.`,
    };
  }
  return {
    direction: daily === "bullish" ? "long" : "short",
    rationale: `Daily and ${fastLabel} are both ${daily} — aligned.`,
  };
}

/**
 * Builds both conditional setups. Call ONLY at a daily close.
 *
 * Either side may come back null: `buildTradePlan` refuses when structure
 * can't support an honest plan (no reachable level, a stop inside the noise,
 * reward/risk below the minimum). A missing side means "there is no good
 * long here", which is a real answer and better than a manufactured one.
 */
export function buildPlannedSetups(inputs: PlannedSetupInputs): PlannedSetupsFrozen | null {
  const { t, closePrice, atrPct, zones, quality } = inputs;
  if (atrPct === null || atrPct <= 0 || closePrice <= 0) return null;

  /*
   * `requirePullbackEntry` is what makes these PLANNED rather than
   * immediate. Without it, a side with no reachable level still produces a
   * plan — an at-market entry with a volatility stop — which reads as a
   * setup while being the exact opposite of one.
   */
  const plan = (direction: TradeDirection) =>
    buildTradePlan({
      direction,
      anchorPrice: closePrice,
      atrPct,
      zones,
      quality,
      requirePullbackEntry: true,
      constraints: inputs.constraintsBySide?.[direction] ?? null,
    });

  const long = plan("long");
  const short = plan("short");
  if (!long && !short) return null;

  const { direction: favoured, rationale } = favouredDirection(
    inputs.dailyDirection,
    inputs.fourHourDirection,
    inputs.fastLabel
  );

  /*
   * When the timeframes favour a side that structure can't actually price,
   * SAY SO. Otherwise the page reads "both timeframes are bearish" directly
   * above a lone long setup, and the reader is left to guess whether the
   * engine is confused. It isn't — the nearest opposing level is simply out
   * of pullback range — but silence there looks like a bug.
   */
  const favouredMissing = favoured === "long" ? !long : favoured === "short" ? !short : false;
  const fullRationale = favouredMissing
    ? `${rationale} No ${favoured} entry is in range though — the nearest level to trade against is too far for a swing pullback, so the only setup priced here is the other side.`
    : rationale;

  return { builtAt: t, anchorPrice: closePrice, long, short, favoured, rationale: fullRationale };
}

/** Signed gap from price to the entry zone: 0 inside it, positive when price must still travel. */
function distanceToZone(price: number, plan: TradePlan): number {
  if (price >= plan.entryLow && price <= plan.entryHigh) return 0;
  return price < plan.entryLow ? plan.entryLow - price : price - plan.entryHigh;
}

function statusOf(direction: TradeDirection, plan: TradePlan, price: number, distanceAtr: number): SetupStatus {
  // The level itself is gone: price is beyond where this setup said the
  // structure would hold, so there is nothing left to wait for.
  const structureBroken = direction === "long" ? price < plan.stopPrice : price > plan.stopPrice;
  if (structureBroken) return "invalidated";

  if (price >= plan.entryLow && price <= plan.entryHigh) return "at-entry";
  return distanceAtr <= APPROACH_ATR ? "approaching" : "waiting";
}

function triggerLine(
  direction: TradeDirection,
  plan: TradePlan,
  price: number,
  status: SetupStatus
): { trigger: string; triggerPrice: number | null } {
  if (status === "invalidated") {
    return {
      trigger: "Price has moved beyond the stop, so the level this setup was built on no longer holds.",
      triggerPrice: plan.stopPrice,
    };
  }
  if (status === "at-entry") {
    return { trigger: "Price is in the entry zone now.", triggerPrice: null };
  }

  const target = direction === "long" ? plan.entryHigh : plan.entryLow;
  const movePct = Math.abs((target - price) / price) * 100;
  const way = target < price ? "fall" : "rise";
  return {
    trigger: `Needs to ${way} ${movePct.toFixed(1)}% to reach the zone${status === "approaching" ? " — close enough to watch" : ""}.`,
    triggerPrice: target,
  };
}

/**
 * Adds the price-dependent view on top of the frozen plans.
 *
 * Every field this produces is a pure function of `price` and the frozen
 * plan, so calling it a thousand times with the same price yields the same
 * answer, and calling it with a new price can only move status and distance
 * — never a level.
 */
export function readPlannedSetups(frozen: PlannedSetupsFrozen | null, price: number): PlannedSetupsView | null {
  if (!frozen || price <= 0) return null;

  const view = (direction: TradeDirection, plan: TradePlan | null): PlannedSetupView | null => {
    if (!plan) return null;
    const gap = distanceToZone(price, plan);
    const distanceAtr = plan.atrAbs > 0 ? gap / plan.atrAbs : 0;
    const status = statusOf(direction, plan, price, distanceAtr);
    return {
      direction,
      plan,
      status,
      distancePct: (gap / price) * 100,
      distanceAtr,
      primary: frozen.favoured === direction,
      ...triggerLine(direction, plan, price, status),
    };
  };

  const setups = [view("long", frozen.long), view("short", frozen.short)].filter(
    (s): s is PlannedSetupView => s !== null
  );
  if (setups.length === 0) return null;

  /*
   * Ordered by how actionable each setup is right now: the one price is
   * closest to leads, with the favoured side breaking ties. A trader
   * scanning this wants "which of these is about to matter", not a fixed
   * long-then-short ordering.
   */
  setups.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.distanceAtr - b.distanceAtr;
  });

  return {
    builtAt: frozen.builtAt,
    anchorPrice: frozen.anchorPrice,
    setups,
    favoured: frozen.favoured,
    rationale: frozen.rationale,
  };
}
