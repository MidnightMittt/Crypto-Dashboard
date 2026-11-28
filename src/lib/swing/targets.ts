import { TradePlan, TradeDirection } from "../signals/tradePlan";
import { SupportResistanceZone, zoneTier } from "../technicals/marketStructure";
import { FibLegResult, extensionTargets } from "../technicals/fibonacci";
import { RiskConfig, SwingTarget } from "./types";
import { applyScaleOut } from "./risk";

/**
 * THREE TARGETS — structure first, Fibonacci second, and never invented.
 *
 * The existing TradePlan already carries two structurally-derived targets and
 * they are kept EXACTLY as built — this file adds a third and never recomputes
 * the first two. `tradePlan.ts` is untouched.
 *
 * ── THE RULE ABOUT NOT FILLING SLOTS ────────────────────────────────────
 *
 * A third target is only emitted when a defensible price exists for it:
 * a further structural zone, or a Fibonacci extension of the confirmed leg.
 * If neither is available this returns TWO targets and says so. Padding the
 * third slot with an arbitrary ATR multiple would dress a guess as a level,
 * and the position-management advice built on it would be fiction.
 *
 * ── WHY STRUCTURE OUTRANKS FIBONACCI ────────────────────────────────────
 *
 * A zone is where price has actually transacted and reversed. A fib extension
 * is a ratio projected onto a leg. This project measured the difference:
 * invented ratios performed as well as the golden ratio across 9 years, so
 * an extension is a reasonable target only when no structural level is
 * available to prefer over it.
 */

export interface TargetBuildResult {
  targets: SwingTarget[];
  /** Present when fewer than three defensible targets exist. */
  note: string | null;
}

/**
 * A third target beyond this many R is rejected, not ranked.
 *
 * Not tuned — chosen as roughly twice the existing plan's own TP2 bar (which
 * uses a 3:1 floor and a 4:1 fallback). The point is only to exclude levels
 * that exist on the chart but not within the horizon of a swing trade.
 */
const MAX_TARGET_R = 10;

/** Reward in R — multiples of the entry-to-stop distance. */
function rMultiple(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return 0;
  return Math.abs(target - entry) / risk;
}

/** Is `price` beyond `from` in the direction of the trade? */
function isAhead(price: number, from: number, direction: TradeDirection): boolean {
  return direction === "long" ? price > from : price < from;
}

export function buildSwingTargets(input: {
  plan: TradePlan;
  direction: TradeDirection;
  zones: SupportResistanceZone[];
  fib: FibLegResult | null;
  config: RiskConfig;
}): TargetBuildResult {
  const { plan, direction, zones, fib, config } = input;
  const entry = plan.entryRef;
  const stop = plan.stopPrice;

  // TP1 and TP2 come straight from the existing plan — not recomputed.
  const base: Omit<SwingTarget, "closeFraction">[] = [
    { price: plan.target1Price, basis: plan.target1Basis, rMultiple: rMultiple(entry, stop, plan.target1Price) },
    { price: plan.target2Price, basis: plan.target2Basis, rMultiple: rMultiple(entry, stop, plan.target2Price) },
  ];

  const beyond = plan.target2Price;
  let third: Omit<SwingTarget, "closeFraction"> | null = null;
  let note: string | null = null;

  /*
   * CANDIDATE 1 — the next structural zone past TP2, in the trade's direction.
   * Opposing-kind zones are the ones that stop a move: a long runs into
   * RESISTANCE, a short into SUPPORT. Selection is NEAREST-first with a
   * reachability cap; timeframe only breaks ties. See the note inside.
   */
  const wantKind = direction === "long" ? "resistance" : "support";
  const structural = zones
    .filter((z) => z.kind === wantKind)
    .map((z) => ({ z, edge: direction === "long" ? z.priceLow : z.priceHigh }))
    .filter(({ edge }) => isAhead(edge, beyond, direction))
    /*
     * A TARGET MUST BE REACHABLE WITHIN THE TRADE'S HORIZON.
     *
     * The first version sorted by timeframe tier before distance, so the
     * "most significant" level won regardless of how far away it was. On SOL
     * that selected the monthly all-time-high zone at 253 as TP3 — 44.8R from
     * an entry near 68, a 250% move presented as a profit target. A number
     * that will not be reached is not a target; it is a third slot filled.
     *
     * So: NEAREST first, and anything beyond MAX_TARGET_R is rejected outright
     * rather than ranked. Tier now only breaks ties between levels at
     * comparable distance, which is what it was meant to do.
     */
    .filter(({ edge }) => rMultiple(entry, stop, edge) <= MAX_TARGET_R)
    .sort((a, b) => {
      const da = Math.abs(a.edge - entry), db = Math.abs(b.edge - entry);
      // Within 15% of each other, prefer the more significant timeframe.
      if (Math.abs(da - db) / Math.max(da, db) < 0.15) {
        const rank = (t: string) => (t === "major" ? 0 : t === "intermediate" ? 1 : 2);
        return rank(zoneTier(a.z.timeframe)) - rank(zoneTier(b.z.timeframe));
      }
      return da - db;
    })[0];

  if (structural) {
    third = {
      price: structural.edge,
      basis: `${zoneTier(structural.z.timeframe)} ${structural.z.timeframe} ${structural.z.kind} zone`,
      rMultiple: rMultiple(entry, stop, structural.edge),
    };
  } else if (fib) {
    /*
     * CANDIDATE 2 — a Fibonacci extension, but ONLY when it runs the same way
     * as the trade. An up-leg's extensions sit above; they are meaningless as
     * a target for a short, and a direction check is the difference between a
     * target and a number.
     */
    const ext = extensionTargets(fib, entry)
      .filter((e) => isAhead(e.price, beyond, direction))
      .filter((e) => rMultiple(entry, stop, e.price) <= MAX_TARGET_R)[0];
    if (ext) {
      third = {
        price: ext.price,
        basis: `${ext.ratio} Fibonacci extension of the last ${fib.direction}-leg`,
        rMultiple: rMultiple(entry, stop, ext.price),
      };
    }
  }

  if (!third) {
    note =
      "Only two defensible targets exist: no further structural zone lies beyond TP2 in the trade's " +
      "direction within a reachable distance, and no Fibonacci extension of the confirmed leg projects " +
      "past it. A third target " +
      "was NOT invented — scale-out fractions have been renormalised across the two that do exist.";
  }

  const all = third ? [...base, third] : base;
  return { targets: applyScaleOut(all, config), note };
}
