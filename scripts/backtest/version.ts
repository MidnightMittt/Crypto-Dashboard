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
 *
 * 7.0.0: `technicals` stopped voting in the SECOND engine. 6.0.0 removed a
 * wrapper that was laundering Price Action's direction into the Edge
 * composite; this removes Price Action's direction from marketThesis.ts,
 * where it had been voting openly at 0.14 — the second-largest pillar — the
 * whole time. Same read, two engines, opposite answers to "may this signal
 * speak?" The census says no at every horizon it was graded on: 48.84% /
 * 49.11% / 47.97% at 1h / 4h / 24h against base rates of 49.99% / 49.93% /
 * 50.04%, n=2,195, nothing significant. See the WEIGHTS doc in
 * lib/sentiment/marketThesis.ts for why that reads as "no evidence of edge"
 * rather than "contrarian signal."
 *
 * ── This bumps because of the action gate, not the score ───────────────
 *
 * Measured 6.0.0 vs 7.0.0 over the same 2,896 days: `biasScore`,
 * `biasVerdict`, `biasConfidence` and `biasAgreement` are byte-identical on
 * every single day. Zero. The thesis genuinely is a separate object from the
 * category-weighted composite and does not feed it.
 *
 * It does feed the TRADE GATE. buildTradeRecommendation blocks a trade when
 * `thesis.dominant` opposes the bias direction (blockingLayer: "thesis"), so
 * moving 0.14 out of the thesis changed `action` on 263 days and the
 * entry/stop/target triplet on 73. That is a change to what the engine would
 * have DONE on a historical day, which is the bump rule, even though what it
 * would have SAID is untouched.
 *
 * ── Every one of those 263 days is on the long side ────────────────────
 *
 *   enter-long   171 -> 98   (-73, all to no-trade)
 *   enter-short  959 -> 959  (zero change)
 *
 * This is not a coincidence and it is not caused here. The thesis fades
 * crowded positioning, and crypto funding is positive most of the time, so
 * the thesis reads bearish or squeeze-bearish on 75.1% of replayed days and
 * bullish on 12.6%. Price action was the one input that could push it
 * bullish; without it the split is 76.2% / 5.0%. A veto that points one way
 * 76% of the time and the other way 5% is close to an unconditional veto on
 * longs, and this change sharpened an asymmetry that was already there.
 *
 * The fix for that is in tradeRecommendation.ts, not here, and it needs its
 * own measurement. Keeping an ungraded input in the thesis to counterweight
 * a lopsided gate would be two wrongs, not one right.
 *
 * ── "Trending" is now unreachable in the replay, and that is the finding ─
 *
 * Trending Bearish 641 -> 0, Trending Bullish 8 -> 0. Not rare — zero.
 *
 * `conviction` is agreement x PARTICIPATION, and participation is the share
 * of present weight that is directional at all. In the replay four of the
 * seven remaining sources have no historical archive and drop out, and
 * `funding` — the largest surviving weight at 0.17 — sits inside the
 * +/-0.04%/8h neutral band on 2,863 of 2,896 days, because FUNDING_BANDS is
 * calibrated for the live OI-weighted multi-venue composite and the replay
 * has single-venue Binance. So the replayed thesis is squeezeRisk 0.16 plus
 * basis 0.10 directional against funding 0.17 sitting neutral: participation
 * caps at 0.26/0.43 = 0.605, and conviction caps at 6. REGIME_TREND_
 * CONVICTION is 7.
 *
 * Adding technicals' 0.14 to the numerator was what cleared it. Checked
 * rather than assumed: of the 649 old Trending days, price action was
 * directional on 649. 100%. Every "Trending Bearish" this engine ever
 * printed in the replay was manufactured by the participation contribution
 * of a signal with no measured edge.
 *
 * Live is a different object — seven directional sources, real multi-venue
 * funding — so Trending remains reachable there. DO NOT reconcile the two by
 * lowering REGIME_TREND_CONVICTION against the replay's distribution; that
 * would restore the label by fiat after removing the thing that earned it.
 *
 * ── The record ─────────────────────────────────────────────────────────
 *
 * 1,130 -> 1,057 resolved trades, net expectancy 0.153% -> 0.097%, profit
 * factor 1.072 -> 1.045. Block-bootstrapped over 6-day blocks (185 blocks)
 * the SE on the new expectancy is 0.356pp, so it sits t=+0.27 from zero and
 * the 0.056pp drop is at most 0.11 SE. Neither number is distinguishable
 * from zero and neither is evidence about this change.
 *
 * One honest note on that SE: 6.0.0's entry recorded 0.31pp for the same
 * data where this pass computes 0.343pp, a bootstrap-settings difference,
 * not a data one. Both are ~2.07x the naive sd/sqrt(n), which is the number
 * that matters.
 *
 * 8.0.0: the layer-conflict veto in tradeRecommendation.ts now requires the
 * opposing thesis to clear REGIME_TREND_CONVICTION (7) before it refuses a
 * trade. Below that bar the conflict is written into the recommendation as a
 * caveat and the trade proceeds. Measurements: scripts/audit/thesisVeto.ts.
 *
 * ── This does NOT make the gate symmetric, and nothing here can ─────────
 *
 * 7.0.0's entry ends by promising the asymmetry would be fixed in
 * tradeRecommendation.ts. That promise was half wrong, and the half that was
 * wrong is the more important half.
 *
 * The veto RULE was always symmetric — `thesis.dominant !== direction`, no
 * side named. It fired on 69.8% of long setups (263/377) and 1.1% of shorts
 * (19/1,793) because of the two layers' MARGINAL distributions, not because
 * of anything in the rule. The bias verdict is bearish on 61.9% of replayed
 * days and bullish on 13.0%; the thesis leans bearish most of the time for
 * the reason 7.0.0 gives. Two layers that both lean the same way agree on
 * shorts and collide on longs, and a symmetric rule applied to lopsided
 * inputs fires lopsidedly. That is arithmetic.
 *
 * So a side-aware correction here — a laxer bar for longs, a stricter one for
 * shorts — would install a second bias to cancel the first and leave both in
 * place. That is the same "two wrongs" 7.0.0 refused when it declined to keep
 * an ungraded input in the thesis as a counterweight. Declined again.
 *
 * ── What was actually broken: `dominant` has no deadband ────────────────
 *
 * `thesis.dominant` is `bullWeight > bearWeight`, strict inequality. The
 * thinnest lean refused a trade exactly as hard as a strong one. The veto's
 * own comment justified itself as the two layers being in "open
 * disagreement," and the honest reading of that phrase is that the opposing
 * thesis clears the bar at which the thesis calls ITSELF directional. It
 * publishes that bar already: REGIME_TREND_CONVICTION, the Trending/Leaning
 * boundary. It is now exported and both consumers read the one number.
 *
 * Conviction on the 282 veto days: 2 -> 122 (43.3%), 4 -> 32 (11.3%),
 * 6 -> 128 (45.4%), >=7 -> 0. Regime label on those days: "Leaning Bearish"
 * 146, "Squeeze Setup — Longs Exposed" 72, "Consolidation" 57, "Leaning
 * Bullish" 7. Fifty-seven refusals came from a thesis whose own label says
 * there is no setup in either direction.
 *
 * The threshold is chosen SEMANTICALLY — it is the existing published
 * boundary and it matches the veto's stated justification. The sensitivity
 * scan in thesisVeto.ts is labelled as a check, not a selection procedure,
 * because picking the bar off the outcome table is how you fit noise.
 *
 * ── The veto bought nothing measurable ──────────────────────────────────
 *
 * Signed forward return, vetoed vs allowed, paired block bootstrap over the
 * date axis (10-day blocks, 2,000 draws, BTC and ETH drawn together):
 *
 *   long side    t = -0.19 / +1.09 / +1.22   at 1d / 3d / 7d
 *   short side   t = -0.92 / +0.01 / +0.41
 *
 * The sign is not even stable across horizons. A note on why the bootstrap is
 * paired: vetoed and allowed are complementary subsets of the SAME dates, so
 * they are not independent and their SEs cannot be combined in quadrature.
 * The first pass did exactly that and reported bearish-1d at t=-4.09. Forming
 * the difference inside each replicate gives t=-0.92. That error would have
 * published a significant defence of a veto that has none.
 *
 * ── HONEST DISCLOSURE: the shipped bar fires zero times here ────────────
 *
 * At REGIME_TREND_CONVICTION the veto never fires in the replay — all 282
 * blocks are released. So this change is, in the replay, indistinguishable
 * from deleting the veto, and the replay cannot tell you whether the retained
 * gate is worth anything. It is retained on the semantic argument, not on
 * evidence: live has seven directional sources against the replay's four and
 * reaches Trending, per 7.0.0's note on not reconciling the two.
 *
 * ── Replay diff, 7.0.0 -> 8.0.0, same 2,896 days ────────────────────────
 *
 * bias fields changed on 0 days. `action` changed on 282, entry/stop/target
 * on 143.
 *
 *   no-trade -> enter-long   141      no-trade -> wait-long   122
 *   no-trade -> wait-short    17      no-trade -> enter-short   2
 *
 *   enter-long    98 -> 239     enter-short  959 -> 961
 *   no-trade    1008 -> 726
 *
 * ── The record improved and that is NOT the evidence ────────────────────
 *
 * n 1,057 -> 1,200, expectancy 0.097% -> 0.324%, profit factor 1.045 ->
 * 1.155. Overlap-corrected over 6-day blocks (4,000 draws):
 *
 *   all     n=1,200  exp  0.324%  blockSE 0.365  (137 blocks)  t = +0.89
 *   long    n=  239  exp  2.141%  blockSE 0.751  ( 32 blocks)  t = +2.85
 *   short   n=  961  exp -0.128%  blockSE 0.408  (106 blocks)  t = -0.31
 *
 * The aggregate blockSE is 2.21x the naive sd/sqrt(n). t=+0.89 is not
 * distinguishable from zero, so the tripled expectancy is not evidence.
 *
 * The long leg's t=+2.85 is in-sample and the window is a crypto bull market.
 * Drift control: unconditional 7d return is 0.537% across all days, 2.672% on
 * long-entry days and 0.434% on short-entry days, mean hold 118h. Entry
 * selection is doing something, but a long book in this window earns most of
 * that from the market.
 *
 * ── What the veto was actually filtering ────────────────────────────────
 *
 * The 141 released long trades returned 1.969% on average, 54.6% win rate.
 * The 98 longs the veto already allowed returned 2.389%, 68.4%. Difference
 * 0.419pp, blockSE 0.862, t = 0.49 over 19 blocks. The veto was not screening
 * out losers; it was screening out slightly-below-average winners, and the
 * claim that it selected better ones does not survive its own standard error.
 *
 * ── The finding worth more than this change ─────────────────────────────
 *
 * The short book is 961 trades at -0.128% expectancy, profit factor 0.945. It
 * is the unprofitable leg, and the veto exempted it almost entirely (1.1%)
 * while blocking 69.8% of the profitable one. Whatever the gate was doing, it
 * was doing it exactly backwards. That is a separate investigation into why
 * the engine takes ten times as many shorts as longs and loses money on them;
 * it is not fixable in the veto and is not attempted here.
 */
export const ENGINE_VERSION = "8.0.0";

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
