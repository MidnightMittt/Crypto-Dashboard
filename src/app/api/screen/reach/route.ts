import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel, alignedCloses } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { survivalAt } from "@/lib/research/stopViability";
import { excursionStats, reachAt } from "@/lib/research/exitDesign";
import { conversionReport } from "@/lib/research/touchCalibration";
import { ReturnSeries, effectiveBreadth, logReturns } from "@/lib/research/effectiveBreadth";

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
 *
 * ── Two different sample sizes, and the row only carried one ──────────
 *
 * `independent_n` on a row corrects for windows overlapping inside ONE
 * symbol's own history. It says nothing whatever about whether two SYMBOLS
 * are distinguishable, and on this panel most of them are not: the names
 * move together, so a table sorted 87.3 / 85.1 / 84.4 presents three pieces
 * of evidence where there is closer to one. `breadth` is the second number,
 * computed on exactly the rows returned, and it is what stops the sort
 * reading as a leaderboard.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;

const MIN_HORIZON = 5;
const MAX_HORIZON = 60;
const MIN_MOVE_PCT = 1;
const MAX_MOVE_PCT = 100;

/**
 * Rows treated as "the top of the sort" for the breadth measurement.
 *
 * A shortlist, not a threshold — the point is to describe the slice a reader
 * plausibly acts on, and this account can hold four positions on $137 of
 * buying power. Ten is generous to the table rather than to the caution.
 */
const TOP_OF_SORT = 10;

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

  /*
   * Breadth of the rows ACTUALLY RETURNED, not of the panel as committed.
   * The two differ whenever a horizon knocks short-history names out, and
   * quoting a fixed panel figure beside a filtered table would describe a
   * cross-section the reader is not looking at.
   *
   * And it is measured TWICE, because the whole-table figure is not the one
   * a reader is exposed to. Nobody reads a ranking sideways; they read the
   * top. On this panel that distinction is most of the story — the 122
   * returned rows are worth 5.6 independent bets, but the top three are
   * worth 1.13, because the sort concentrates whatever moves most and the
   * things that move most move together. Printing only the panel figure
   * would understate the problem for every reader who behaves normally.
   */
  const seriesFor = (syms: readonly string[]) => {
    const m = new Map<string, ReturnSeries>();
    for (const s of syms) m.set(s, logReturns(alignedCloses(panel, s)));
    return m;
  };
  const returnSessions = Math.max(panel.sessions.length - 1, 0);
  const symbols = rows.map((r) => r.symbol);
  const breadth = {
    top_of_sort: effectiveBreadth(seriesFor(symbols.slice(0, TOP_OF_SORT)), returnSessions),
    all_rows: effectiveBreadth(seriesFor(symbols), returnSessions),
    read_first:
      `top_of_sort — it describes the ${TOP_OF_SORT} rows a reader actually acts on. ` +
      "all_rows is the panel-wide figure and is the more flattering of the two here, " +
      "because a sort concentrates whatever moves most and the things that move most move together.",
  };

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    horizon_sessions: horizon,
    move_pct: movePct,
    bars_session: panel.sessions[panel.sessions.length - 1] ?? null,
    sort: "by the larger of up_reach and down_touch — a movement ranking, not a recommendation",

    /*
     * HOW MUCH OF THE ORDERING IS REAL.
     *
     * `independent_n` per row handles window overlap within one symbol.
     * This handles the other axis: how many of these names are telling the
     * reader different things. Both are needed, and the row-level figure was
     * the only one printed until now — so a table of highly correlated names
     * each carrying an honest independent_n still read as a menu of
     * independent choices.
     *
     * Two figures inside each, because they answer different questions:
     * effective_bets is what a top-down read is worth, participation_ratio
     * is how many distinct directions the set spans at all. Measured over
     * the committed panel's full return history, stated in `sessions`
     * because correlation is regime-dependent and a calm tape does not
     * describe a stressed one.
     *
     * near_duplicates names the pairs that are not merely similar. It is
     * free — the pairwise pass visits them anyway — and it is the part that
     * changes behaviour, because "breadth is 1.13" is abstract where
     * "MSTU and MSTX are the same position at rho 0.999" is not.
     */
    breadth,

    /*
     * THE BRIDGE TO AN OPTION PRICE, AND ITS MEASURED BIAS.
     *
     * Comparing these rates to an option's implied move needs a conversion
     * (implied vol is a terminal distance; this is a path-touch
     * probability). That conversion was measured over 32 years on a 4x4
     * (horizon, barrier) grid — see touchCalibration.ts — so a caller can
     * tell a real mispricing from an artefact of the bridge, and can see
     * how large the DRIFT term is at this cell before ranking anything by
     * an undecomposed difference.
     */
    gbm_conversion: conversionReport(horizon, movePct),

    /*
     * C2: the correct reach-vs-implied join is PER CONTRACT — a real
     * premium, one name, no cross-symbol drift term — and it is already
     * deployed. Named here because the screen is where a caller decides
     * which name to price, and the two were not connected.
     */
    per_contract_audit: {
      endpoint: "POST /api/pretrade/check",
      why:
        "A cross-sectional 'measured minus implied' ranking is 86% drift by variance — it ranks " +
        "which name trended hardest, not which option is mispriced. Auditing one contract against " +
        "its own premium has no cross-symbol drift term and returns a verdict with named checks.",
      example: {
        symbol: "{one of rows[].symbol}",
        account_value: 437.04,
        buying_power: 137.14,
        hard_floor_usd: 100,
        concurrent_positions: 4,
        option_order: {
          right: "call",
          strike: "{strike}",
          expiry: "{YYYY-MM-DD}",
          premium: "{PER-CONTRACT, e.g. 0.86 not 86}",
          delta: "{from the chain}",
        },
      },
    },
    notes: [
      "Measured on the UNDERLYING's own daily bars; no options chain is involved, and premium/IV are not modelled here — this screens which names move enough that a defined-risk structure could pay, not which contract to buy.",
      "up_reach uses highs (a call's question); down_touch uses lows (a put's question). They are different bets and are never combined into one score.",
      "Windows overlap: independent_n is the honest sample size, printed on every row. Where it reads ~14, that is the difference between a measurement and a decoration — treat orderings within a few points as unsupported.",
      "independent_n corrects for overlap WITHIN one symbol. It does not correct for symbols resembling each other, and on this panel they heavily do — see `breadth`, which carries the second sample size and the caution that goes with it. A count of rows is not a count of observations.",
      "No verdict is offered. The audit for a specific contract is POST /api/pretrade/check with an option_order block.",
      "These rates pool all market states, and that is measured rather than assumed: conditioning reach on the platform's one validated signal (momentum-12-1, top vs bottom tercile) was tested over 390 non-overlapping date blocks across 32 years and refused at ~2pp resolution in both directions (scripts/research/reachConditioning.ts). Do not adjust a row for the name being hot or cold — the adjustment is not there.",
      "DO NOT rank these rows against implied moves to find mispriced options. That difference decomposes 86% drift / 14% volatility, so the ranking is a momentum leaderboard in an options costume — and momentum is refused above. See gbm_conversion for the bridge's own measured bias, and per_contract_audit for the join that works.",
    ],
    rows,
    unmeasurable,
  });
}
