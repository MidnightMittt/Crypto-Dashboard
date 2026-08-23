import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel, alignedCloses } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { RULE_REGISTER, measureFloorRule } from "@/lib/rules/ledger";
import { ALPHA } from "@/lib/rules/detectability";
import { ReturnSeries, effectiveBreadth, logReturns } from "@/lib/research/effectiveBreadth";

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
   * HOW MANY SYMBOLS CLEAR THE BAR ON LUCK ALONE — and how far above that a
   * count has to land before it means anything.
   *
   * This block previously read "each name is one independent test of the
   * same rule". That premise is false on this panel, and it was the load-
   * bearing assumption behind a tripwire that can retire a rule governing
   * every order.
   *
   * The MEAN survives. Expectation is linear, so E[hits] = N x ALPHA holds
   * under any correlation structure whatever, and the figure reported as
   * expected_by_chance_alone needs no correction.
   *
   * The SPREAD does not. Correlated names do not fail independently; they
   * fail together, so the count clusters at 0 or arrives in a clump. The
   * fraction of hits is an average of indicators, which is exactly what
   * effective breadth describes the variance of:
   *
   *   Var(fraction) = ALPHA(1-ALPHA) / N_eff     rather than  ... / N
   *
   * On the committed panel that is the difference between calling 9 hits
   * surprising and needing 21. A rule was never moved on the wrong bar
   * because the count has been 0, but the tripwire was armed at 2.4x too
   * tight, and it errs toward retiring a rule on noise.
   *
   * ── Why this is CONSERVATIVE, stated rather than hoped ────────────────
   *
   * N_eff is measured on RETURN correlation, while the hits are indicators —
   * a threshold crossing, not a return. Thresholding attenuates correlation
   * (for jointly normal pairs the indicator correlation is (2/pi)arcsin(rho),
   * which is below rho everywhere except 0 and 1), so the true indicator
   * N_eff is HIGHER than the one used here and the real bar is somewhat
   * lower. The substitution therefore widens the bar rather than narrowing
   * it, which is the right direction for a test whose false positive costs a
   * rule.
   */
  const expectedByChance = withComparisons.length * ALPHA;

  const breadthSeries = new Map<string, ReturnSeries>();
  for (const m of withComparisons) {
    breadthSeries.set(m.symbol, logReturns(alignedCloses(panel, m.symbol)));
  }
  const breadth = effectiveBreadth(breadthSeries, Math.max(panel.sessions.length - 1, 0));
  const nEff = breadth.effective_bets;

  /*
   * Two sigma, and null when breadth could not be measured. Falling back to
   * the independent bar would be the flattering default — it is precisely
   * the number just shown to be too tight — so an unmeasurable panel gets no
   * threshold and says so.
   */
  const chanceSd =
    nEff === null
      ? null
      : withComparisons.length * Math.sqrt((ALPHA * (1 - ALPHA)) / nEff);
  const surpriseBar = chanceSd === null ? null : expectedByChance + 2 * chanceSd;
  const surprising = surpriseBar !== null && retire.length > surpriseBar;

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

      /*
       * The count's null, spelled out. A mean with no spread beside it is
       * not a test, and the spread is the half that correlation breaks.
       */
      null_model: {
        expected_hits: Math.round(expectedByChance * 10) / 10,
        effective_independent_names: nEff,
        headcount: withComparisons.length,
        sd_of_hits: chanceSd === null ? null : Math.round(chanceSd * 10) / 10,
        surprising_above: surpriseBar === null ? null : Math.round(surpriseBar * 10) / 10,
        sd_if_names_were_independent:
          Math.round(Math.sqrt(withComparisons.length * ALPHA * (1 - ALPHA)) * 10) / 10,
        basis:
          "Hits are a share of names, and correlated names fail together rather than one at a " +
          "time. Var(share) = a(1-a)/N_eff, not a(1-a)/N, so the bar is set from effective " +
          "breadth. The MEAN is unaffected — expectation is linear under any correlation. " +
          "N_eff here is measured on returns; indicator correlation is strictly lower, so this " +
          "bar is conservative by construction rather than by hope.",
        breadth: breadth.sentence,
      },

      verdict:
        withComparisons.length === 0
          ? `On no symbol in this panel does changing the floor select a different stop at a ` +
            `${holdSessions}-session hold. The rule's exact value is inert here — which is worth ` +
            `knowing, because it means the number has never been load-bearing.`
          : surpriseBar === null
            ? `${retire.length} of ${withComparisons.length} symbols showed a better alternative. ` +
              `No verdict is offered: these names' correlation could not be measured, so there is ` +
              `no honest bar to judge the count against, and the independent-names bar is known ` +
              `to be far too tight to substitute.`
            : !surprising
              ? `${retire.length} of ${withComparisons.length} symbols showed a better alternative. ` +
                `Chance alone produces ${expectedByChance.toFixed(1)} on average, and because these ` +
                `${withComparisons.length} names are worth about ${nEff!.toFixed(1)} independent ones, ` +
                `anything up to ${surpriseBar.toFixed(0)} is inside the noise. That is not evidence the ` +
                `floor is wrong. Keep it, and note that this history cannot yet justify it either — ` +
                `it rests on judgement, not measurement.`
              : `${retire.length} of ${withComparisons.length} symbols showed a distinguishably ` +
                `better alternative, above the ${surpriseBar.toFixed(0)} that chance produces once ` +
                `these names' correlation is accounted for — they are worth about ` +
                `${nEff!.toFixed(1)} independent tests, not ${withComparisons.length}. Worth examining ` +
                `which names, and whether they share a characteristic, before moving a rule that ` +
                `governs every order.`,
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
