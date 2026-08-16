import { LegStats, summariseSeries } from "./overnightDecomposition";

/**
 * THE BASKET TEST — the one that matches how the strategy is actually traded.
 *
 * The per-symbol tests are underpowered by construction and their null was
 * being read as evidence of absence. APLD's best row is 51.0bp net at t=2.17,
 * which implies a standard error near 23bp: reaching t=3 would need a 70bp
 * effect. Benjamini-Hochberg across thirty-two such tests cannot detect a
 * 40bp effect even when it is real. That is a statement about POWER, and this
 * module exists so the artefact can say so with a number rather than leaving
 * "0 of 32 significant" to be misread.
 *
 * ── Why the daily basket, and not the pool of name-days ───────────────
 *
 * The strategy holds a basket overnight, so the unit of risk is a NIGHT, not
 * a name-night. These names move together — they are the same trade wearing
 * twelve tickers — so treating each name-day as an independent observation
 * inflates t by roughly the square root of the number of correlated names.
 * The correction is to average across names within a date first and test the
 * resulting daily series, which is what a trader's equity curve actually
 * experiences.
 *
 * Both numbers are reported. The pooled one is labelled inflated and kept
 * beside the clustered one precisely so the size of the illusion is visible:
 * an outside review measured the same effect independently and found pooling
 * overstated t by about 40% here, and by roughly eighty-fold in a related gap
 * study.
 *
 * ── Baskets are DECLARED, never selected on the outcome ───────────────
 *
 * A basket assembled from the names with the largest realised premium is not
 * a test of anything: the selection has already used the answer. Every basket
 * here is defined by a rule fixed before the returns are looked at — an
 * industry, or the whole scanned set — and the benchmark basket is carried as
 * a CONTROL. If the premium is a real feature of these volatile names, the
 * control should show markedly less of it; if the control shows the same
 * thing, the effect is the market and not the cohort.
 */

/** One name's net overnight return on one date. */
export interface BasketObservation {
  date: string;
  symbol: string;
  netBp: number;
}

export interface BasketResult {
  basket: string;
  /** Members actually contributing observations, so the row is checkable. */
  symbols: string[];
  window: number;
  /** Distinct DATES. The honest sample size — one night, one observation. */
  dates: number;
  /** name-days: what a naive pooled test would call n. */
  nameDays: number;
  /** Mean names priced on a typical date, so thin dates are visible. */
  meanNamesPerDate: number | null;
  /** The test that matches the trade: statistics on the daily basket mean. */
  clustered: LegStats | null;
  /** The same effect measured as if every name-day were independent. INFLATED. */
  pooled: LegStats | null;
  /**
   * pooled.t / clustered.t — how much independence was assumed that does not
   * exist. Reported rather than hidden, because the ratio IS the finding.
   */
  inflationRatio: number | null;
  /**
   * THE POWER LINE. The smallest true effect this test could have called
   * significant at t=3, given the dispersion actually observed. A null from a
   * test that could not have detected the effect in question is not evidence
   * of absence, and this is the number that says so.
   */
  detectableAtT3Bp: number | null;
}

/** Average the net return across every name priced on each date. */
export function dailyBasketSeries(
  observations: BasketObservation[]
): { date: string; meanBp: number; names: number }[] {
  const byDate = new Map<string, number[]>();
  for (const o of observations) {
    if (!Number.isFinite(o.netBp)) continue;
    byDate.set(o.date, [...(byDate.get(o.date) ?? []), o.netBp]);
  }
  return [...byDate.entries()]
    .map(([date, xs]) => ({
      date,
      meanBp: xs.reduce((s, x) => s + x, 0) / xs.length,
      names: xs.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The smallest effect a test with this dispersion could call significant.
 *
 * t = mean / SE, so the mean required for t = 3 is simply 3 x SE. Stated in
 * the same basis points as the effect, it converts "not significant" into
 * "not significant, and here is what would have had to be true for it to be".
 */
export function detectableEffectBp(sdBp: number, n: number, atT = 3): number | null {
  if (!(n > 1) || !(sdBp > 0)) return null;
  return atT * (sdBp / Math.sqrt(n));
}

export function testBasket(
  basket: string,
  window: number,
  observations: BasketObservation[]
): BasketResult {
  const symbols = [...new Set(observations.map((o) => o.symbol))].sort();
  const daily = dailyBasketSeries(observations);
  const clustered = summariseSeries(daily.map((d) => d.meanBp));
  const pooled = summariseSeries(observations.map((o) => o.netBp));

  return {
    basket,
    symbols,
    window,
    dates: daily.length,
    nameDays: observations.length,
    meanNamesPerDate: daily.length
      ? daily.reduce((s, d) => s + d.names, 0) / daily.length
      : null,
    clustered,
    pooled,
    /*
     * Null rather than Infinity when the clustered t rounds to nothing: a
     * ratio against a zero denominator is not a large inflation, it is an
     * undefined one, and rendering it as a number would invent a finding.
     */
    inflationRatio:
      clustered && pooled && Math.abs(clustered.tStat) > 1e-9
        ? pooled.tStat / clustered.tStat
        : null,
    detectableAtT3Bp: clustered ? detectableEffectBp(clustered.sdBp, clustered.n) : null,
  };
}
