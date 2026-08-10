/**
 * Trading friction, subtracted from gross trade returns.
 *
 * A backtest that reports gross moves as if they were realized P&L is
 * telling a comfortable lie: on a 7-day perp hold, funding alone can exceed
 * the entire edge. Everything here exists so the report can put GROSS and
 * NET side by side and let the difference be visible rather than assumed
 * away.
 *
 * Funding is not an assumption — it's the real historical Binance
 * settlement series already downloaded by fetchHistory.mjs (8-hourly,
 * ~5,200 settlements across the window). Fees and slippage ARE assumptions,
 * declared as explicit constants below and stamped into every output file
 * so any published net figure can be traced to the numbers that produced it.
 */

export interface CostConfig {
  /** Per leg, in basis points. Taker, not maker — the engine's entries are "if entering now," which is a market order. */
  takerFeeBpsPerLeg: number;
  /**
   * Per leg, in basis points. Deliberately non-zero even for the entry: a
   * stop-market exit in a fast move slips well past the trigger, and
   * modelling a perfect fill at the exact stop price is one of the standard
   * ways a backtest manufactures an edge it doesn't have.
   */
  slippageBpsPerLeg: number;
}

/**
 * Binance USDⓈ-M taker fee at the base VIP-0 tier is 5bp; slippage of 2bp
 * per leg is a deliberately conservative round number for BTC/ETH perps at
 * retail size, not a measured figure — there is no historical order-book
 * depth in this dataset to derive a real one from, and inventing a
 * precise-looking number would be worse than a round, disclosed one.
 */
export const DEFAULT_COST_CONFIG: CostConfig = {
  takerFeeBpsPerLeg: 5,
  slippageBpsPerLeg: 2,
};

export interface FundingPoint {
  t: number;
  /** Percent per 8-hour settlement, positive meaning longs pay shorts. */
  fundingRatePct: number;
}

const BPS_TO_PCT = 0.01;

/**
 * Fees + slippage for a full round trip, as a percent of entry notional.
 *
 * Both legs are charged against ENTRY notional rather than each leg's own
 * notional. At these fee levels the difference is second-order, and
 * modelling it precisely would imply an accuracy the 2bp slippage guess
 * plainly doesn't have.
 */
export function roundTripCostPct(config: CostConfig = DEFAULT_COST_CONFIG): number {
  return 2 * (config.takerFeeBpsPerLeg + config.slippageBpsPerLeg) * BPS_TO_PCT;
}

/**
 * Funding actually paid over the hold, as a percent of notional, signed as
 * a COST: positive reduces the trade's return.
 *
 * A long pays when funding is positive and receives when it's negative; a
 * short is the mirror. Settlements are counted on the half-open interval
 * (entryT, exitT] — a settlement landing exactly at entry belongs to
 * whoever held the position before this trade opened, and one landing
 * exactly at exit is still owed.
 *
 * Assumes `series` is sorted ascending by `t` (the early `break` relies on
 * it) — the same convention `run.ts`'s own `atOrBefore`/`closestWithin`
 * helpers already take against these archives, and cheaper than re-sorting
 * a 5,000-point series once per replayed day.
 */
export function fundingCostPct(
  side: "long" | "short",
  entryT: number,
  exitT: number,
  series: FundingPoint[]
): number {
  let paid = 0;
  for (const point of series) {
    if (point.t <= entryT) continue;
    if (point.t > exitT) break;
    paid += point.fundingRatePct;
  }
  return side === "long" ? paid : -paid;
}

export interface NetReturn {
  grossReturnPct: number;
  feeAndSlippagePct: number;
  fundingCostPct: number;
  netReturnPct: number;
}

/**
 * Applies every cost to one resolved trade. Keeps each component separate
 * in the return value rather than collapsing to a single net number, so a
 * report can show WHICH friction ate the edge — funding on a long hold and
 * fees on a fast scalp are very different problems.
 */
export function applyCosts(
  grossReturnPct: number,
  side: "long" | "short",
  entryT: number,
  exitT: number,
  fundingSeries: FundingPoint[],
  config: CostConfig = DEFAULT_COST_CONFIG
): NetReturn {
  const feeAndSlippagePct = roundTripCostPct(config);
  const funding = fundingCostPct(side, entryT, exitT, fundingSeries);
  return {
    grossReturnPct,
    feeAndSlippagePct,
    fundingCostPct: funding,
    netReturnPct: grossReturnPct - feeAndSlippagePct - funding,
  };
}
