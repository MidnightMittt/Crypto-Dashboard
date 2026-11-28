import { PaperPosition } from "./types";

/**
 * TRADE JOURNAL AND PERFORMANCE.
 *
 * ── EVIDENCE CLASSES ARE NEVER COMBINED ─────────────────────────────────
 *
 * Historical research, a backtest replay, paper trading and live trading are
 * four different kinds of claim with four different error modes. A single
 * "performance" figure that blends them is not a summary, it is a laundering
 * operation: a backtest's survivorship and a paper run's perfect discipline
 * both disappear into one number that looks like a track record.
 *
 * So every figure this module returns carries its `source`, and nothing here
 * will aggregate across sources. The UI shows them side by side or not at all.
 *
 * ── SMALL SAMPLES ARE LABELLED, NOT HIDDEN ──────────────────────────────
 *
 * `sufficient` is false below 30 closed trades. That is not a significance
 * test — it is a reminder that a 60% win rate on 5 trades is a coin that came
 * up heads three times. This project has already published one false 65.7%
 * result from an undercounted sample; the label exists so the next one is
 * harder to produce.
 */

export type EvidenceSource = "research" | "backtest" | "paper" | "live";

export interface PerformanceStats {
  source: EvidenceSource;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnl: number;
  avgWinner: number | null;
  avgLoser: number | null;
  /** Mean R multiple across closed trades. */
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  totalFees: number;
  /** False below MIN_SAMPLE. Not a significance test — a caution label. */
  sufficient: boolean;
  /** Breakeven win rate implied by the realised payoff ratio. */
  breakevenWinRatePct: number | null;
}

export const MIN_SAMPLE = 30;

function rOf(p: PaperPosition): number | null {
  const risk = Math.abs(p.entryPrice - p.stopPrice) * p.quantity;
  if (!(risk > 0)) return null;
  return p.realisedPnl / risk;
}

/**
 * Peak-to-trough of the cumulative realised curve, in currency.
 *
 * Ordered by CLOSE time, not open time: drawdown is about when money actually
 * left the account. Ordering by entry would let a trade opened early and
 * closed late mask a dip that really happened.
 */
function maxDrawdown(closed: PaperPosition[]): number {
  const ordered = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let peak = 0, equity = 0, worst = 0;
  for (const p of ordered) {
    equity += p.realisedPnl;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return Math.abs(worst);
}

export function computePerformance(positions: PaperPosition[], source: EvidenceSource): PerformanceStats {
  const closed = positions.filter((p) => p.state === "COMPLETED");
  const wins = closed.filter((p) => p.realisedPnl > 0);
  const losses = closed.filter((p) => p.realisedPnl <= 0);
  const netPnl = closed.reduce((s, p) => s + p.realisedPnl, 0);
  const grossWin = wins.reduce((s, p) => s + p.realisedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.realisedPnl, 0));
  const rs = closed.map(rOf).filter((r): r is number => r !== null);
  const avgWinner = wins.length ? grossWin / wins.length : null;
  const avgLoser = losses.length ? -grossLoss / losses.length : null;

  // Breakeven win rate from the realised payoff ratio: p* = 1 / (1 + W/L).
  let breakeven: number | null = null;
  if (avgWinner !== null && avgLoser !== null && avgLoser !== 0) {
    const payoff = Math.abs(avgWinner / avgLoser);
    breakeven = (1 / (1 + payoff)) * 100;
  }

  return {
    source,
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    netPnl,
    avgWinner,
    avgLoser,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdown: maxDrawdown(closed),
    totalFees: positions.reduce((s, p) => s + p.fills.reduce((f, x) => f + x.fee, 0), 0),
    sufficient: closed.length >= MIN_SAMPLE,
    breakevenWinRatePct: breakeven,
  };
}

export interface Breakdown {
  label: string;
  trades: number;
  winRatePct: number | null;
  netPnl: number;
  avgR: number | null;
  sufficient: boolean;
}

function summarise(label: string, group: PaperPosition[]): Breakdown {
  const closed = group.filter((p) => p.state === "COMPLETED");
  const wins = closed.filter((p) => p.realisedPnl > 0).length;
  const rs = closed.map(rOf).filter((r): r is number => r !== null);
  return {
    label,
    trades: closed.length,
    winRatePct: closed.length ? (wins / closed.length) * 100 : null,
    netPnl: closed.reduce((s, p) => s + p.realisedPnl, 0),
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    sufficient: closed.length >= MIN_SAMPLE,
  };
}

function groupBy(positions: PaperPosition[], key: (p: PaperPosition) => string): Breakdown[] {
  const m = new Map<string, PaperPosition[]>();
  for (const p of positions) {
    const k = key(p);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(p);
  }
  return [...m.entries()].map(([k, g]) => summarise(k, g)).sort((a, b) => b.trades - a.trades);
}

/**
 * The breakdowns the diagnostic needs.
 *
 * Each is a filter over the SAME recorded trades — no new data, no new
 * research program. The thesis snapshot frozen at entry is what makes this
 * possible: these questions can only be asked because every trade carries the
 * conditions that existed when it was opened, rather than conditions
 * recomputed later to match the outcome.
 */
export function performanceBreakdowns(positions: PaperPosition[]) {
  return {
    byAsset: groupBy(positions, (p) => p.asset),
    bySide: groupBy(positions, (p) => p.direction),
    byHtfAlignment: groupBy(positions, (p) => (p.thesis.htfAligned ? "higher-TF aligned" : "not aligned")),
    byConfluence: groupBy(positions, (p) =>
      p.thesis.familyCount >= 4 ? "4+ families" : p.thesis.familyCount === 3 ? "3 families" : "1-2 families"
    ),
    byTrend: groupBy(positions, (p) => `trend ${p.thesis.trendDirection}`),
    byExit: groupBy(positions, (p) => {
      const last = p.fills[p.fills.length - 1];
      return last ? `exit: ${last.reason}` : "open";
    }),
  };
}
