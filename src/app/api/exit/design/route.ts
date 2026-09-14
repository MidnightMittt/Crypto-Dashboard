import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import equityExecutionJson from "@/data/equityExecutionStats.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { EquityExecutionSnapshot } from "@/lib/dossier/equityExpectations";
import { designOptionExit } from "@/lib/research/optionExitDesign";
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
  listFields,
  missingRiskPolicyFields,
  peakOfCurve,
  reachCurve,
} from "@/lib/research/exitDesign";

/** The risk-policy trio, in the order the refusal lists them. */
const BUDGET_FIELDS = ["account_value", "hard_floor_usd", "concurrent_positions"] as const;

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
  const budgetMissing = missingRiskPolicyFields({
    accountValue,
    hardFloorUsd: hardFloor,
    concurrentPositions: concurrent,
  });
  const budget =
    budgetMissing.length === 0 ? definedRiskBudget(accountValue, hardFloor, concurrent) : null;
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
                // Names only what is absent. Listing all three at a caller who
                // sent two points them at working code — the failure the
                // pretrade auditor produced on 2026-09-13.
                reason:
                  (budgetMissing.length > 0
                    ? `Supply ${listFields(budgetMissing)} to size the budget` +
                      (budgetMissing.length < 3
                        ? ` (${listFields(BUDGET_FIELDS.filter((f) => !budgetMissing.includes(f)))} received).`
                        : ".")
                    : `The declared policy cannot produce a budget: an account at or under its ` +
                      `own floor has no risk capacity to spend, and a position count below 1 ` +
                      `has nothing to divide it across.`) +
                  " The trio is the caller's risk policy; the site will not default " +
                  "any of them, because a defaulted floor or position count silently sizes " +
                  "the budget on a policy nobody declared.",
                missing_fields: budgetMissing,
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

  /*
   * THE OPTION HALF. Everything above is about the underlying; the return
   * this account actually banked was made selling CONTRACT rungs (CLSK:
   * three exits at premium multiples were the larger share of +241%), and
   * until now this endpoint had nothing to say about them. The shape
   * matches the pretrade auditor's option_order so the two endpoints speak
   * one dialect. Long single-leg only, same as the auditor.
   */
  let optionExit: ReturnType<typeof designOptionExit> | null = null;
  if (body.option_order !== undefined && body.option_order !== null) {
    const oo = body.option_order as Record<string, unknown>;
    const right = String(oo.right ?? "").toLowerCase();
    const strike = Number(oo.strike);
    const expiry = String(oo.expiry ?? "");
    const premium = Number(oo.premium);
    if (right !== "call" && right !== "put") {
      optionExit = { error: 'option_order.right must be "call" or "put".' };
    } else if (!Number.isFinite(strike) || !Number.isFinite(premium)) {
      optionExit = { error: "option_order needs numeric strike and premium (per-share: 0.86, not 86)." };
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      optionExit = { error: "option_order.expiry must be YYYY-MM-DD." };
    } else {
      const spot = bars.length > 0 ? bars[bars.length - 1].close : NaN;
      const multiples = Array.isArray(oo.multiples)
        ? (oo.multiples as unknown[]).map(Number).filter((m) => Number.isFinite(m) && m > 1)
        : undefined;
      optionExit = designOptionExit({
        right,
        strike,
        expiry,
        premium,
        // The request's own day: tenor is counted from now, not from the
        // panel's last close — a weekend request should not gain sessions.
        today: new Date().toISOString().slice(0, 10),
        spot,
        bars,
        multiples,
        stopPct,
        snapshot: equityExecutionJson as unknown as EquityExecutionSnapshot,
      });
    }
  }

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

    /*
     * Present only when the caller sent an option_order (the pretrade
     * auditor's shape: right/strike/expiry/premium, premium per-share).
     * Everything above stays about the underlying; this block is about the
     * contract — rungs at premium multiples with the measured probability
     * of the underlying making each one true, on the contract's own clock.
     */
    option_exit:
      optionExit ??
      {
        reason:
          "Supply `option_order` {right, strike, expiry, premium} for contract rungs — " +
          "underlying levels where each premium multiple is guaranteed by intrinsic value, " +
          "with the measured touch probability at the contract's own tenor beside each.",
      },
  });
}
