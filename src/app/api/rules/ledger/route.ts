import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { RULE_REGISTER, measureFloorRule } from "@/lib/rules/ledger";
import { ALPHA } from "@/lib/rules/detectability";

/**
 * GET /api/rules/ledger — are the rules governing every order doing any work?
 *
 * Answers the power question before the performance question. Most rows come
 * back "cannot be told apart on this history", which is the honest reading of
 * a plan whose rules were chosen once and inherited since.
 *
 * ?hold=20   sessions held (the horizon the floor is judged at)
 * ?symbol=X  restrict to one name; omitted, sweeps the panel
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;

/** Panel rows to Bars, interpolated fills excluded — the rule used everywhere else. */
function realBars(sessions: readonly string[], sp: SymbolPanel): Bar[] {
  const filled = new Set(sp.interpolated);
  const out: Bar[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const row = sp.bars[i];
    if (!row || filled.has(i)) continue;
    out.push({
      t: Date.parse(sessions[i]),
      open: row[0],
      high: row[1],
      low: row[2],
      close: row[3],
      volume: row[4],
    });
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const holdSessions = Number(url.searchParams.get("hold") ?? 20);
  const only = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();

  if (!Number.isFinite(holdSessions) || holdSessions < 1) {
    return NextResponse.json({ error: "hold must be a positive integer" }, { status: 400 });
  }

  const floorRule = RULE_REGISTER.find((r) => r.id === "survival_floor")!;
  const symbols = only ? [only] : Object.keys(panel.symbols).sort();
  if (only && !panel.symbols[only]) {
    return NextResponse.json({ error: `${only} is not in the panel.` }, { status: 404 });
  }

  const measured = symbols.map((s) =>
    measureFloorRule(
      s,
      realBars(panel.sessions, panel.symbols[s]),
      holdSessions,
      floorRule.current,
      floorRule.candidates
    )
  );

  const withComparisons = measured.filter((m) => m.comparisons.length > 0);
  const retire = withComparisons.filter((m) => m.action === "retire");
  const keep = withComparisons.filter((m) => m.action === "keep");

  /*
   * How many symbols would clear the bar on luck alone. Each name is one
   * independent test of the same rule, so a handful of hits out of forty is
   * what chance produces — and saying so beside the count is the difference
   * between a ledger and a list of coincidences.
   */
  const expectedByChance = withComparisons.length * ALPHA;

  return NextResponse.json({
    hold_sessions: holdSessions,
    price_session: panel.sessions[panel.sessions.length - 1] ?? null,

    survival_floor: {
      statement: floorRule.statement,
      current: floorRule.current,
      candidates: floorRule.candidates,
      symbols_measured: withComparisons.length,
      symbols_where_floor_is_inert: measured.length - withComparisons.length,
      distinguishably_better_alternative: retire.length,
      distinguishably_worse_alternatives_only: keep.length,
      expected_by_chance_alone: Math.round(expectedByChance * 10) / 10,
      verdict:
        withComparisons.length === 0
          ? `On no symbol in this panel does changing the floor select a different stop at a ` +
            `${holdSessions}-session hold. The rule's exact value is inert here — which is worth ` +
            `knowing, because it means the number has never been load-bearing.`
          : retire.length <= expectedByChance
            ? `${retire.length} of ${withComparisons.length} symbols showed a better alternative, ` +
              `against ${expectedByChance.toFixed(1)} expected from chance alone at these sample ` +
              `sizes. That is not evidence the floor is wrong. Keep it, and note that this history ` +
              `cannot yet justify it either — it rests on judgement, not measurement.`
            : `${retire.length} of ${withComparisons.length} symbols showed a distinguishably ` +
              `better alternative, above the ${expectedByChance.toFixed(1)} chance produces. Worth ` +
              `examining which names, and whether they share a characteristic, before moving a ` +
              `rule that governs every order.`,
      per_symbol: measured.map((m) => ({
        symbol: m.symbol,
        selected_stop_pct: m.selectedWidthPct,
        action: m.action,
        sentence: m.sentence,
        comparisons: m.comparisons.map((c) => ({
          alternative: c.alternative,
          mean_diff_pp: Math.round((c.alternativeMean - c.currentMean) * 100) / 100,
          distinguishable: c.verdict.distinguishable,
          min_detectable_pp: Math.round(c.verdict.minDetectable * 100) / 100,
          independent_n: c.verdict.independentN,
          sentence: c.verdict.sentence,
        })),
      })),
    },

    /*
     * The three rules this codebase cannot test, listed with the missing input
     * named. Omitting them would let the ledger read as an audit of the plan
     * when it audits one rule of four.
     */
    not_measurable: RULE_REGISTER.filter((r) => !r.measurable).map((r) => ({
      rule: r.id,
      statement: r.statement,
      current: r.current,
      blocked_by: r.blockedBy,
    })),

    caveat:
      "Symbols are judged separately and never pooled. Their entry windows overlap the same " +
      "market, so stacking them would inflate the sample without adding independent evidence.",
  });
}
