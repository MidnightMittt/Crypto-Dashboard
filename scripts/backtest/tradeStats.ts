/**
 * Trade-level performance statistics.
 *
 * metrics.ts measures SIGNALS ("after this verdict, which way did price
 * go"). This measures TRADES ("if you had taken the printed entry, stop and
 * target, what happened to the position"). They answer different questions
 * and can disagree: a signal can be directionally right most of the time
 * while the trades built on it lose money, because a stop sits closer than
 * a target.
 *
 * Everything here consumes already-resolved trades from execution.ts and
 * costs.ts. Nothing re-derives a level, a direction, or a fill.
 */

import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

export interface TradeRecord {
  /** Chronological key — drawdown and the equity curve walk these in order. */
  t: number;
  outcome: string;
  grossReturnPct: number;
  netReturnPct: number;
  mfePct: number;
  maePct: number;
  hoursToTarget: number | null;
  hoursToStop: number | null;
  hoursHeld: number;
  tp2ReachedBeforeStop: boolean;
  ambiguousBar: boolean;
}

export interface Distribution {
  p25: number;
  median: number;
  p75: number;
}

export interface TradeStats {
  n: number;
  /** Win/loss are decided on NET return — a gross win eaten by fees is not a win. */
  winRatePct: number;
  targetHitRatePct: number;
  stopHitRatePct: number;
  timeoutRatePct: number;
  tp2BeforeStopRatePct: number;
  /** Share of outcomes resting on execution.ts's intrabar stop-wins assumption. Reported so the assumption's blast radius is visible. */
  ambiguousRatePct: number;
  expectancyGrossPct: number;
  expectancyNetPct: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  medianNetPct: number;
  profitFactor: number | null;
  /** Worst peak-to-trough give-back in cumulative return POINTS at constant size — not an account balance. See maxDrawdown's own comment. */
  maxDrawdownPct: number | null;
  /**
   * Mean/stdev of PER-TRADE net returns. Deliberately not annualized:
   * these trades are irregularly spaced and overlapping, so scaling by
   * sqrt(252) would invent a precision the sampling doesn't support. Read
   * it as "return per unit of trade-to-trade variability," nothing more.
   */
  sharpePerTrade: number | null;
  sortinoPerTrade: number | null;
  /** Annualized compound return over real elapsed calendar time, divided by max drawdown. */
  calmar: number | null;
  mfe: Distribution | null;
  mae: Distribution | null;
  medianHoursToTarget: number | null;
  medianHoursToStop: number | null;
  medianHoursHeld: number;
}

const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 86_400_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { p25: percentile(sorted, 0.25), median: percentile(sorted, 0.5), p75: percentile(sorted, 0.75) };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n-1). Null below 2 points, where dispersion is undefined rather than zero. */
function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Largest peak-to-trough decline on a CONSTANT-SIZE cumulative return
 * curve, in percentage points.
 *
 * Deliberately additive rather than compounded, unlike metrics.ts's
 * signal-level maxDrawdown. These trades overlap heavily — 1,350 of them
 * across 1,448 days at a median 168h hold means roughly seven positions
 * open at once — so compounding them as if each were the whole account
 * describes a portfolio nobody could have held. Measured directly: the
 * compounded version reported -100% for both the engine AND a random-entry
 * baseline, which is volatility drag on full-size overlapping bets, not a
 * property of either strategy.
 *
 * Constant size sidesteps the question honestly. It assumes no position
 * sizing at all and reports the edge in raw percentage points, which is
 * what an expectancy figure already implies. Read it as "worst cumulative
 * give-back in return points," not as an account balance.
 */
function maxDrawdown(chronological: TradeRecord[]): number | null {
  if (chronological.length < 2) return null;
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const trade of chronological) {
    cumulative += trade.netReturnPct;
    peak = Math.max(peak, cumulative);
    worst = Math.min(worst, cumulative - peak);
  }
  return worst;
}

/**
 * Returns null below MIN_SAMPLE_N rather than a number nobody should act
 * on — the same gate every other statistic in this codebase applies. An
 * expectancy computed from four trades is not a small result, it is a
 * meaningless one.
 */
export function computeTradeStats(trades: TradeRecord[]): TradeStats | null {
  if (trades.length < MIN_SAMPLE_N) return null;

  const chronological = [...trades].sort((a, b) => a.t - b.t);
  const net = chronological.map((t) => t.netReturnPct);
  const wins = net.filter((r) => r > 0);
  const losses = net.filter((r) => r < 0);

  const grossWins = wins.reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b, 0));

  const rate = (count: number) => (count / trades.length) * 100;
  const sd = stdev(net);
  const downside = stdev(losses);

  const elapsedDays = (chronological[chronological.length - 1].t - chronological[0].t) / MS_PER_DAY;
  const dd = maxDrawdown(chronological);
  // Return points per year at constant size — the same additive basis as
  // the drawdown above, so their ratio (Calmar) divides like with like.
  const totalPoints = net.reduce((a, b) => a + b, 0);
  const annualizedPct = elapsedDays > 0 ? totalPoints * (DAYS_PER_YEAR / elapsedDays) : null;

  const toTarget = chronological.map((t) => t.hoursToTarget).filter((h): h is number => h !== null);
  const toStop = chronological.map((t) => t.hoursToStop).filter((h): h is number => h !== null);

  return {
    n: trades.length,
    winRatePct: rate(wins.length),
    targetHitRatePct: rate(chronological.filter((t) => t.outcome === "target").length),
    stopHitRatePct: rate(chronological.filter((t) => t.outcome === "stop").length),
    timeoutRatePct: rate(chronological.filter((t) => t.outcome === "timeout").length),
    tp2BeforeStopRatePct: rate(chronological.filter((t) => t.tp2ReachedBeforeStop).length),
    ambiguousRatePct: rate(chronological.filter((t) => t.ambiguousBar).length),
    expectancyGrossPct: mean(chronological.map((t) => t.grossReturnPct)),
    expectancyNetPct: mean(net),
    avgWinPct: wins.length ? mean(wins) : null,
    avgLossPct: losses.length ? mean(losses) : null,
    medianNetPct: distribution(net)!.median,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    maxDrawdownPct: dd,
    sharpePerTrade: sd && sd > 0 ? mean(net) / sd : null,
    sortinoPerTrade: downside && downside > 0 ? mean(net) / downside : null,
    calmar: annualizedPct !== null && dd !== null && dd < 0 ? annualizedPct / Math.abs(dd) : null,
    mfe: distribution(chronological.map((t) => t.mfePct)),
    mae: distribution(chronological.map((t) => t.maePct)),
    medianHoursToTarget: toTarget.length ? distribution(toTarget)!.median : null,
    medianHoursToStop: toStop.length ? distribution(toStop)!.median : null,
    medianHoursHeld: distribution(chronological.map((t) => t.hoursHeld))!.median,
  };
}
