import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { survivalAt } from "@/lib/research/stopViability";
import { excursionStats, reachAt } from "@/lib/research/exitDesign";

/**
 * GET /api/screen/reach — the universe ranked by how far each name actually
 * travels over a defined-risk tenor.
 *
 * The screen for how this account has to trade: 24 of 24 names it holds
 * refuse a stop, it cannot short, and buying power is ~$137 — so a bought
 * option is the only structure that fits, and the one question that decides
 * whether ANY option on a name can pay for its premium is how far the
 * underlying travels within the tenor. That is measured from the
 * underlying's own bars; the options-chain gap this site has stays a gap
 * and nothing here pretends otherwise.
 *
 *   /api/screen/reach?horizon=21&move=10
 *
 * Per name: the probability its HIGHS reach +move% within the horizon (what
 * a call needs) and its LOWS touch -move% (what a put needs) — separate
 * columns, because they are different bets — plus the name's own median
 * excursion in both directions, and n / independent_n on every row.
 *
 * ── A screen, not a recommendation ────────────────────────────────────
 *
 * No verdict, no composite, no hit-rate leaderboard. Rows sort by the
 * larger of the two measured probabilities and the reader decides; the
 * honest limit — most rows rest on ~14 independent windows — is printed on
 * the row, not disclosed in a footnote.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;

const MIN_HORIZON = 5;
const MAX_HORIZON = 60;
const MIN_MOVE_PCT = 1;
const MAX_MOVE_PCT = 100;

/** Panel rows to Bars, interpolated fills excluded — the rule everywhere else uses. */
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

export function GET(req: NextRequest) {
  const horizon = Number(req.nextUrl.searchParams.get("horizon") ?? 21);
  const movePct = Number(req.nextUrl.searchParams.get("move") ?? 10);

  if (!Number.isInteger(horizon) || horizon < MIN_HORIZON || horizon > MAX_HORIZON) {
    return NextResponse.json(
      { error: `horizon must be an integer between ${MIN_HORIZON} and ${MAX_HORIZON} sessions, got ${req.nextUrl.searchParams.get("horizon")}.` },
      { status: 400 }
    );
  }
  if (!Number.isFinite(movePct) || movePct < MIN_MOVE_PCT || movePct > MAX_MOVE_PCT) {
    return NextResponse.json(
      { error: `move must be a percent between ${MIN_MOVE_PCT} and ${MAX_MOVE_PCT}, got ${req.nextUrl.searchParams.get("move")}.` },
      { status: 400 }
    );
  }

  const rows = [];
  const unmeasurable: { symbol: string; reason: string }[] = [];

  for (const symbol of Object.keys(panel.symbols).sort()) {
    const bars = realBars(panel.sessions, panel.symbols[symbol]);
    const up = reachAt(bars, movePct, horizon);
    const down = survivalAt(bars, movePct, horizon);
    const exc = excursionStats(bars, horizon);

    if (!up && !down) {
      unmeasurable.push({ symbol, reason: `too little history at a ${horizon}-session horizon` });
      continue;
    }

    rows.push({
      symbol,
      /** P(highs reach +move% within horizon) — what a bought CALL needs. */
      up_reach: up
        ? { pct: Math.round(up.reachPct * 10) / 10, n: up.n, independent_n: up.independentN }
        : null,
      /** P(lows touch -move% within horizon) — what a bought PUT needs. */
      down_touch: down
        ? { pct: Math.round((100 - down.survivalPct) * 10) / 10, n: down.n, independent_n: down.independentN }
        : null,
      /** The name's own median forward excursion, both directions — no threshold needed. */
      excursion_median: exc
        ? { up_pct: exc.upMedianPct, down_pct: exc.downMedianPct, n: exc.n, independent_n: exc.independentN }
        : null,
    });
  }

  rows.sort((a, b) => {
    const best = (r: typeof a) => Math.max(r.up_reach?.pct ?? 0, r.down_touch?.pct ?? 0);
    return best(b) - best(a);
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    horizon_sessions: horizon,
    move_pct: movePct,
    bars_session: panel.sessions[panel.sessions.length - 1] ?? null,
    sort: "by the larger of up_reach and down_touch — a movement ranking, not a recommendation",
    notes: [
      "Measured on the UNDERLYING's own daily bars; no options chain is involved, and premium/IV are not modelled here — this screens which names move enough that a defined-risk structure could pay, not which contract to buy.",
      "up_reach uses highs (a call's question); down_touch uses lows (a put's question). They are different bets and are never combined into one score.",
      "Windows overlap: independent_n is the honest sample size, printed on every row. Where it reads ~14, that is the difference between a measurement and a decoration — treat orderings within a few points as unsupported.",
      "No verdict is offered. The audit for a specific contract is POST /api/pretrade/check with an option_order block.",
      "These rates pool all market states, and that is measured rather than assumed: conditioning reach on the platform's one validated signal (momentum-12-1, top vs bottom tercile) was tested over 390 non-overlapping date blocks across 32 years and refused at ~2pp resolution in both directions (scripts/research/reachConditioning.ts). Do not adjust a row for the name being hot or cold — the adjustment is not there.",
    ],
    rows,
    unmeasurable,
  });
}
