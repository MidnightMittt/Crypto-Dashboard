import { Bar, SessionModel } from "./types";

/**
 * Gap-aware position resolution.
 *
 * The existing scripts/backtest/execution.ts resolves stops INTRABAR: if a
 * bar's range contains the stop, the fill is booked at the stop price. That
 * is approximately right for a market that trades continuously, and
 * systematically WRONG for one that does not.
 *
 * A session market closes. Overnight, over a weekend, or through an
 * earnings release, price can reopen far past a resting stop, and the fill
 * happens at the opening auction rather than at the level. Booking it at the
 * level credits the strategy with a fill that was never available. The error
 * is one-directional — it always flatters the result — so it does not average
 * out over many trades; it accumulates.
 *
 * This module therefore branches on `SessionModel.gapsPossible` rather than
 * treating it as documentation. That single branch is the reason this file
 * exists.
 */

export interface Position {
  side: "long" | "short";
  entryT: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
}

export type ExitReason = "stop" | "target" | "timeout" | "unresolved";

export interface Resolution {
  reason: ExitReason;
  /** Null only when `unresolved` (no forward bars at all). */
  exitPrice: number | null;
  exitT: number | null;
  barsHeld: number;
  /** True when price opened beyond the level and the fill was taken at the open instead. */
  gapped: boolean;
  /**
   * Signed against the position: negative means the fill was WORSE than the
   * intended level. Always <= 0 for stops and >= 0 for targets when gapped,
   * and exactly 0 otherwise. Summing this across a study quantifies how much
   * of a result depends on the gap assumption.
   */
  gapSlippage: number;
  /**
   * Both the stop and the target lay inside one bar's range, so OHLC cannot
   * say which came first. Resolved pessimistically as a stop; flagged so a
   * study can measure how much of its result rests on ambiguous bars.
   */
  ambiguousBar: boolean;
  returnPct: number;
}

/** Did this bar's OPEN already sit beyond the level, in the adverse direction for the position? */
function openedBeyondStop(side: Position["side"], open: number, stop: number): boolean {
  return side === "long" ? open <= stop : open >= stop;
}

/** Did this bar's OPEN already sit beyond the target, in the favourable direction? */
function openedBeyondTarget(side: Position["side"], open: number, target: number): boolean {
  return side === "long" ? open >= target : open <= target;
}

function touchedStop(side: Position["side"], bar: Bar, stop: number): boolean {
  return side === "long" ? bar.low <= stop : bar.high >= stop;
}

function touchedTarget(side: Position["side"], bar: Bar, target: number): boolean {
  return side === "long" ? bar.high >= target : bar.low <= target;
}

function pctReturn(side: Position["side"], entry: number, exit: number): number {
  if (entry <= 0) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return side === "long" ? raw : -raw;
}

/**
 * Walks `forwardBars` (strictly after entry, oldest first) and returns the
 * first resolution.
 *
 * Resolution order within a bar, and why:
 *   1. A gap through the STOP is checked before anything else. If the market
 *      reopened past the stop, that is where the position left — nothing
 *      later in the bar can undo it.
 *   2. A gap through the TARGET next, for the same reason in the favourable
 *      direction.
 *   3. Only then intrabar touches, with stop-before-target when both occur,
 *      because assuming the good outcome on an ambiguous bar is how
 *      backtests flatter themselves.
 */
export function resolvePosition(
  position: Position,
  forwardBars: Bar[],
  session: SessionModel,
  maxBars: number
): Resolution {
  const { side, entryPrice, stopPrice, targetPrice } = position;
  const bars = forwardBars.filter((b) => b.t > position.entryT).slice(0, maxBars);

  if (bars.length === 0) {
    return {
      reason: "unresolved",
      exitPrice: null,
      exitT: null,
      barsHeld: 0,
      gapped: false,
      gapSlippage: 0,
      ambiguousBar: false,
      returnPct: 0,
    };
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const held = i + 1;

    if (session.gapsPossible && openedBeyondStop(side, bar.open, stopPrice)) {
      return {
        reason: "stop",
        exitPrice: bar.open,
        exitT: bar.t,
        barsHeld: held,
        gapped: true,
        // Negative: a long gapping below its stop fills lower than intended.
        gapSlippage: side === "long" ? bar.open - stopPrice : stopPrice - bar.open,
        ambiguousBar: false,
        returnPct: pctReturn(side, entryPrice, bar.open),
      };
    }

    if (session.gapsPossible && openedBeyondTarget(side, bar.open, targetPrice)) {
      return {
        reason: "target",
        exitPrice: bar.open,
        exitT: bar.t,
        barsHeld: held,
        gapped: true,
        gapSlippage: side === "long" ? bar.open - targetPrice : targetPrice - bar.open,
        ambiguousBar: false,
        returnPct: pctReturn(side, entryPrice, bar.open),
      };
    }

    const hitStop = touchedStop(side, bar, stopPrice);
    const hitTarget = touchedTarget(side, bar, targetPrice);

    if (hitStop) {
      return {
        reason: "stop",
        exitPrice: stopPrice,
        exitT: bar.t,
        barsHeld: held,
        gapped: false,
        gapSlippage: 0,
        ambiguousBar: hitTarget,
        returnPct: pctReturn(side, entryPrice, stopPrice),
      };
    }

    if (hitTarget) {
      return {
        reason: "target",
        exitPrice: targetPrice,
        exitT: bar.t,
        barsHeld: held,
        gapped: false,
        gapSlippage: 0,
        ambiguousBar: false,
        returnPct: pctReturn(side, entryPrice, targetPrice),
      };
    }
  }

  const last = bars[bars.length - 1];
  return {
    reason: "timeout",
    exitPrice: last.close,
    exitT: last.t,
    barsHeld: bars.length,
    gapped: false,
    gapSlippage: 0,
    ambiguousBar: false,
    returnPct: pctReturn(side, entryPrice, last.close),
  };
}
