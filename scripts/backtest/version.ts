/**
 * Version stamping for backtest outputs.
 *
 * This exists because of a real defect, not as bookkeeping. The committed
 * backtestStats.json was last regenerated at commit c92845f, after which
 * FIVE commits changed the decision engine without anyone regenerating it
 * — including the one that redefined "Mixed / Low Conviction" as a strict
 * tie. The live dashboard spent that whole stretch reporting N=306 days for
 * a bucket the shipped engine actually puts at 13, and nothing in the data
 * made that detectable.
 *
 * A published statistic that can't be traced to the logic that produced it
 * is worse than no statistic: it looks authoritative while describing
 * something that no longer exists. Every output file now carries this
 * stamp, so staleness is visible instead of silent.
 */

import { DEFAULT_COST_CONFIG, CostConfig } from "./costs";

/**
 * Bump when any change alters what the engine WOULD HAVE DECIDED on a
 * historical day — scoring weights, evaluator thresholds, the action gate,
 * entry/stop/target placement, regime classification.
 *
 * Do NOT bump for presentation, comments, or report formatting: an
 * inflated version is as misleading as a stale one, just in the other
 * direction.
 */
export const ENGINE_VERSION = "3.1.0";

/**
 * Bump when the meaning or shape of the replayed FEATURES changes — a new
 * input series, a different candle window, a changed rollup. Separate from
 * the engine version because the same engine over different inputs is a
 * different experiment.
 *
 * 2.0.0: Phase 3 added 4H candles (rolled up from hourly) and support/
 * resistance zones to the replay, and capped both to the live 300-bar
 * window rather than unbounded history.
 */
export const FEATURE_VERSION = "2.0.0";

export interface BacktestProvenance {
  engineVersion: string;
  featureVersion: string;
  generatedAt: number;
  assets: string[];
  coverageStart: string | null;
  coverageEnd: string | null;
  evaluatedDays: number;
  /** Longest a replayed trade is held before closing at market, in hours. */
  maxHoldHours: number;
  costConfig: CostConfig;
  /** Named so a reader knows which frictions are measured and which are assumed. */
  costNotes: string;
  dataSources: string[];
  /** Decision inputs with no historical source, null throughout the replay. */
  unavailableInputs: string[];
}

export function buildProvenance(params: {
  assets: string[];
  coverageStart: string | null;
  coverageEnd: string | null;
  evaluatedDays: number;
  maxHoldHours: number;
  costConfig?: CostConfig;
}): BacktestProvenance {
  return {
    engineVersion: ENGINE_VERSION,
    featureVersion: FEATURE_VERSION,
    generatedAt: Date.now(),
    assets: params.assets,
    coverageStart: params.coverageStart,
    coverageEnd: params.coverageEnd,
    evaluatedDays: params.evaluatedDays,
    maxHoldHours: params.maxHoldHours,
    costConfig: params.costConfig ?? DEFAULT_COST_CONFIG,
    costNotes:
      "Funding is the real historical Binance 8-hourly settlement series. Fees and slippage are declared assumptions, not measurements — there is no historical order-book depth in this dataset to derive slippage from.",
    dataSources: [
      "Binance Vision archive — hourly futures/spot klines, 8-hourly funding",
      "Coinalyze — open interest, long/short ratio (rolling retention window)",
      "SoSoValue — spot ETF net flows (BTC/ETH only, from 2025-05-21)",
      "alternative.me — Fear & Greed",
      "DefiLlama — total stablecoin supply",
      "FRED — NFCI, T10Y2Y, RRP, TGA, EFFR",
    ],
    unavailableInputs: [
      "orderFlow (OKX rubik retains ~4 days)",
      "deribitOptions (no public historical archive)",
      "spotCvd (taker-buy volume not archived)",
      "exchangeFlow (on-chain balances not archived)",
      "liquidations (not fetched historically)",
      "coinbasePremium (no historical source)",
      "sectorBreadth (live-only)",
      "hyperliquidConfirm (point-in-time order book)",
    ],
  };
}
