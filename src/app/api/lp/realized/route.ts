import { NextResponse } from "next/server";
import realizedJson from "@/data/lpRealizedRecord.json";

/**
 * GET /api/lp/realized — the LP position's complete realized record.
 *
 * Served from the committed artefact rather than swept per request: the sweep
 * is ~150 log queries and takes minutes, and the record it produces only
 * changes when the position does. Regenerate with
 * scripts/research/reconstructLpHistory.ts.
 *
 * This is the surface that answers "what did the position actually earn",
 * which /api/lp (live card + 6h series) structurally cannot for any period
 * before its cron started. Realized receipts from logs, not accruals from
 * state — and because logs are not pruned, this record is complete regardless
 * of whether anything was watching at the time.
 *
 * The record is a MEASUREMENT, not a recommendation. It reports what the
 * position did; no part of it says whether to open another.
 */

export const dynamic = "force-static";

export async function GET(): Promise<NextResponse> {
  const a = realizedJson as unknown as {
    generatedAt: number;
    record: {
      isClosed: boolean;
      closedIso: string | null;
      lifeDays: number;
      lifeCoverage: number | null;
      vsHodlPct: number | null;
    };
  };
  return NextResponse.json({
    ...a,
    headline: a.record.isClosed
      ? `Position CLOSED ${a.record.closedIso} after ${a.record.lifeDays.toFixed(1)} days. ` +
        `LVR coverage ${a.record.lifeCoverage?.toFixed(2) ?? "n/a"}x; LP vs holding the tokens ` +
        `${a.record.vsHodlPct === null ? "n/a" : (a.record.vsHodlPct >= 0 ? "+" : "") + a.record.vsHodlPct.toFixed(2) + "%"}.`
      : `Position OPEN after ${a.record.lifeDays.toFixed(1)} days.`,
    notes: [
      "Fees are REALIZED Collect receipts, not accruals — a Collect paired with a same-block Decrease has its principal subtracted.",
      "Yields and LVR coverage are ratios in PONS terms, so no historical USD price is assumed anywhere.",
      "vsHodl sums deposits without time-weighting (later top-ups entered at different prices); it is an approximation and labelled as one.",
      "Regenerate with scripts/research/reconstructLpHistory.ts — the sweep is reproducible from chain at any time.",
    ],
  });
}
