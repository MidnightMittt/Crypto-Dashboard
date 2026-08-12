import { Candle } from "../../src/lib/technicals/indicators";

/**
 * PHASE 7 — Market regime model. RESEARCH PROTOTYPE, deliberately under
 * scripts/ so the app cannot import it until it has earned promotion, the
 * same staging the harmonic engine went through.
 *
 * ── What this measures, and why it is not "is price bullish" ────────────
 *
 * The existing regimes.ts already answers "which way has price gone"
 * (trailing 20d return) and "how volatile is it" (realized-vol percentile).
 * Neither answers the question this phase is actually about: does price in
 * this environment MOVE IN STRAIGHT LINES OR GO NOWHERE. That property —
 * trend persistence — is what determines whether a continuation signal or a
 * reversal signal is the right tool, and nothing in the engine currently
 * measures it.
 *
 * The measure is Kaufman's Efficiency Ratio: net displacement divided by
 * total distance travelled. Chosen over the alternatives (ADX, Hurst
 * exponent, variance ratios) for three reasons that matter here:
 *   - It is bounded [0,1] and unitless, so it is comparable across assets
 *     and price levels with no normalisation — a requirement, since this
 *     module is meant to extend beyond crypto.
 *   - It has exactly one parameter (the lookback) and no fitted
 *     coefficients, so there is nothing to curve-fit.
 *   - It is directly interpretable: 1.0 is a straight line, 0.0 is a round
 *     trip back to where it started.
 *
 * ── Sizing ──────────────────────────────────────────────────────────────
 *
 * Three states, not sixteen. The backtest carries 354 statistically
 * independent trades; a sixteen-state taxonomy would leave ~22 apiece
 * before any interaction is tested, which is enough to label a chart and
 * not remotely enough to validate a claim. The taxonomy is sized to the
 * evidence rather than to the vocabulary.
 *
 * ── Asset-agnostic by construction ──────────────────────────────────────
 *
 * No crypto constants, no hardcoded price scales, no venue assumptions.
 * Every threshold is a PERCENTILE against the instrument's own trailing
 * history, so the same code classifies an equity, an ETF or a future
 * without retuning — which is the stated requirement for reuse.
 */

/** Bars used for both the efficiency and volatility measures. Matches regimes.ts's own TREND_LOOKBACK_DAYS so the two reads describe the same window and can be compared directly. */
export const REGIME_LOOKBACK = 20;
/** Trailing window a measure is percentile-ranked against. Mirrors regimes.ts's PERCENTILE_WINDOW_DAYS. */
export const PERCENTILE_WINDOW = 180;
/** Below this many prior observations a percentile is not meaningful, and the classifier says so rather than guessing. */
export const MIN_PERCENTILE_HISTORY = 30;

/**
 * Kaufman's Efficiency Ratio over the `lookback` bars ending at index `i`.
 *
 * |close[i] - close[i-n]| / sum(|close[j] - close[j-1]|)
 *
 * Returns null without enough history, and 0 for a completely flat series
 * (zero distance travelled) — which is genuinely maximally inefficient, not
 * an error, so it is a value rather than a null.
 */
export function efficiencyRatio(candles: Candle[], i: number, lookback = REGIME_LOOKBACK): number | null {
  if (i < lookback || lookback <= 0) return null;
  const net = Math.abs(candles[i].close - candles[i - lookback].close);
  let distance = 0;
  for (let j = i - lookback + 1; j <= i; j++) {
    distance += Math.abs(candles[j].close - candles[j - 1].close);
  }
  if (distance <= 0) return 0;
  return net / distance;
}

/** Realized volatility: stdev of log returns over `lookback` bars ending at i. Mirrors regimes.ts's own definition so the two modules cannot disagree about what volatility means. */
export function realizedVol(candles: Candle[], i: number, lookback = REGIME_LOOKBACK): number | null {
  if (i < lookback) return null;
  const logReturns: number[] = [];
  for (let j = i - lookback + 1; j <= i; j++) {
    if (candles[j - 1].close <= 0 || candles[j].close <= 0) return null;
    logReturns.push(Math.log(candles[j].close / candles[j - 1].close));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance);
}

/**
 * Consecutive days a new label must hold before the regime switches to it.
 *
 * Raw tercile classification flips roughly every 3.5 days, which is faster
 * than the swing thesis it is supposed to provide context FOR — a context
 * layer that churns quicker than the decision beneath it is worse than
 * none. This is the same consecutive-confirmation hysteresis swingThesis.ts
 * already uses for exactly this reason, applied to the regime label.
 *
 * Chosen for stability, NOT because it improved any statistic: the
 * robustness check in regimeStudy.ts reports the stabilised and unstabilised
 * results side by side rather than adopting whichever reads better.
 */
export const REGIME_CONFIRM_DAYS = 3;

/**
 * Applies confirmation hysteresis to a chronological label series.
 *
 * Causal by construction: the output at index i depends only on labels at
 * indices <= i, so a stabilised series can be used at decision time without
 * look-ahead. Returns a new array; the input is not mutated.
 */
export function stabilizeLabels<T extends string>(labels: T[], confirmDays = REGIME_CONFIRM_DAYS): T[] {
  if (labels.length === 0) return [];
  const out: T[] = [labels[0]];
  let current = labels[0];
  let candidate = labels[0];
  let streak = 0;

  for (let i = 1; i < labels.length; i++) {
    const raw = labels[i];
    if (raw === current) {
      streak = 0;
      candidate = current;
    } else if (raw === candidate) {
      streak++;
      if (streak >= confirmDays) {
        current = candidate;
        streak = 0;
      }
    } else {
      candidate = raw;
      streak = 1;
      if (confirmDays <= 1) {
        current = candidate;
        streak = 0;
      }
    }
    out.push(current);
  }
  return out;
}

/** Fraction of `priorValues` strictly below `value`. Callers must pass only STRICTLY EARLIER observations — that is what makes the percentile look-ahead-safe. */
export function percentileRank(value: number, priorValues: number[]): number {
  if (priorValues.length === 0) return 0.5;
  return priorValues.filter((v) => v < value).length / priorValues.length;
}

/** The trend-persistence axis. This is the new information the engine does not already have. */
export type Efficiency = "trending" | "mixed" | "choppy";
/** The volatility axis. Deliberately the SAME three-way split regimes.ts already uses, so the cross-tab below is comparable to the existing tags rather than a parallel vocabulary. */
export type VolState = "high" | "normal" | "low";

export interface MarketRegimeRead {
  efficiency: Efficiency;
  /** Raw ER, 0-1, kept so the study can check how much of the signal survives dropping the discretisation. */
  efficiencyRatio: number;
  /** Percentile of that ER against the instrument's own trailing history. */
  efficiencyPercentile: number;
  volatility: VolState;
  volatilityPercentile: number;
  /** True once BOTH percentiles rest on a full baseline. When false the labels are still returned but are the degraded "normal"/"mixed" defaults. */
  calibrated: boolean;
}

/**
 * Classifies the bar at `candles[i]`.
 *
 * Terciles, not tuned cut points: a measure is "trending" if its efficiency
 * sits in the top third of its OWN recent history, "choppy" in the bottom
 * third. There is no number here that could have been fitted to outcomes,
 * which is the property that lets this be tested honestly afterwards.
 *
 * Returns null only when there is not even enough history for the raw
 * measures. When the measures exist but the percentile baseline has not
 * built up, it degrades to the neutral labels rather than refusing — the
 * same graceful-degradation contract regimes.ts already follows.
 */
export function classifyMarketRegime(candles: Candle[], i: number, lookback = REGIME_LOOKBACK): MarketRegimeRead | null {
  const er = efficiencyRatio(candles, i, lookback);
  const vol = realizedVol(candles, i, lookback);
  if (er === null || vol === null) return null;

  const historyStart = Math.max(lookback, i - PERCENTILE_WINDOW);
  const erHistory: number[] = [];
  const volHistory: number[] = [];
  // STRICTLY earlier bars only (j < i) — this loop bound is the look-ahead guard.
  for (let j = historyStart; j < i; j++) {
    const e = efficiencyRatio(candles, j, lookback);
    if (e !== null) erHistory.push(e);
    const v = realizedVol(candles, j, lookback);
    if (v !== null) volHistory.push(v);
  }

  if (erHistory.length < MIN_PERCENTILE_HISTORY || volHistory.length < MIN_PERCENTILE_HISTORY) {
    return {
      efficiency: "mixed",
      efficiencyRatio: er,
      efficiencyPercentile: 0.5,
      volatility: "normal",
      volatilityPercentile: 0.5,
      calibrated: false,
    };
  }

  const erPct = percentileRank(er, erHistory);
  const volPct = percentileRank(vol, volHistory);

  return {
    efficiency: erPct >= 2 / 3 ? "trending" : erPct <= 1 / 3 ? "choppy" : "mixed",
    efficiencyRatio: er,
    efficiencyPercentile: erPct,
    volatility: volPct >= 2 / 3 ? "high" : volPct <= 1 / 3 ? "low" : "normal",
    volatilityPercentile: volPct,
    calibrated: true,
  };
}
