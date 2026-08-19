import { LabSeries, PeriodLeg, indexAsOf } from "./signalLab";
import { Decomposition, LegPeriod, decompose } from "./decomposition";

/**
 * THE BENCHMARK LEG — turning a hypothesis's periods into three columns.
 *
 * `runHypothesis` ranks a panel and knows nothing about indices, which is
 * correct: ranking names against each other and comparing a result to a
 * benchmark are different jobs, and merging them would make the panel
 * function depend on whichever ETF happened to be in the ingest.
 *
 * This joins them. It reads the benchmark at the SAME entry and exit instants
 * the hypothesis traded — not a recomputed calendar — and hands all three
 * legs to `decompose`.
 */

/**
 * QQQ, declared in advance.
 *
 * The panel skews to semiconductors, miners and homebuilders, and QQQ is the
 * closer of the two obvious candidates to that mix. Fixing one benchmark
 * before looking means nothing published is the flattering pick of several.
 *
 * The honest caveat: this is a comparison to an index the panel is NOT drawn
 * from. Ranking within the benchmark's own constituents would eliminate "you
 * picked a lucky universe" by construction, and would be a stronger test than
 * this one. It is not what this does.
 */
export const BENCHMARK_SYMBOL = "QQQ";

/**
 * The decomposition only applies to a long leg.
 *
 * A dollar-neutral long-short spread does not compete with an index — it has
 * roughly no market exposure by construction, so "spread minus QQQ" is not a
 * question a trader asks and publishing it would be a number in search of a
 * meaning. Long legs are held; spreads are not bought.
 */
export type DecomposableLeg = "long-vs-panel";

export interface BenchmarkedDecomposition {
  benchmark: string;
  decomposition: Decomposition;
}

/**
 * Benchmark return over one period, or null when the series cannot cover it.
 *
 * Requires the benchmark bar to sit at or before each instant AND for exit to
 * strictly follow entry, the same ordering `runHypothesis` asserts per name.
 * A benchmark that does not span the period is a missing observation, never a
 * flat one — a zero here would silently credit the signal with the index's
 * absence.
 */
function periodReturn(bench: LabSeries, entryTime: number, exitTime: number): number | null {
  const i = indexAsOf(bench.t, entryTime);
  const j = indexAsOf(bench.t, exitTime);
  if (i < 0 || j <= i) return null;
  const a = bench.close[i];
  const b = bench.close[j];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

/**
 * Decompose a hypothesis's long leg against its universe and the benchmark.
 *
 * Returns null when the benchmark cannot cover enough of the hypothesis's own
 * periods, rather than quietly reporting three columns over a shorter window
 * than the headline figure beside them.
 */
export function benchmarkDecomposition(
  periods: readonly PeriodLeg[],
  bench: LabSeries,
  benchmarkSymbol: string = BENCHMARK_SYMBOL
): BenchmarkedDecomposition | null {
  const signal: LegPeriod[] = [];
  const universe: LegPeriod[] = [];
  const index: LegPeriod[] = [];

  for (const p of periods) {
    // The date label is the ENTRY instant, so all three legs key identically
    // and `decompose`'s inner join lines up period-for-period.
    const date = new Date(p.entryTime).toISOString().slice(0, 10);
    signal.push({ date, ret: p.top });
    universe.push({ date, ret: p.universe });
    const b = periodReturn(bench, p.entryTime, p.exitTime);
    if (b !== null) index.push({ date, ret: b });
  }

  const d = decompose(signal, universe, index);
  return d === null ? null : { benchmark: benchmarkSymbol, decomposition: d };
}
