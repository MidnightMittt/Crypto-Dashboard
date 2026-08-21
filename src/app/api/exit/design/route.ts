import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { SURVIVAL_FLOOR_PCT, narrowestViable, stopGrid } from "@/lib/research/stopViability";
import {
  DEFAULT_TARGETS_PCT,
  compareToHold,
  ladderOutcome,
  peakOfCurve,
  reachCurve,
} from "@/lib/research/exitDesign";

/**
 * POST /api/exit/design — where the rungs and the stop belong, measured.
 *
 * Rungs were set at +25% and +42% only after measuring that a +10% rung fills
 * 75% of 20-session windows and a +15% fills 64% — those levels cap a runner
 * most of the time for a small gain. Without the measurement round numbers
 * win, and they are wrong in the expensive direction.
 *
 * Returns three things and refuses to collapse them into one recommendation:
 *
 *   reach_curve   how often each target fills, and where reach x size peaks
 *   stop          the narrowest width clearing the survival floor
 *   ladder        laddered vs held, MEAN AND MEDIAN reported separately
 *
 * The last is the point. On these names mean and median disagree, and the
 * disagreement is the finding rather than a presentational problem: one
 * runner drags the mean while the median says most trades were unremarkable.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;

/** Panel rows to Bars, interpolated fills excluded — the same rule everywhere else uses. */
function realBars(sessions: readonly string[], sp: SymbolPanel): Bar[] {
  const filled = new Set(sp.interpolated);
  const out: Bar[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const row = sp.bars[i];
    if (!row || filled.has(i)) continue;
    out.push({ t: Date.parse(sessions[i]), open: row[0], high: row[1], low: row[2], close: row[3], volume: row[4] });
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const holdSessions = Number(body.hold_sessions ?? 20);
  if (!symbol || !Number.isFinite(holdSessions) || holdSessions <= 0) {
    return NextResponse.json({ error: "symbol and a positive hold_sessions are required" }, { status: 400 });
  }

  const sp = panel.symbols[symbol];
  if (!sp) {
    return NextResponse.json(
      { error: `${symbol} is not in the universe this endpoint covers.` },
      { status: 404 }
    );
  }

  const bars = realBars(panel.sessions, sp);
  const targets = Array.isArray(body.targets_pct)
    ? (body.targets_pct as unknown[]).map(Number).filter((t) => Number.isFinite(t) && t > 0)
    : [...DEFAULT_TARGETS_PCT];

  const curve = reachCurve(bars, holdSessions, targets);
  const peak = peakOfCurve(curve);

  const grid = stopGrid(symbol, bars);
  const viable = grid ? narrowestViable(grid, holdSessions) : null;

  /*
   * The ladder the caller proposes, replayed against this name's own history,
   * and the same history held to the horizon with the same stop. Both or
   * neither: a ladder figure without its hold counterfactual answers "what
   * would this have made" when the question is "was laddering worth it".
   */
  const rungs = Array.isArray(body.rungs)
    ? (body.rungs as unknown[])
        .map((r) => {
          const a = r as { target_pct?: unknown; size?: unknown };
          return [Number(a.target_pct), Number(a.size)] as const;
        })
        .filter(([t, s]) => Number.isFinite(t) && t > 0 && Number.isFinite(s) && s > 0)
    : [];
  const stopPct = Number.isFinite(Number(body.stop_pct)) ? Number(body.stop_pct) : null;

  const ladder = rungs.length > 0 ? ladderOutcome(bars, holdSessions, rungs, stopPct) : null;
  const hold = rungs.length > 0 ? ladderOutcome(bars, holdSessions, [], stopPct) : null;

  return NextResponse.json({
    symbol,
    hold_sessions: holdSessions,
    sessions_measured: bars.length,
    price_session: panel.sessions[panel.sessions.length - 1] ?? null,

    reach_curve: curve,
    /*
     * The peak of reach x size, and a warning about reading it as advice: the
     * product ignores what happens when a target is MISSED, so it shows where
     * the curve turns over rather than where a rung belongs.
     */
    reach_peak: peak
      ? {
          ...peak,
          caveat:
            "reach x size ignores the cost of missing, so this marks where the curve turns over, " +
            "not where a rung belongs. Check how flat the curve is around it — when several levels " +
            "sit within a point of each other the choice between them is not supported by the data.",
        }
      : null,

    stop: viable
      ? {
          narrowest_viable_pct: viable.widthPct,
          survival_pct: viable.survivalPct,
          floor_pct: SURVIVAL_FLOOR_PCT,
          independent_n: viable.independentN,
        }
      : {
          narrowest_viable_pct: null,
          reason: grid
            ? `No width on the grid survives ${SURVIVAL_FLOOR_PCT}% of ${holdSessions}-session holds. ` +
              `That is a reason not to take the trade at this horizon, not a reason to widen indefinitely.`
            : `Too little history for a stop grid on ${symbol}.`,
        },

    ladder:
      ladder && hold
        ? {
            laddered: ladder,
            held: hold,
            // Mean AND median, separately, and no verdict when they disagree in sign.
            comparison: compareToHold(ladder, hold),
          }
        : { reason: "Supply `rungs` as [{target_pct,size}] to compare a ladder against holding." },
  });
}
