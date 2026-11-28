import { NextResponse } from "next/server";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";
import { fetchOkxDailyCandles, fetchOkx4hCandles } from "@/lib/providers/okxCandles";
import { fetchDeepDailyCandles } from "@/lib/providers/okxDeepHistory";
import { scanAsset, rankOpportunities } from "@/lib/swing/scanner";
import { stepPaperPosition, unrealisedPnl, remainingRisk, openPaperPosition } from "@/lib/swing/paper";
import { describeTransition } from "@/lib/swing/lifecycle";
import { loadState, saveState, noteTransition, updatePosition, storeBackend, persistenceHealthy, addPosition } from "@/lib/swing/store";
import { computePerformance, performanceBreakdowns } from "@/lib/swing/journal";
import { SwingOpportunity } from "@/lib/swing/types";

export const dynamic = "force-dynamic";
/*
 * A cold scan fetches 7 years of daily history per asset — measured at 201s
 * for 6 assets with nothing cached. The platform default (~10s) would kill it
 * outright. 60 is the ceiling this repo's other heavy routes already use.
 *
 * This is a BACKSTOP, not the plan. With KV configured, swr's L2 is shared
 * across serverless instances so deep history is fetched once and every later
 * request reads it in ~50ms. Without KV every cold start re-fetches and will
 * exceed even 60s — see the warning in store.ts.
 */
export const maxDuration = 60;

/**
 * Assets the swing desk will not trade, whatever the setup looks like.
 *
 * His instruction, 2026-11-28: "We will not be trading bnb."
 *
 * Excluded HERE rather than by editing ALL_ASSETS, because that list is shared
 * with every other view in the app and an asset he will not SWING TRADE is not
 * the same as an asset he does not want to SEE. A scanner-level exclusion
 * keeps the market data intact and removes only the trade suggestion.
 */
const SWING_EXCLUDED = new Set(["BNB"]);

/**
 * GET /api/swing — the whole dashboard payload in one call.
 *
 * ── WHY ONE ENDPOINT ────────────────────────────────────────────────────
 *
 * Opportunities, positions, watchlist and performance are all derived from
 * ONE scan against ONE set of candles. Splitting them across routes would let
 * the views disagree — the opportunity list built from a 10:00 scan sitting
 * beside positions marked against a 10:05 price. One payload, one timestamp.
 *
 * ── THIS ROUTE MUTATES, DELIBERATELY ────────────────────────────────────
 *
 * It advances open positions against the newest closed bar and records
 * lifecycle transitions. That is the "monitoring" half of the workflow and it
 * has to happen somewhere; doing it on read means the dashboard is the thing
 * that keeps the ledger current, with no background job required.
 *
 * Every mutation is idempotent (see store.ts): stepping the same bar twice
 * cannot double-book a partial exit, and a repeated ENTRY_CONFIRMED cannot
 * mint two positions.
 *
 * NOTHING HERE PLACES A REAL ORDER. There is no brokerage import in this file
 * or anywhere under lib/swing/.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("assets") ?? 4), ALL_ASSETS.length);
  const assets = ALL_ASSETS.filter((a) => !SWING_EXCLUDED.has(a)).slice(0, limit) as AssetSymbol[];

  let state = await loadState();
  const opportunities: SwingOpportunity[] = [];
  const marks: Record<string, number> = {};
  const failures: string[] = [];

  for (const asset of assets) {
    try {
      const [daily, fourH, deep] = await Promise.all([
        fetchOkxDailyCandles(asset),
        fetchOkx4hCandles(asset).catch(() => []),
        fetchDeepDailyCandles(asset).catch(() => []),
      ]);
      if (!daily.length) { failures.push(asset); continue; }
      marks[asset] = daily[daily.length - 1].close;

      // Advance open positions on this asset against the newest CLOSED bar.
      const bar = daily[daily.length - 1];
      for (const p of state.positions) {
        if (p.asset !== asset) continue;
        if (p.state !== "ACTIVE" && p.state !== "PARTIALLY_EXITED") continue;
        const r = stepPaperPosition({ position: p, bar, config: state.config });
        if (r.fills.length) {
          state = updatePosition(state, r.position);
          for (const e of r.events) {
            const res = noteTransition(state, `${p.id}:${e}`, r.position.state, `${asset}: ${e}`);
            state = res.state;
          }
        }
      }

      const found = scanAsset({
        asset, daily, fourH, deepDaily: deep, config: state.config,
        riskState: {
          openPositions: state.positions,
          realisedToday: 0,
          realisedThisWeek: 0,
        },
      });
      for (const o of found) {
        const prev = state.lastStates[o.id] ?? null;
        const msg = describeTransition(prev, o.state, o.asset, o.direction);
        state = noteTransition(state, o.id, o.state, msg).state;

        /*
         * AUTOMATIC PAPER MODE — off unless explicitly enabled.
         *
         * Every gate the manual path applies is applied here: confirmed state,
         * no risk refusal, no opposing-direction conflict, and addPosition's
         * own duplicate guard. The only difference is that no human pressed
         * the button. PAPER ONLY — openPaperPosition touches no brokerage.
         */
        if (
          state.config.autoPaper &&
          o.state === "ENTRY_CONFIRMED" &&
          !o.riskRefusal &&
          !o.conflictsWith &&
          o.sizing
        ) {
          const pos = openPaperPosition({ opportunity: o, bar, config: state.config });
          if (pos) {
            const res = addPosition(state, pos);
            if (res.added) {
              state = res.state;
              state = noteTransition(
                state, `${o.id}:auto`, "ACTIVE",
                `${o.asset}: AUTO-PAPER opened ${o.direction} at ${pos.entryPrice.toFixed(2)}.`
              ).state;
            }
          }
        }
      }
      opportunities.push(...found);
    } catch (err) {
      console.warn(`[api/swing] ${asset} failed:`, err);
      failures.push(asset);
    }
  }

  await saveState(state);

  const ranked = rankOpportunities(opportunities);
  const live = state.positions.filter((p) => p.state === "ACTIVE" || p.state === "PARTIALLY_EXITED");

  return NextResponse.json({
    generatedAt: Date.now(),
    backend: storeBackend(),
    // False means positions will NOT survive — surfaced, never silent.
    persistenceHealthy: persistenceHealthy(),
    assetsScanned: assets.length,
    failures,
    config: state.config,
    opportunities: ranked,
    watchlist: state.watchlist,
    notifications: state.notifications.slice(0, 40),
    positions: state.positions.map((p) => ({
      ...p,
      markPrice: marks[p.asset] ?? null,
      unrealised: marks[p.asset] != null ? unrealisedPnl(p, marks[p.asset]) : null,
      remainingRisk: remainingRisk(p),
    })),
    openCount: live.length,
    // Evidence classes kept separate by construction — see journal.ts.
    performance: {
      paper: computePerformance(state.positions, "paper"),
      breakdowns: performanceBreakdowns(state.positions),
    },
    /** Equities are deliberately absent. See the Phase 4 report. */
    equitiesAvailable: false,
  });
}
