import { TradeDirection } from "../signals/tradePlan";
import { RiskConfig, PositionSizing, PaperPosition, SwingTarget } from "./types";

/**
 * RISK MANAGEMENT — sizing from structure, and the rules that refuse a trade.
 *
 * Position size is derived from the distance between entry and the STRUCTURAL
 * stop, never from a fixed notional. That is the whole point: a tight stop
 * buys more size for the same risk, a wide one buys less, and the capital at
 * risk stays constant. A fixed position size does the opposite — it makes
 * risk a function of volatility, which is backwards.
 *
 * Every default in DEFAULT_RISK_CONFIG is conservative and every one is
 * configurable. Nothing here is tuned to a backtest, because nothing in this
 * project has a validated edge to tune against.
 */

export interface RiskState {
  openPositions: PaperPosition[];
  /** Realised P&L today and this week, as signed currency. */
  realisedToday: number;
  realisedThisWeek: number;
}

/**
 * Size a position so that a stop-out costs exactly `maxRiskPerTrade` of equity.
 *
 * Returns null when the stop is on the wrong side of entry or coincides with
 * it — both mean the plan is malformed, and inventing a size for it would be
 * worse than refusing.
 */
export function sizePosition(
  entry: number,
  stop: number,
  direction: TradeDirection,
  config: RiskConfig
): PositionSizing | null {
  if (!(entry > 0) || !(stop > 0)) return null;
  // A long's stop must sit BELOW entry, a short's ABOVE. Anything else is a
  // malformed plan, not a tiny position.
  if (direction === "long" && stop >= entry) return null;
  if (direction === "short" && stop <= entry) return null;

  const stopDistance = Math.abs(entry - stop);
  const stopDistancePct = stopDistance / entry;
  const riskAmount = config.accountEquity * config.maxRiskPerTrade;
  const quantity = riskAmount / stopDistance;
  const notional = quantity * entry;

  return {
    quantity,
    notional,
    riskAmount,
    riskPctOfEquity: config.maxRiskPerTrade * 100,
    stopDistancePct,
    explanation:
      `Risking ${(config.maxRiskPerTrade * 100).toFixed(2)}% of ` +
      `${config.accountEquity.toLocaleString()} = ${riskAmount.toFixed(2)}. ` +
      `Stop is ${(stopDistancePct * 100).toFixed(2)}% away, so size is ` +
      `${quantity.toPrecision(4)} units (${notional.toFixed(2)} notional).`,
  };
}

/** Correlation grouping. Crude on purpose — one bucket for crypto majors. */
export function correlationGroup(asset: string): string {
  return ["BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX", "LINK"].includes(asset.toUpperCase())
    ? "crypto-major"
    : asset.toUpperCase();
}

/**
 * Every reason this trade may not be taken. Returns null when it may.
 *
 * Checks run in order of severity so the message names the most fundamental
 * problem rather than the first one encountered.
 */
export function checkRiskConstraints(input: {
  asset: string;
  direction?: TradeDirection;
  riskReward: number;
  sizing: PositionSizing | null;
  state: RiskState;
  config: RiskConfig;
}): string | null {
  const { asset, direction, riskReward, sizing, state, config } = input;

  if (!sizing) {
    return "No valid position size — the stop is not on the correct side of entry.";
  }

  /*
   * NEVER HOLD BOTH SIDES OF THE SAME ASSET.
   *
   * The scanner evaluates long AND short candidates independently, and on
   * 2026-06-05 a walk-forward run opened a BTC long and a BTC short on the
   * same bar — two positions whose theses directly contradict, paying fees
   * both ways to hold a net flat book. Neither the position cap nor the
   * correlation cap caught it, because both were satisfied.
   *
   * Found by running the full spine; no unit test of either side would have
   * shown it.
   */
  if (direction) {
    const opposing = state.openPositions.find(
      (p) =>
        p.asset === asset &&
        p.direction !== direction &&
        (p.state === "ACTIVE" || p.state === "PARTIALLY_EXITED")
    );
    if (opposing) {
      return `Already holding a ${opposing.direction} in ${asset} — refusing to take the opposite side of the same asset.`;
    }
  }
  if (riskReward < config.minRiskReward) {
    return `Risk/reward ${riskReward.toFixed(2)} is below the ${config.minRiskReward} minimum.`;
  }
  // Loss limits first: once breached, nothing else matters today.
  if (state.realisedToday <= -config.accountEquity * config.maxDailyLoss) {
    return `Daily loss limit reached (${(config.maxDailyLoss * 100).toFixed(1)}% of equity). No new trades today.`;
  }
  if (state.realisedThisWeek <= -config.accountEquity * config.maxWeeklyLoss) {
    return `Weekly loss limit reached (${(config.maxWeeklyLoss * 100).toFixed(1)}% of equity). No new trades this week.`;
  }
  const open = state.openPositions.filter((p) => p.state === "ACTIVE" || p.state === "PARTIALLY_EXITED");
  if (open.length >= config.maxSimultaneousPositions) {
    return `Already holding ${open.length} positions (max ${config.maxSimultaneousPositions}).`;
  }
  // Already-open risk uses REMAINING quantity — a position scaled out of
  // carries less risk than it did at entry, and counting it at full size
  // would lock out trades the book can genuinely afford.
  const openRisk = open.reduce((sum, p) => {
    const perUnit = Math.abs(p.entryPrice - p.stopPrice);
    return sum + perUnit * p.remainingQuantity;
  }, 0);
  const wouldBe = openRisk + sizing.riskAmount;
  if (wouldBe > config.accountEquity * config.maxPortfolioRisk) {
    return (
      `Total open risk would reach ${((wouldBe / config.accountEquity) * 100).toFixed(2)}% ` +
      `(max ${(config.maxPortfolioRisk * 100).toFixed(2)}%).`
    );
  }
  const group = correlationGroup(asset);
  const correlated = open.filter((p) => correlationGroup(p.asset) === group).length;
  if (correlated >= config.maxCorrelatedPositions) {
    return `Already holding ${correlated} positions in ${group} (max ${config.maxCorrelatedPositions}).`;
  }
  return null;
}

/**
 * Attach scale-out fractions from config. Kept separate from target
 * CONSTRUCTION so that how much to sell is a policy decision and where to
 * sell is a structural one — conflating them is how an allocation ends up
 * hardcoded inside a level calculation.
 *
 * When fewer than three targets exist, the configured fractions are
 * renormalised so the position still fully exits rather than silently
 * stranding a remainder.
 */
export function applyScaleOut(targets: Omit<SwingTarget, "closeFraction">[], config: RiskConfig): SwingTarget[] {
  if (!targets.length) return [];
  const raw = config.scaleOut.slice(0, targets.length);
  const total = raw.reduce((a, b) => a + b, 0);
  return targets.map((t, i) => ({ ...t, closeFraction: total > 0 ? raw[i] / total : 1 / targets.length }));
}
