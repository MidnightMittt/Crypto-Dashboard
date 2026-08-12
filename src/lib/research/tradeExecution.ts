/**
 * Resolves a trade plan against what price actually did next.
 *
 * Everything upstream of this file measures "which way did price go over the
 * next N hours" — a directional question. This measures a genuinely
 * different one: if a trader had taken the ACTUAL entry/stop/target the
 * dashboard printed, what would have happened to that trade? A signal can
 * be directionally right and still stop out first; that gap is invisible to
 * a fixed-horizon forward return and is exactly what this file exists to
 * surface.
 *
 * Pure and dependency-free, like metrics.ts, and hand-verified against
 * constructed bar sequences before being pointed at real data (see
 * execution.test.ts). Nothing here re-derives a level or a direction —
 * buildEntryQuality already produced the plan; this only measures its fate.
 */

export type TradeSide = "long" | "short";

/** Why the trade ended. "timeout" means neither level was touched inside the hold window. */
export type TradeOutcome = "target" | "stop" | "timeout";

export interface TradePlan {
  side: TradeSide;
  /** Fill assumed at the signal bar's close — see run.ts's `currentPrice`. */
  entryPrice: number;
  stopPrice: number;
  /** TP1 — the level the canonical exit rule below actually uses. */
  targetPrice: number;
  /** TP2 — measured separately as a "what if it had run" statistic, never the exit. */
  target2Price: number;
  entryT: number;
}

export interface HourBar {
  t: number;
  /**
   * Required for gap detection. A session market can reopen beyond a resting
   * stop, and only the OPEN reveals that — the high/low of such a bar are
   * both already past the level, so an intrabar test cannot distinguish
   * "traded through" from "gapped through".
   */
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradeResolution {
  outcome: TradeOutcome;
  exitPrice: number;
  exitT: number;
  /**
   * Signed in the trade's own direction: positive is profitable for a short
   * as well as a long. Gross — costs.ts applies fees/slippage/funding on
   * top, and the two are never conflated in any report.
   */
  grossReturnPct: number;
  /**
   * Best and worst the trade ever looked BEFORE it closed, as a % of entry
   * and signed in the trade's direction (MFE positive = went the right way).
   * Measured to the exit, not to the end of the hold window — the standard
   * definition, and the one that answers "how much heat did this take."
   *
   * MFE can be negative: that means price never once traded beyond entry in
   * the intended direction. Not clamped to zero, because "it never worked
   * even for a moment" is real information worth keeping.
   */
  mfePct: number;
  maePct: number;
  /** Hours from entry to first touch. Null when that level was never touched before the trade closed. */
  hoursToTarget: number | null;
  hoursToStop: number | null;
  hoursHeld: number;
  /**
   * Whether price reached TP2 before ever touching the stop — scanned across
   * the FULL hold window, deliberately independent of the TP1 exit above.
   * The canonical trade already closed at TP1; this answers the separate
   * question a runner position would ask, and conflating the two would
   * double-count one trade as two outcomes.
   */
  tp2ReachedBeforeStop: boolean;
  /**
   * A single bar whose range spanned both the stop and TP1. Hourly bars
   * carry no intrabar sequence, so which came first is genuinely unknowable
   * — resolved as the stop (see resolveTrade). Surfaced so a report can say
   * what share of outcomes rest on that assumption instead of hiding it.
   */
  ambiguousBar: boolean;
  /**
   * True when the position exited at a bar's OPEN because the market
   * reopened beyond the level, rather than at the level itself. Always false
   * for a continuous market, which cannot gap.
   */
  gapped: boolean;
  /**
   * Signed against the position: negative means the gap fill was WORSE than
   * the intended level. Zero when no gap occurred. Summing this across a
   * study quantifies exactly how much of a result depends on gap assumptions.
   */
  gapSlippagePct: number;
}

import { SessionModel } from "./types";

const HOUR_MS = 3_600_000;

/** Signed % move from entry in the trade's own direction — positive is always "good for this trade." */
function directionalPct(side: TradeSide, entryPrice: number, price: number): number {
  const raw = ((price - entryPrice) / entryPrice) * 100;
  return side === "long" ? raw : -raw;
}

/**
 * Did price reach TP2 before ever touching the stop, anywhere in the hold
 * window? A deliberately separate scan rather than a flag set inside the
 * main loop: that loop stops at the TP1 exit, so it can only ever see the
 * first slice of the window, while the runner-position question this
 * answers is about the whole of it. Same stop-wins-ties convention as the
 * exit rule.
 */
/**
 * Gap-aware too, for the same reason the main resolver is: a runner position
 * is stopped out by an adverse reopen just as a canonical one is. Leaving
 * this scan gap-blind would overstate TP2 attainment on session markets
 * while the headline exit was correctly pessimistic.
 */
function reachedTp2BeforeStop(plan: TradePlan, window: HourBar[], session: SessionModel): boolean {
  const isLong = plan.side === "long";
  for (const bar of window) {
    if (session.gapsPossible) {
      const gappedStop = isLong ? bar.open <= plan.stopPrice : bar.open >= plan.stopPrice;
      if (gappedStop) return false;
      const gappedTp2 = isLong ? bar.open >= plan.target2Price : bar.open <= plan.target2Price;
      if (gappedTp2) return true;
    }
    const stopTouched = isLong ? bar.low <= plan.stopPrice : bar.high >= plan.stopPrice;
    const tp2Touched = isLong ? bar.high >= plan.target2Price : bar.low <= plan.target2Price;
    if (stopTouched) return false;
    if (tp2Touched) return true;
  }
  return false;
}

/**
 * THE canonical trade resolver. There is deliberately only one.
 *
 * A second, simpler gap-aware resolver briefly existed alongside this while
 * the cross-asset work was in flight. Two implementations of "what became of
 * this trade" is precisely the kind of duplication that eventually answers
 * the same question two different ways, so the simpler one was deleted once
 * this one gained gap awareness — it was strictly poorer, lacking MFE/MAE,
 * TP2-before-stop and intrabar ambiguity tracking.
 *
 * Walks hourly bars forward from the signal and reports what became of the
 * trade.
 *
 * Canonical exit rule: the FIRST touch of TP1 or the stop closes the trade;
 * if neither is touched inside `maxHoldMs`, it closes at the last bar's
 * close. One rule, applied identically to every trade, so the resulting
 * win rate means one specific thing rather than being an average over
 * several implicit exit policies.
 *
 * Intrabar ambiguity resolves as the STOP. When a bar's high and low span
 * both levels, hourly data cannot say which printed first; assuming the
 * favorable one is precisely how a backtest flatters itself into an edge it
 * never had. The pessimistic assumption biases results DOWN, which is the
 * correct direction to be wrong in when the output is shown to someone
 * deciding whether to risk money.
 *
 * Returns null when no bars fall inside the window — an unresolvable trade
 * is dropped rather than counted as a timeout, which would silently pad the
 * sample with non-observations.
 */
export function resolveTrade(
  plan: TradePlan,
  bars: HourBar[],
  maxHoldMs: number,
  /**
   * REQUIRED, deliberately un-defaulted.
   *
   * Defaulting to continuous would let an equity caller silently inherit
   * crypto semantics and book fills that were never available — the exact
   * silent-overstatement failure this migration exists to remove. Crypto
   * callers pass CONTINUOUS_SESSION explicitly, which is a one-word
   * declaration that the market cannot gap.
   */
  session: SessionModel
): TradeResolution | null {
  const { side, entryPrice, stopPrice, targetPrice, target2Price, entryT } = plan;
  if (entryPrice <= 0) return null;

  const window = bars
    .filter((b) => b.t > entryT && b.t <= entryT + maxHoldMs)
    .sort((a, b) => a.t - b.t);
  if (window.length === 0) return null;

  const isLong = side === "long";
  const hit = (bar: HourBar, level: number, above: boolean) => (above ? bar.high >= level : bar.low <= level);

  let mfePct = -Infinity;
  let maePct = Infinity;
  let hoursToTarget: number | null = null;
  let hoursToStop: number | null = null;
  let ambiguousBar = false;

  let outcome: TradeOutcome = "timeout";
  let exitPrice = window[window.length - 1].close;
  let exitT = window[window.length - 1].t;
  let gapped = false;
  let gapSlippagePct = 0;

  for (const bar of window) {
    const hours = (bar.t - entryT) / HOUR_MS;

    /*
     * GAP HANDLING, checked before any intrabar test.
     *
     * If a session market reopens beyond a resting level, the position left
     * at the OPEN — nothing later in that bar can undo it, and booking the
     * fill at the level would credit a price that was never available. The
     * error is one-directional (it always flatters the result) so it does
     * not average out across trades; it accumulates.
     *
     * Guarded by `gapsPossible`, so a continuous market takes the identical
     * path it always has and every existing crypto result is unchanged.
     */
    if (session.gapsPossible) {
      const gapThroughStop = isLong ? bar.open <= stopPrice : bar.open >= stopPrice;
      const gapThroughTarget = isLong ? bar.open >= targetPrice : bar.open <= targetPrice;

      if (gapThroughStop || gapThroughTarget) {
        // Excursions are updated with the OPEN alone: the position closed
        // there, so the rest of the bar's range never happened to it.
        mfePct = Math.max(mfePct, directionalPct(side, entryPrice, bar.open));
        maePct = Math.min(maePct, directionalPct(side, entryPrice, bar.open));

        // Stop before target: if the reopen cleared both, the adverse level
        // is the pessimistic and correct reading.
        const level = gapThroughStop ? stopPrice : targetPrice;
        outcome = gapThroughStop ? "stop" : "target";
        if (gapThroughStop) hoursToStop = hours;
        else hoursToTarget = hours;

        exitPrice = bar.open;
        exitT = bar.t;
        gapped = true;
        gapSlippagePct = directionalPct(side, entryPrice, bar.open) - directionalPct(side, entryPrice, level);
        break;
      }
    }

    // Excursions use the bar's extremes, not its close — a wick through the
    // stop is real heat the trader would have felt.
    mfePct = Math.max(mfePct, directionalPct(side, entryPrice, isLong ? bar.high : bar.low));
    maePct = Math.min(maePct, directionalPct(side, entryPrice, isLong ? bar.low : bar.high));

    const stopTouched = hit(bar, stopPrice, !isLong);
    const targetTouched = hit(bar, targetPrice, isLong);

    if (stopTouched && targetTouched) ambiguousBar = true;

    if (stopTouched) {
      hoursToStop = hours;
      outcome = "stop";
      exitPrice = stopPrice;
      exitT = bar.t;
      break;
    }
    if (targetTouched) {
      hoursToTarget = hours;
      outcome = "target";
      exitPrice = targetPrice;
      exitT = bar.t;
      break;
    }
  }

  return {
    outcome,
    exitPrice,
    exitT,
    grossReturnPct: directionalPct(side, entryPrice, exitPrice),
    mfePct,
    maePct,
    hoursToTarget,
    hoursToStop,
    hoursHeld: (exitT - entryT) / HOUR_MS,
    tp2ReachedBeforeStop: reachedTp2BeforeStop(plan, window, session),
    ambiguousBar,
    gapped,
    gapSlippagePct,
  };
}
