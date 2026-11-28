import { Candle } from "../technicals/indicators";
import { TradeDirection } from "../signals/tradePlan";
import { PaperPosition, PaperFill, RiskConfig, SwingTarget, SwingOpportunity, FillReason } from "./types";

/**
 * PAPER EXECUTION — deliberately pessimistic.
 *
 * ── THE AMBIGUITY RULE, WHICH DECIDES EVERYTHING ────────────────────────
 *
 * A daily bar is four numbers. When its range contains BOTH a target and the
 * stop, the bar cannot say which came first — and the honest answer is not to
 * guess, it is to assume the WORSE one. So:
 *
 *      if a bar could have hit the stop, the stop filled.
 *
 * Optimism here is self-deception that compounds: a backtest that awards the
 * favourable fill on ambiguous bars will out-perform reality by exactly the
 * frequency of those bars, which on volatile assets is substantial.
 *
 * ── GAPS FILL AT THE OPEN, NOT AT THE LEVEL ─────────────────────────────
 *
 * If a bar OPENS beyond the stop, there was never a chance to transact at the
 * stop price. Filling at the stop would manufacture liquidity that did not
 * exist and understate every gap loss. The fill is the open.
 *
 * ── FEES AND SLIPPAGE ARE CHARGED, ALWAYS ───────────────────────────────
 *
 * Both configurable, both applied adversely on every fill — entry and exit,
 * target and stop. A simulation that forgets them reports a strategy nobody
 * can trade.
 */

/** Adverse slippage: a buy fills higher, a sell fills lower. */
function slip(price: number, side: "buy" | "sell", rate: number): number {
  return side === "buy" ? price * (1 + rate) : price * (1 - rate);
}

function feeOn(notional: number, rate: number): number {
  return Math.abs(notional) * rate;
}

export function openPaperPosition(input: {
  opportunity: SwingOpportunity;
  bar: Candle;
  config: RiskConfig;
  now?: number;
}): PaperPosition | null {
  const { opportunity: o, bar, config } = input;
  if (!o.sizing || o.sizing.quantity <= 0) return null;

  const side = o.direction === "long" ? "buy" : "sell";
  // Entry fills at the CLOSE of the confirming bar, not at the planned entry
  // price. The trigger is only known once the bar has closed, so the close is
  // the first price actually transactable on that information.
  const price = slip(bar.close, side, config.slippageRate);
  const qty = o.sizing.quantity;
  const fee = feeOn(price * qty, config.feeRate);

  const entryFill: PaperFill = {
    t: input.now ?? bar.t, reason: "entry", price, quantity: qty, fee, realisedPnl: 0,
    note: `Filled at the close of the confirming bar with ${(config.slippageRate * 1e4).toFixed(0)}bp slippage.`,
  };

  return {
    id: `${o.id}@${bar.t}`,
    opportunityId: o.id,
    asset: o.asset,
    direction: o.direction,
    state: "ACTIVE",
    openedAt: input.now ?? bar.t,
    closedAt: null,
    entryPrice: price,
    quantity: qty,
    remainingQuantity: qty,
    stopPrice: o.plan.stopPrice,
    targets: o.targets,
    fills: [entryFill],
    // Thesis frozen at entry. Recomputing it later would rewrite history to
    // match the outcome, which is the one thing a trade record must not do.
    realisedPnl: -fee,
    thesis: {
      reasons: o.quality.reasons.slice(),
      familyCount: o.quality.familyCount,
      htfAligned: o.quality.htfAligned,
      trendDirection: o.trend.direction,
      entryBasis: o.plan.entryBasis,
      stopBasis: o.plan.stopBasis,
    },
  };
}

function pnlPerUnit(direction: TradeDirection, entry: number, exit: number): number {
  return direction === "long" ? exit - entry : entry - exit;
}

/** Did this bar's range reach `level`, for a position of this direction? */
function reached(bar: Candle, level: number, direction: TradeDirection, kind: "target" | "stop"): boolean {
  const up = (direction === "long" && kind === "target") || (direction === "short" && kind === "stop");
  return up ? bar.high >= level : bar.low <= level;
}

export interface StepResult {
  position: PaperPosition;
  fills: PaperFill[];
  /** Human-readable account of what happened on this bar. */
  events: string[];
}

/**
 * Advance a position by ONE closed bar.
 *
 * Order of evaluation is the conservative rule made concrete: the stop is
 * tested FIRST, and if it could have filled, it did — targets on the same bar
 * are not awarded.
 */
export function stepPaperPosition(input: {
  position: PaperPosition;
  bar: Candle;
  config: RiskConfig;
}): StepResult {
  const { bar, config } = input;
  const p: PaperPosition = { ...input.position, fills: [...input.position.fills], targets: [...input.position.targets] };
  const events: string[] = [];
  const newFills: PaperFill[] = [];
  if (p.state !== "ACTIVE" && p.state !== "PARTIALLY_EXITED") return { position: p, fills: [], events };

  const exitSide = p.direction === "long" ? "sell" : "buy";

  const closeOut = (qty: number, rawPrice: number, reason: FillReason, note: string) => {
    const price = slip(rawPrice, exitSide, config.slippageRate);
    const fee = feeOn(price * qty, config.feeRate);
    const gross = pnlPerUnit(p.direction, p.entryPrice, price) * qty;
    const net = gross - fee;
    const fill: PaperFill = { t: bar.t, reason, price, quantity: qty, fee, realisedPnl: net, note };
    p.fills.push(fill);
    newFills.push(fill);
    p.remainingQuantity -= qty;
    p.realisedPnl += net;
  };

  // ── STOP FIRST, ALWAYS ────────────────────────────────────────────────
  const gappedThroughStop =
    (p.direction === "long" && bar.open <= p.stopPrice) || (p.direction === "short" && bar.open >= p.stopPrice);

  if (gappedThroughStop) {
    // No chance to transact at the stop — the market opened past it.
    closeOut(p.remainingQuantity, bar.open, "stop", "GAPPED through the stop — filled at the open, not the stop price.");
    events.push(`Stop gapped: opened at ${bar.open} beyond a stop of ${p.stopPrice}.`);
    p.state = "COMPLETED";
    p.closedAt = bar.t;
    return { position: p, fills: newFills, events };
  }

  if (reached(bar, p.stopPrice, p.direction, "stop")) {
    const alsoHitTarget = p.targets.some((t) => reached(bar, t.price, p.direction, "target"));
    closeOut(
      p.remainingQuantity,
      p.stopPrice,
      "stop",
      alsoHitTarget
        ? "Bar range contained BOTH a target and the stop — ambiguous intrabar order, resolved conservatively to the stop."
        : "Stop reached."
    );
    events.push(
      alsoHitTarget
        ? `Stop and target both inside one bar — awarded to the stop by the conservative rule.`
        : `Stop hit at ${p.stopPrice}.`
    );
    p.state = "COMPLETED";
    p.closedAt = bar.t;
    return { position: p, fills: newFills, events };
  }

  // ── TARGETS, nearest first ────────────────────────────────────────────
  const ordered = [...p.targets].sort((a, b) =>
    p.direction === "long" ? a.price - b.price : b.price - a.price
  );
  const alreadyFilled = new Set(p.fills.filter((f) => f.reason.startsWith("tp")).map((f) => f.reason));

  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    const reason = `tp${i + 1}` as FillReason;
    if (alreadyFilled.has(reason)) continue;
    if (!reached(bar, t.price, p.direction, "target")) continue;
    if (p.remainingQuantity <= 0) break;
    // Fractions are of the ORIGINAL quantity, so a 40/35/25 plan exits 40% of
    // the position at TP1 — not 40% of whatever happens to remain.
    const qty = Math.min(p.remainingQuantity, p.quantity * t.closeFraction);
    closeOut(qty, t.price, reason, `${reason.toUpperCase()} at ${t.basis}.`);
    events.push(`${reason.toUpperCase()} filled at ${t.price} (${(t.closeFraction * 100).toFixed(0)}% of the position).`);
  }

  if (p.remainingQuantity <= 1e-12) {
    p.remainingQuantity = 0;
    p.state = "COMPLETED";
    p.closedAt = bar.t;
  } else if (newFills.length) {
    p.state = "PARTIALLY_EXITED";
  }

  return { position: p, fills: newFills, events };
}

/** Mark-to-market on the remaining quantity. Zero once flat. */
export function unrealisedPnl(position: PaperPosition, price: number): number {
  if (position.remainingQuantity <= 0) return 0;
  return pnlPerUnit(position.direction, position.entryPrice, price) * position.remainingQuantity;
}

/** Risk still on the table — what a stop-out would cost from here. */
export function remainingRisk(position: PaperPosition): number {
  if (position.remainingQuantity <= 0) return 0;
  return Math.abs(position.entryPrice - position.stopPrice) * position.remainingQuantity;
}
