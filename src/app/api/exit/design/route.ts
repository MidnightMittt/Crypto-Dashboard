import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import {
  DEFAULT_WIDTHS_PCT,
  stopGrid,
  stopVerdictAt,
} from "@/lib/research/stopViability";
import {
  DEFAULT_TARGETS_PCT,
  compareToHold,
  definedRiskBudget,
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

  /*
   * Built AT the requested horizon. The default grid measures 1/5/10/21
   * sessions, so a 20-session hold matched no cell and narrowestViable
   * returned null — which this route rendered as "no stop survives", the
   * opposite of the truth and a refusal to trade on an artefact.
   */
  const grid = stopGrid(symbol, bars, DEFAULT_WIDTHS_PCT, [holdSessions]);
  const stop = stopVerdictAt(grid, holdSessions);

  /*
   * When no stop survives, the refusal is a ROUTING decision, not a dead
   * end. Measured across the 24-name watchlist: every name above ~1.6% ATR
   * refuses at every horizon — the only four with a viable stop are the
   * barometer ETFs the watchlist itself marks "context only". A framework
   * whose sole risk control is unavailable on 100% of its tradeable names
   * is not advising "don't trade"; it is discovering that the downside must
   * be bounded by CONSTRUCTION (premium paid up front, which cannot be
   * gapped through) rather than by an exit level (which can).
   *
   * The budget arithmetic runs only on the caller's own risk policy —
   * account value, hard floor, position count. The site holds none of them
   * and invents none of them: absent any one, the budget is null with the
   * reason, never a defaulted number.
   */
  const accountValue = Number(body.account_value);
  const hardFloor = Number(body.hard_floor_usd);
  const concurrent = Number(body.concurrent_positions);
  const budget =
    Number.isFinite(accountValue) && Number.isFinite(hardFloor) && Number.isFinite(concurrent)
      ? definedRiskBudget(accountValue, hardFloor, concurrent)
      : null;
  const definedRisk =
    stop.verdict !== "no_width_survives"
      ? null
      : {
          rationale:
            `No exit-based control survives at this volatility (${stop.note}) The position's ` +
            `downside must be bounded by construction: a defined-risk structure's maximum loss ` +
            `is the premium paid, and a premium cannot be gapped through — which is the ` +
            `protection the ${stop.floor_pct}% survival floor was trying and failing to buy ` +
            `with an exit level.`,
          max_loss_budget_usd: budget ? budget.perPositionUsd : null,
          budget: budget
            ? {
                risk_capacity_usd: budget.riskCapacityUsd,
                per_position_usd: budget.perPositionUsd,
                inputs: {
                  account_value: accountValue,
                  hard_floor_usd: hardFloor,
                  concurrent_positions: concurrent,
                },
              }
            : {
                reason:
                  "Supply account_value, hard_floor_usd and concurrent_positions to size the " +
                  "budget. All three are the caller's risk policy; the site will not default " +
                  "any of them, because a defaulted floor or position count silently sizes " +
                  "the budget on a policy nobody declared.",
              },
          reward_side:
            "reach_curve above, unchanged — it measures the underlying's forward reach, which " +
            "is what a premium-defined structure monetises.",
          caveats: [
            "The account's own ledger (56 stopless equity trips at -2.39 vs 3 premium-capped " +
              "option trips at +143.00, per the trading session) is consistent in shape with " +
              "this routing — but two of the three option trips are the same underlying on " +
              "the same thesis. That is n=1-repeated, not n=3, and it is NOT evidence that " +
              "options beat equities here.",
            "independent_n is 14 on every reach figure at this horizon. The stop-available " +
              "vs stop-refused split is far outside that power limit; orderings WITHIN the " +
              "refused group are not, and should not be read as rankings.",
          ],
        };

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

    /*
     * `narrowest_viable_pct` is kept as an alias of `width_pct` so existing
     * callers keep working; the verdict and the widest-tested figures are
     * the §3a carry-the-meaning-through fields — a refusal now says HOW
     * CLOSE the name came, not just that it failed.
     */
    stop: { narrowest_viable_pct: stop.width_pct, ...stop },

    /*
     * Present exactly when no width survives: the refusal rerouted, not
     * softened. Null otherwise — a name with a viable stop does not need
     * its downside bounded by construction.
     */
    defined_risk: definedRisk,

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
