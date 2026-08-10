/**
 * Baselines the decision engine has to beat to be worth anything.
 *
 * "The strategy made money" is not a result — over 2022-2026 so did holding
 * BTC and doing nothing. The only interesting question is whether the
 * engine beat the alternatives a trader actually had, measured the same way
 * with the same frictions. Anything less is a comparison rigged in the
 * engine's favour.
 *
 * All three baselines below run over the SAME date range and pay the SAME
 * round-trip cost as the engine's own trades. Funding is deliberately
 * excluded from all of them INCLUDING the engine's comparison figure, so
 * the four numbers differ only by strategy — mixing a funding-paying perp
 * strategy against an unfunded spot benchmark would flatter whichever side
 * happened to be short.
 */

import { roundTripCostPct, CostConfig, DEFAULT_COST_CONFIG } from "./costs";

export interface DailyBar {
  t: number;
  close: number;
}

export interface BenchmarkResult {
  name: string;
  description: string;
  n: number;
  totalReturnPct: number;
  annualizedPct: number | null;
  maxDrawdownPct: number | null;
  /** Share of days holding a position — the engine is flat most of the time, so raw return isn't comparable without this. */
  exposurePct: number;
  /**
   * Mean return per trade. Null for the single-position baselines, where
   * "per trade" is meaningless. This is the ONLY field directly comparable
   * to the engine's own expectancy — buy-and-hold's compounded total return
   * answers a different question and comparing the two would be a category
   * error dressed up as a result.
   */
  meanReturnPerTradePct: number | null;
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

function sma(values: number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += values[i];
  return sum / period;
}

/** Peak-to-trough on a daily equity curve. */
function drawdown(equityCurve: number[]): number | null {
  if (equityCurve.length < 2) return null;
  let peak = equityCurve[0];
  let worst = 0;
  for (const eq of equityCurve) {
    peak = Math.max(peak, eq);
    worst = Math.min(worst, eq / peak - 1);
  }
  return worst * 100;
}

function summarize(
  name: string,
  description: string,
  equityCurve: number[],
  bars: DailyBar[],
  exposedDays: number,
  trades: number
): BenchmarkResult {
  const totalReturnPct = (equityCurve[equityCurve.length - 1] - 1) * 100;
  const elapsedDays = (bars[bars.length - 1].t - bars[0].t) / MS_PER_DAY;
  const finalEquity = equityCurve[equityCurve.length - 1];
  return {
    name,
    description,
    n: trades,
    totalReturnPct,
    annualizedPct:
      elapsedDays > 0 && finalEquity > 0 ? (Math.pow(finalEquity, DAYS_PER_YEAR / elapsedDays) - 1) * 100 : null,
    maxDrawdownPct: drawdown(equityCurve),
    exposurePct: (exposedDays / bars.length) * 100,
    meanReturnPerTradePct: null,
  };
}

/** Hold from the first bar to the last. One round trip. */
export function buyAndHold(bars: DailyBar[], config: CostConfig = DEFAULT_COST_CONFIG): BenchmarkResult {
  const cost = roundTripCostPct(config) / 100;
  const start = bars[0].close;
  const equityCurve = bars.map((b) => (b.close / start) * (1 - cost));
  return summarize("Buy and hold", "Long from the first day to the last, one round trip of cost.", equityCurve, bars, bars.length, 1);
}

/**
 * Long while SMA(fast) > SMA(slow), flat otherwise. Long-only on purpose:
 * a symmetric always-in version is a different, more aggressive strategy,
 * and picking whichever variant happened to score better would be exactly
 * the cherry-picking 3N warns against.
 */
export function smaCrossover(
  bars: DailyBar[],
  fast = 50,
  slow = 200,
  config: CostConfig = DEFAULT_COST_CONFIG
): BenchmarkResult {
  const cost = roundTripCostPct(config) / 100;
  const closes = bars.map((b) => b.close);
  let equity = 1;
  let inPosition = false;
  let exposedDays = 0;
  let trades = 0;
  const curve: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    // Signal from the PREVIOUS bar's close — acting on the same close you
    // used to generate the signal is a look-ahead a real trader can't have.
    const f = i > 0 ? sma(closes, fast, i - 1) : null;
    const s = i > 0 ? sma(closes, slow, i - 1) : null;
    const wantLong = f !== null && s !== null && f > s;

    if (wantLong && i > 0) {
      equity *= closes[i] / closes[i - 1];
      exposedDays++;
    }
    if (wantLong !== inPosition) {
      // Half a round trip per side change; a full round trip per completed trade.
      equity *= 1 - cost / 2;
      if (wantLong) trades++;
      inPosition = wantLong;
    }
    curve.push(equity);
  }

  return summarize(
    `SMA ${fast}/${slow} crossover`,
    `Long while the ${fast}-day average is above the ${slow}-day, flat otherwise. Signal taken from the prior close.`,
    curve,
    bars,
    exposedDays,
    trades
  );
}

/** Deterministic LCG — a benchmark that changes between runs isn't a benchmark. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return s / 4_294_967_296;
  };
}

/**
 * Random entries matched to the engine's own trade count, long/short mix
 * and median hold. This is the baseline that matters most: it isolates
 * whether the engine's SELECTION of moments carries information, or whether
 * its results are what any strategy trading that often, that direction, for
 * that long would have produced anyway.
 */
export function randomEntry(
  bars: DailyBar[],
  tradeCount: number,
  longSharePct: number,
  holdDays: number,
  seed = 20260809,
  config: CostConfig = DEFAULT_COST_CONFIG
): BenchmarkResult {
  const rng = makeRng(seed);
  const cost = roundTripCostPct(config) / 100;
  const usable = bars.length - holdDays - 1;
  if (usable <= 0 || tradeCount <= 0) {
    return { name: "Random entry", description: "Insufficient bars.", n: 0, totalReturnPct: 0, annualizedPct: null, maxDrawdownPct: null, exposurePct: 0, meanReturnPerTradePct: null };
  }

  const results: Array<{ t: number; retPct: number }> = [];
  for (let i = 0; i < tradeCount; i++) {
    const idx = Math.floor(rng() * usable);
    const isLong = rng() * 100 < longSharePct;
    const entry = bars[idx].close;
    const exit = bars[idx + holdDays].close;
    const raw = ((exit - entry) / entry) * 100;
    results.push({ t: bars[idx].t, retPct: (isLong ? raw : -raw) - cost * 100 });
  }

  results.sort((a, b) => a.t - b.t);

  /*
   * Constant size, additive — matching tradeStats.ts's convention exactly,
   * because these trades overlap for the same reason the engine's do. The
   * compounded version of this baseline reported -100%, which is volatility
   * drag on full-size overlapping bets rather than anything about random
   * entry, and would have made the engine look good against a strawman.
   */
  let cumulative = 0;
  let peak = 0;
  let worstDrawdown = 0;
  for (const r of results) {
    cumulative += r.retPct;
    peak = Math.max(peak, cumulative);
    worstDrawdown = Math.min(worstDrawdown, cumulative - peak);
  }

  const elapsedDays = (bars[bars.length - 1].t - bars[0].t) / MS_PER_DAY;
  return {
    name: "Random entry",
    description: `${tradeCount} randomly-timed entries matched to the engine's trade count, ${longSharePct.toFixed(0)}% long mix and ${holdDays}-day median hold. Constant size, additive — same convention as the engine's own figures.`,
    n: tradeCount,
    totalReturnPct: cumulative,
    annualizedPct: elapsedDays > 0 ? cumulative * (DAYS_PER_YEAR / elapsedDays) : null,
    maxDrawdownPct: worstDrawdown,
    exposurePct: (Math.min(tradeCount * holdDays, bars.length) / bars.length) * 100,
    meanReturnPerTradePct: cumulative / tradeCount,
  };
}
