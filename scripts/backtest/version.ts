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
 *
 * 4.0.0: Phase 4 retired the regime weight multipliers after ablation
 * showed they did not earn their place. This changes what the engine would
 * have decided on 116 of 2,896 historical days, so it is a major bump even
 * though the diff is a handful of emptied objects.
 *
 * 5.0.0: `longShort` left the Edge roster. It was never a second opinion —
 * it read the same long/short ratio `squeezeRisk` reads and mapped it to the
 * opposite verdict, so on all 1,181 replay observations where both took a
 * position they took opposite ones and the pair netted 0.14 − 0.08 = 0.06
 * instead of voting 0.22. Removing it restores squeezeRisk to full weight
 * and stops the leverage cluster registering a manufactured disagreement.
 *
 * Measured on the same 2,896 replayed days, old engine vs new: 2,449 days
 * rescored (mean |delta| 1.7 points), 216 verdicts flipped, 395 actions
 * changed, and mean agreement rose 38.9 -> 49.3 — that last figure is the
 * manufactured split going away, not the market agreeing more.
 *
 * It cost in-sample expectancy: 0.42% -> 0.21% net per trade, profit factor
 * 1.19 -> 1.10. That is NOT evidence the change was wrong. Overlap-corrected
 * (6-day blocks, 138h median hold) the standard error on expectancy is
 * 0.37pp, so the two numbers are 0.6 SE apart and NEITHER is distinguishable
 * from zero. What the drop actually shows is how much of the old record
 * rested on a weight — 0.06 — that no one chose.
 *
 * 6.0.0: `spotPerpVolume` left the Edge roster too, and for a worse reason
 * than longShort's. Its verdict was not merely correlated with Price Action's
 * — it WAS Price Action's, read straight off `ctx.technicals.direction` and
 * gated on spot participation. Price Action is role "state"; it does not vote,
 * because the module census graded it at 49.1% at 4h against a 49.9% base rate
 * on nEff 1098. Its direction was nonetheless reaching the composite at weight
 * 0.05 under a volume label, and not even faithfully: the price row reports
 * neutral below trend strength 20 and this gate did not, so on 417 of 2,896
 * replayed days the wrapper published a direction Price Action had declined to
 * call. Over the 1,648 days where both took a direction they agreed 1,648
 * times — rho +1.000, zero opposed cells.
 *
 * The metric is now permanently neutral and role "context". The turnover mix
 * it measures is real information about how DURABLE a move is, so it moved to
 * the row it qualifies: evaluateTechnicals raises the leverage-led case as a
 * conflict on Price Action.
 *
 * Measured on the same 2,896 replayed days, 5.0.0 vs 6.0.0: the wrapper took
 * a direction on 2,065 of them (71%), so removing it rescored 2,620 days
 * (mean |delta| 3.5 points, max 10.0), flipped 549 verdicts and changed 308
 * actions — a LARGER decision delta than 5.0.0's, from a smaller weight.
 *
 * The reason is not the 0.05. The headline score is category-weighted, and
 * spotPerpVolume was the only voting metric left in `marketStructure`. With
 * it gone that category scores null, `combineCategoryScores` skips it, and
 * its 0.25 renormalizes across the other three — taking positioning from
 * 0.35 to 0.467. The composite did not lose a small vote; it lost a quarter
 * of its category structure, and that quarter had been resting on one
 * wrapper of a non-voting read. See CATEGORY_WEIGHTS in categories.ts.
 *
 * The record barely moves: 1,218 -> 1,130 resolved trades, net expectancy
 * 0.206% -> 0.153%, profit factor 1.098 -> 1.072. Overlap-corrected (6-day
 * blocks against the 138h median hold, 194 blocks) the SE on expectancy is
 * 0.31pp, so the 0.053pp drop is 0.16 SE and neither figure is
 * distinguishable from zero. Naive sd/sqrt(n) would have said 0.17pp — still
 * the ~2x understatement that made this correction necessary in the first
 * place.
 *
 * Module breadth drops from 12 correlatable modules to 11 and the +1.000 pair
 * is gone. `squeezeRisk / longShort` still prints at -1.000: 5.0.0 stopped
 * longShort VOTING, not describing, so it still occupies a census slot. See
 * moduleBreadth.ts.
 */
export const ENGINE_VERSION = "6.0.0";

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
