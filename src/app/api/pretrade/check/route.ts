import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import earningsJson from "@/data/earningsCalendar.json";
import spreadHistoryJson from "@/data/spreadHistory.json";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { BENCHMARK_SYMBOL } from "@/lib/research/benchmark";
import { DatedReturn, regressOnMarket } from "@/lib/research/alphaBeta";
import { Bar } from "@/lib/research/types";
import { survivalAt } from "@/lib/research/stopViability";
import { latestCompletedSession, sessionsBetween } from "@/lib/asset/priceStaleness";
import { HeldPosition, LivePrice, PretradeInputs, runPretradeChecks } from "@/lib/pretrade/check";

/**
 * POST /api/pretrade/check — every reason not to place this trade, at once.
 *
 * Sizing two orders by hand took roughly twenty minutes of Python. The
 * arithmetic was never the hard part; remembering all seven questions under
 * time pressure was. This runs them together, from committed artifacts only,
 * so it answers in milliseconds and cannot be slower than the decision.
 *
 * The engine is pure and lives in src/lib/pretrade/check.ts. This file does
 * one job: turn a symbol into the measurements that engine needs, and say
 * plainly when a measurement does not exist. Every "unknown" below is a real
 * absence rather than a failure to look.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const calendar = earningsJson as EarningsCalendar;
const spreads = (spreadHistoryJson as { observations: SpreadObservation[] }).observations;

interface SpreadObservation {
  session: string;
  symbol: string;
  window: string;
  spreadBp: number;
}

/** Panel rows to Bars, fills excluded — the same rule the asset facts use. */
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

/** Daily returns keyed by session, in BASIS POINTS — the unit DatedReturn declares. */
function returns(sessions: readonly string[], sp: SymbolPanel): DatedReturn[] {
  const out: DatedReturn[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const a = sp.bars[i - 1];
    const b = sp.bars[i];
    if (!a || !b || a[3] <= 0) continue;
    out.push({ date: sessions[i], netBp: (b[3] / a[3] - 1) * 10_000 });
  }
  return out;
}

/**
 * Beta against the declared benchmark.
 *
 * Null rather than 1.0 when it cannot be fitted. The engine treats a null
 * beta as UNKNOWN and says so, because assuming 1.0 for a name that actually
 * runs 4.57 understates its market-equivalent size by more than four times —
 * which is the specific error that put a book at 204% of the account while
 * notional read 45%.
 */
function betaOf(symbol: string): number | null {
  const sp = panel.symbols[symbol];
  const bench = panel.symbols[BENCHMARK_SYMBOL];
  if (!sp || !bench) return null;
  const r = regressOnMarket(returns(panel.sessions, sp), returns(panel.sessions, bench));
  return r && Number.isFinite(r.beta) ? Number(r.beta.toFixed(3)) : null;
}

/**
 * Measured round-trip cost: the entry window's spread plus the exit window's.
 *
 * Both legs, because cost lives at the EXIT as much as the entry and a
 * one-sided figure understates it by roughly half. Null unless BOTH windows
 * have observations for this symbol — a round trip priced from one leg is a
 * modelled number wearing a measured one's clothes.
 */
function measuredRoundTripBp(symbol: string): number | null {
  const forWindow = (w: string) => {
    const xs = spreads.filter((o) => o.symbol === symbol && o.window === w).map((o) => o.spreadBp);
    return xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  };
  const entry = forWindow("entry");
  const exit = forWindow("exit");
  if (entry === null || exit === null) return null;
  return Number((entry + exit).toFixed(2));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const shares = Number(body.shares);
  const entry = Number(body.entry);
  const stop = Number(body.stop);
  const holdSessions = Number(body.hold_sessions ?? 20);
  const accountValue = Number(body.account_value);

  if (!symbol || !Number.isFinite(shares) || !Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(accountValue)) {
    return NextResponse.json(
      { error: "symbol, shares, entry, stop and account_value are required and must be numeric" },
      { status: 400 }
    );
  }

  /*
   * live_price is all-or-nothing. A supplied price without an as_of cannot
   * be dated; without a source it cannot be argued with. Accepting a partial
   * one and quietly falling back would be the exact failure this endpoint
   * already had once: a field accepted and silently unused. So a malformed
   * live_price is a 400 naming the defect, never a shrug.
   */
  let livePrice: LivePrice | null = null;
  if (body.live_price !== undefined && body.live_price !== null) {
    const lp = body.live_price as Record<string, unknown>;
    const value = Number(lp.value);
    const asOfMs = typeof lp.as_of === "string" ? Date.parse(lp.as_of) : NaN;
    const source = typeof lp.source === "string" ? lp.source.trim() : "";
    const defects: string[] = [];
    if (!(Number.isFinite(value) && value > 0)) defects.push("value must be a positive number");
    if (!Number.isFinite(asOfMs)) defects.push("as_of must be an ISO timestamp");
    if (!source) defects.push("source must name where the price came from (e.g. broker_bid)");
    if (defects.length > 0) {
      return NextResponse.json(
        {
          error: `live_price is incomplete: ${defects.join("; ")}.`,
          hint: 'Send all three or none: {"live_price":{"value":15.75,"as_of":"2026-08-21T19:59:59Z","source":"broker_bid"}}',
        },
        { status: 400 }
      );
    }
    livePrice = { value, asOfMs, source };
  }

  const sp = panel.symbols[symbol];
  if (!sp) {
    return NextResponse.json(
      {
        error: `${symbol} is not in the positioning universe this endpoint covers.`,
        hint: "Declared in src/lib/markets/scannerUniverse.ts (positioningUniverse).",
      },
      { status: 404 }
    );
  }

  const existingPositions: HeldPosition[] = Array.isArray(body.existing_positions)
    ? (body.existing_positions as Record<string, unknown>[]).map((p) => {
        const sym = String(p.symbol ?? "").toUpperCase();
        return {
          symbol: sym,
          shares: Number(p.shares) || 0,
          price: Number(p.price) || 0,
          // Beta is MEASURED here rather than trusted from the caller, so the
          // book's exposure is computed the same way for every position.
          beta: betaOf(sym),
        };
      })
    : [];

  // Stop survival at exactly this width and horizon, not a nearby grid cell.
  const widthPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;
  const bars = realBars(panel.sessions, sp);
  const cell = widthPct > 0 ? survivalAt(bars, widthPct, holdSessions) : null;

  /*
   * The EDGE is the caller's claim, never the site's invention. A cost check
   * needs something to charge cost against, and only the trader knows what
   * edge they believe they are taking. Absent it, the check reports unknown
   * rather than inventing a number that would make the verdict look measured.
   */
  const edgeBp = Number(body.edge_bp);
  const roundTripBp = measuredRoundTripBp(symbol);
  const cost =
    Number.isFinite(edgeBp) && roundTripBp !== null ? { roundTripBp, edgeBp } : null;

  const today = latestCompletedSession(new Date());
  const lastSession = panel.sessions[panel.sessions.length - 1] ?? today;

  const inputs: PretradeInputs = {
    symbol,
    shares,
    entry,
    stop,
    holdSessions,
    accountValue,
    existingPositions,
    beta: betaOf(symbol),
    /*
     * independentN, not n. The windows overlap, so the raw count would
     * overstate the evidence behind a survival figure by roughly the horizon.
     */
    stopSurvival: cell ? { survival: cell.survivalPct / 100, independentN: cell.independentN } : null,
    earnings: earningsFor(symbol, today),
    cost,
    priceAgeSessions: sessionsBetween(lastSession, today),
    today,
    livePrice,
    nowMs: Date.now(),
  };

  return NextResponse.json({
    ...runPretradeChecks(inputs),
    inputs_used: {
      beta_benchmark: BENCHMARK_SYMBOL,
      stop_width_pct: Number(widthPct.toFixed(2)),
      price_session: lastSession,
      edge_bp: Number.isFinite(edgeBp) ? edgeBp : null,
      live_price: livePrice
        ? { value: livePrice.value, as_of: new Date(livePrice.asOfMs).toISOString(), source: livePrice.source }
        : null,
    },
  });
}

function earningsFor(symbol: string, today: string): PretradeInputs["earnings"] {
  const entry = calendar.entries.find((e) => e.symbol === symbol && e.date >= today);
  if (entry) return { date: entry.date, status: "confirmed" };
  const sweep = calendar.sweep;
  const swept = sweep !== undefined && sweep.throughDate >= today && sweep.universe.includes(symbol);
  return swept ? { date: null, status: "none" } : { date: null, status: "lookup_failed" };
}
