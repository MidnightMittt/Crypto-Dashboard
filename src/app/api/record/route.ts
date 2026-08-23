import { NextResponse } from "next/server";
import forwardVerdictJson from "@/data/forwardVerdictRecord.json";
import forwardReachJson from "@/data/forwardReachRecord.json";
import { ForwardVerdictRecord, MIN_INDEPENDENT_BLOCKS, MIN_VERDICT_N, VerdictCell } from "@/lib/research/forwardVerdict";

/**
 * GET /api/record — the forward track record, as data.
 *
 * On 2026-08-27 the first prediction cohort matures, and until this route
 * existed the most consequential number on the platform would have lived
 * only as rendered prose — the one output that could not be probed the way
 * every audit round has probed everything else (/api/asset, /api/distance,
 * /api/pretrade/check, /api/exit/design, /api/rules/ledger). A record that
 * cannot be audited by script is a record on the site's word.
 *
 * Serves both scored claims:
 *   verdict_record  did the page's directional word add anything
 *   reach_record    did price get to the levels the pages named
 *
 * ── Ranked by expectancy, never hit rate ──────────────────────────────
 *
 * Cells are ordered by edge vs baseline. The account's own ledger is the
 * argument: a +5% take-profit won 91% of the time and returned +2.03%,
 * while a 20-day hold won 55% and returned +9.99%. A hit-rate leaderboard
 * steers a reader into the worse strategy, so this route never offers one.
 *
 * ── Two baselines, both named ─────────────────────────────────────────
 *
 * `baseline_cohort_pct` is the mean forward return of every resolved call
 * in the same engine — edge is measured against it (did this call beat the
 * rest of the register). `baseline_market_pct` is mean SPY return over the
 * same windows (did the register's windows merely ride the index). Neither
 * is hidden inside the other.
 */

export const dynamic = "force-dynamic";

/*
 * Ranked by edge — expectancy, never hit rate. And a cell that cannot
 * support a claim sorts BELOW every one that can, regardless of how
 * flattering its point estimate is: the top row of a ranked list is read as
 * a recommendation, and a recommendation from one independent period is
 * noise with a rank attached.
 */
const rankByEdge = (cells: VerdictCell[]): VerdictCell[] =>
  [...cells].sort((a, b) => {
    if (a.publishable !== b.publishable) return a.publishable ? -1 : 1;
    return (b.edgeVsBaselinePct ?? -Infinity) - (a.edgeVsBaselinePct ?? -Infinity);
  });

export function GET() {
  const v = forwardVerdictJson as unknown as ForwardVerdictRecord;
  const r = forwardReachJson as unknown as {
    horizonSessions: number;
    generatedAt: number;
    totals: Record<string, unknown>;
    calibration: unknown[];
    predictions: unknown[];
  };

  const expired = v.predictions.filter((p) => p.expired).length;
  const byEngine = new Map<number, number>();
  for (const p of v.predictions) byEngine.set(p.engine ?? 1, (byEngine.get(p.engine ?? 1) ?? 0) + 1);

  return NextResponse.json({
    verdict_record: {
      engine: v.engine ?? 1,
      horizon_sessions: v.horizonSessions,
      generated_at: new Date(v.generatedAt).toISOString(),
      min_cell_n: MIN_VERDICT_N,
      totals: { ...v.totals, expired },
      predictions_by_engine: Object.fromEntries(byEngine),
      finding: v.finding ?? "This record predates the finding field; re-run the daily job to populate it.",
      cannot_yet_answer: v.cannotYetAnswer ?? [],
      baseline_cohort_pct: v.baselineReturnPct,
      baseline_market_pct: v.marketBaselineReturnPct ?? null,
      baseline_note:
        "Edge is measured against the COHORT baseline — the register's own resolved calls over " +
        "the same windows, a mixed bullish/bearish/neutral set, not an index. The market " +
        "baseline is mean SPY return over the same windows, shown so 'beat the register' and " +
        "'rode the index' stay distinguishable.",
      cells: rankByEdge(v.cells),
      legacy: v.legacy
        ? {
            engine: v.legacy.engine,
            note: v.legacy.note,
            totals: v.legacy.totals,
            baseline_cohort_pct: v.legacy.baselineReturnPct,
            baseline_market_pct: v.legacy.marketBaselineReturnPct ?? null,
            cells: rankByEdge(v.legacy.cells),
          }
        : null,
      independent_n_note:
        "independentN is the honest sample size and is usually far below n. Calls made on the same " +
        "day are cross-correlated (rho near 0.8 on this panel) and windows within the horizon " +
        "overlap, so a cell with n=48 across one date is ONE observation. A cell is publishable " +
        "only once it has " + MIN_INDEPENDENT_BLOCKS + " independent periods; below that its " +
        "numbers are shown with the claim refused.",
      ranking_note:
        "Cells ranked by edge vs cohort baseline (expectancy), never hit rate — on this " +
        "account's own ledger a 91% hit rate returned +2.03% while a 55% hit rate returned +9.99%.",
    },
    reach_record: {
      horizon_sessions: r.horizonSessions,
      generated_at: new Date(r.generatedAt).toISOString(),
      totals: r.totals,
      calibration: r.calibration,
    },
    notes: [
      "Cells publish only at n >= " + MIN_VERDICT_N + " resolved calls per verdict; a smaller group is counted in totals and never summarised.",
      "expired counts calls that can no longer resolve (symbol left the data set); they are neither open nor resolved.",
      "Engine versions never share a cell: engine 1 is the retired chart-only registration, engine 2 is the published engine.",
    ],
  });
}
