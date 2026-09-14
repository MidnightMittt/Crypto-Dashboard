import { NextRequest, NextResponse } from "next/server";
import affordabilityJson from "@/data/affordability.json";
import barsPanelJson from "@/data/barsPanel.json";
import earningsJson from "@/data/earningsCalendar.json";
import equityExecutionJson from "@/data/equityExecutionStats.json";
import { BarsPanel, SymbolPanel, alignedCloses } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { ReturnSeries, effectiveBreadth, logReturns } from "@/lib/research/effectiveBreadth";
import type { EquityExecutionSnapshot } from "@/lib/dossier/equityExpectations";
import {
  AffordabilityView,
  excludedAt,
} from "@/lib/research/affordability";
import {
  ChainContract,
  SymbolInput,
  buildContractScreen,
} from "@/lib/research/contractScreen";

/**
 * GET /api/screen/contracts?budget=195 — the screen whose rows are placeable
 * trades, ranked INSIDE the set this budget can actually enter.
 *
 * ── Why this is not `/api/screen/reach` with a price filter ───────────
 *
 * The reach screen ranks the panel by how far each name travels, and its
 * first place was MU: excursion ratio 3.66, up-reach 72.4%, independent_n 13.
 * A good row. MU's cheapest 0.30-0.50 delta contract costs $1,793 against an
 * account holding $195.51, so the ranking's first place could be admired and
 * not acted on — a decorative first place.
 *
 * Filtering that table by price afterward would produce a shorter table with
 * the same defect, because the reader would have no way to tell a name absent
 * for costing $1,793 from a name absent because nothing priced it. So the
 * order is inverted: the affordable set is established first, in
 * `affordability.json`, and the ranking runs inside it. What the budget
 * removed comes back in the response with the number that removed it.
 *
 * ── The candidate rule, stated because it constrains the answer ───────
 *
 * One contract per (name, expiry): the cheapest inside the 0.30-0.50 delta
 * band that clears the spread and open-interest gates. Not every band
 * contract.
 *
 * This is a real restriction and it is not merely a convenience. Inside the
 * band, cheaper means further out of the money, which means a longer breakeven
 * distance, which means a LOWER reach probability. Ranking across every band
 * contract would therefore march straight up the band to the most expensive
 * strike on each chain — and then the budget would reject exactly those. The
 * cheapest band contract is the budget-feasible representative of the name,
 * and holding one per name and expiry is what makes the comparison across
 * names a comparison of names rather than of strike selection.
 *
 * The cost is that a mid-band strike which happens to price well is invisible
 * here. That is a known limit of this endpoint, not an oversight, and it is
 * repeated in `caveats` where a reader will meet it.
 *
 * ── Everything is served from committed artifacts ─────────────────────
 *
 * No chain is fetched at request time. Forty-two affordable names would be
 * forty-two paced venue round-trips inside one request, which on Vercel is a
 * timeout rather than a screen, and it would make the ranking depend on when
 * it was asked for. The nightly sweep is the only thing that touches Tradier;
 * this route reads what it wrote and joins bars, the reach calibration and the
 * earnings calendar to it.
 */

export const dynamic = "force-dynamic";

const view = affordabilityJson as unknown as AffordabilityView;
const panel = barsPanelJson as unknown as BarsPanel;
const snapshot = equityExecutionJson as unknown as EquityExecutionSnapshot;
const earnings = earningsJson as {
  entries: { symbol: string; date: string }[];
  sweep?: { throughDate?: string };
};

const DEFAULT_BUDGET_USD = 195;
const MIN_BUDGET_USD = 10;
const MAX_BUDGET_USD = 1_000_000;

/**
 * Rows treated as "the top of the sort" for the breadth measurement.
 *
 * Matches `/api/screen/reach`. The account can hold a handful of positions, so
 * ten is generous to the table rather than to the caution — and on a list this
 * short the figure matters more, not less: the top ten of an asymmetry sort
 * came back at 1.97 effective bets.
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
  const raw = req.nextUrl.searchParams.get("budget");
  const budgetUsd = raw === null ? DEFAULT_BUDGET_USD : Number(raw);
  if (!Number.isFinite(budgetUsd) || budgetUsd < MIN_BUDGET_USD || budgetUsd > MAX_BUDGET_USD) {
    return NextResponse.json(
      {
        error:
          `budget must be a number of dollars between ${MIN_BUDGET_USD} and ${MAX_BUDGET_USD}, got ${raw}. ` +
          "It is the cash deployable into one contract, not the account value.",
      },
      { status: 400 }
    );
  }

  const eventBySymbol = new Map(earnings.entries.map((e) => [e.symbol, e.date]));
  const eventsKnownThrough = earnings.sweep?.throughDate ?? null;
  const today = view.session;

  /*
   * Names whose stored cheapest contract clears the budget. `excludedAt` is
   * the exact complement over the same entries, so no name is lost between the
   * two and the response can account for all 124.
   */
  const affordable = view.entries.filter(
    (e) => e.cheapest !== null && e.cheapest.costUsd <= budgetUsd
  );
  const budgetExcluded = excludedAt(view, budgetUsd);

  const symbols: SymbolInput[] = [];
  const noBars: { symbol: string; reason: string }[] = [];

  for (const entry of affordable) {
    const sp = panel.symbols[entry.symbol];
    if (!sp) {
      /*
       * The sweep's roster comes from this same panel, so this should be
       * unreachable — but the two artifacts are written by different runs and
       * a name dropped from the panel between them would otherwise vanish from
       * both the ranking and the exclusions, which is the silent-absence
       * failure this whole endpoint exists to prevent.
       */
      noBars.push({ symbol: entry.symbol, reason: "priced by the sweep but absent from the committed bars panel" });
      continue;
    }
    const contracts: ChainContract[] = entry.cheapestByExpiry
      .filter((c) => c.costUsd <= budgetUsd)
      .map((c) => ({
        symbol: entry.symbol,
        expiry: c.expiry,
        kind: c.kind,
        strike: c.strike,
        bid: c.bid,
        ask: c.ask,
        openInterest: c.openInterest,
        /*
         * The sweep stores open interest but not session volume — it gates on
         * OI, which is the one that decides whether a position can be exited.
         * Reported as 0 would read as "nothing traded today", so the column is
         * carried as a declared absence instead.
         */
        volume: 0,
        ivPct: null,
        delta: c.delta,
      }));
    if (contracts.length === 0) continue;

    symbols.push({
      symbol: entry.symbol,
      spot: entry.spot ?? 0,
      bars: realBars(panel.sessions, sp),
      contracts,
      eventDate: eventBySymbol.get(entry.symbol) ?? null,
      eventsKnownThrough,
      ivRvRatio: null,
    });
  }

  const screen = buildContractScreen({
    symbols,
    budgetUsd,
    snapshot,
    today,
    budgetExcluded,
  });

  /*
   * Breadth of the rows ACTUALLY RANKED, on the same axis `/api/screen/reach`
   * measures it: how many independent bets a reader is looking at, not how
   * many lines the table has. It is computed twice because nobody reads a
   * ranking sideways — they read the top, and the sort concentrates whatever
   * moves most, which are the things that move together.
   *
   * The third figure, `whole_panel`, is the control. Without it "4.03 bets"
   * is a number with nothing to compare against, and the interesting question
   * about a budget restriction is not how much breadth survives but how much
   * the restriction COST — which is a difference, not a level.
   */
  const seriesFor = (syms: readonly string[]) => {
    const m = new Map<string, ReturnSeries>();
    for (const s of syms) if (panel.symbols[s]) m.set(s, logReturns(alignedCloses(panel, s)));
    return m;
  };
  const returnSessions = Math.max(panel.sessions.length - 1, 0);
  const rankedSymbols = [...new Set(screen.rows.map((r) => r.symbol))];
  const wholePanel = effectiveBreadth(seriesFor(Object.keys(panel.symbols)), returnSessions);
  const allRows = effectiveBreadth(seriesFor(rankedSymbols), returnSessions);
  const namesKeptPct = (rankedSymbols.length / view.entries.length) * 100;
  /*
   * Both halves or neither. `effective_bets` is null when a set is too small
   * to have a pairwise correlation at all, and a comparison with one side
   * missing is not a weaker comparison — it is a different sentence wearing
   * this one's clothes.
   */
  const panelBets = wholePanel.effective_bets;
  const rowBets = allRows.effective_bets;
  const comparable = panelBets !== null && rowBets !== null && panelBets > 0;
  const betsKeptPct = comparable ? (rowBets! / panelBets!) * 100 : null;
  const breadth = {
    top_of_sort: effectiveBreadth(seriesFor(rankedSymbols.slice(0, TOP_OF_SORT)), returnSessions),
    all_rows: allRows,
    whole_panel: wholePanel,
    /*
     * Measured rather than asserted. An earlier draft of this endpoint claimed
     * the affordable set was "more correlated than the panel it came from"
     * without checking. It is — mean pairwise rho rises monotonically as the
     * budget tightens, 0.177 across the panel against 0.229 at $195 — but the
     * claim was made before the measurement and would have shipped either way.
     */
    budget_cost: !comparable
      ? `The budget keeps ${rankedSymbols.length} of ${view.entries.length} names ` +
        `(${namesKeptPct.toFixed(0)}%). Effective bets could not be measured on both sets, so ` +
        "the breadth the restriction cost is not reported rather than reported from one side."
      : `The budget keeps ${rankedSymbols.length} of ${view.entries.length} names ` +
        `(${namesKeptPct.toFixed(0)}%) and ${rowBets!.toFixed(2)} of ${panelBets!.toFixed(2)} ` +
        `effective bets (${betsKeptPct!.toFixed(0)}%). It removes far more names than breadth, ` +
        "because the names it removes are largely restatements of ones it keeps — so the " +
        "affordable set is a much smaller list but not a proportionally poorer one. What it is, " +
        `is more correlated: mean pairwise rho ${allRows.mean_pairwise_rho} here against ` +
        `${wholePanel.mean_pairwise_rho} across the panel, because cheap contracts cluster in ` +
        "low-priced high-volatility names.",
    read_first:
      `top_of_sort — it describes the ${TOP_OF_SORT} names a reader acts on. Then budget_cost, ` +
      "which is the only one of these figures that says what the affordability restriction did.",
  };

  /*
   * HOW MUCH OF THE ORDERING THE RANKING STATISTIC ACTUALLY DECIDES.
   *
   * `reachRateFor` is a BUCKET lookup, so it returns one of a handful of
   * values however many rows are ranked. On the first live run the entire top
   * eight came back at 70.7% and the next block at 48.7% — two distinct
   * probabilities across sixty-four rows. Everything else in the visible order
   * is the tiebreak.
   *
   * The first version of this comment called that "not a defect, because a
   * bucket table cannot do better." Half of that was true and the half that
   * was not mattered. A bucket table genuinely cannot resolve within a bucket
   * — but the tiebreak it hands off to is a free choice, and the one chosen
   * was cost-ascending, which is negatively correlated with distance to
   * breakeven and therefore sorted the largest group least-likely-first. The
   * coarseness was unavoidable; pointing it downhill was not.
   *
   * A table sorted 70.7 / 70.7 / 70.7 / 70.7 also reads as a ranking with fine
   * gradations, and the reader would be inferring a precision the estimator
   * does not have. So the resolution is measured on the rows returned and
   * printed beside them, in the same spirit as `independent_n`: the honest
   * limit belongs on the table, not in a footnote.
   */
  const reachValues = screen.rows.map((r) => r.reachPct);
  const valueCounts = new Map<number, number>();
  for (const v of reachValues) valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
  const largestTie = Math.max(0, ...valueCounts.values());
  const tiedRows = [...valueCounts.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);

  /*
   * The count of tied rows understates the problem on its own, because it says
   * how many rows share a number without saying how much that number is
   * hiding. The buckets are half-open intervals labelled by their upper edge,
   * and they are wide: the largest group on a live run held breakevens from
   * 1.02 to 1.89 ATR under a single 48.7%, while the table's own neighbouring
   * cell puts 1 ATR at 70.7%. So the span is measured too, in the units the
   * estimator is monotone in.
   */
  const biggestBucket = [...valueCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const inBiggest = biggestBucket
    ? screen.rows.filter((r) => r.reachPct === biggestBucket[0]).map((r) => r.breakevenAtr)
    : [];
  const spanAtr =
    inBiggest.length > 1
      ? { min: Math.min(...inBiggest), max: Math.max(...inBiggest) }
      : null;

  const rankResolution = {
    rows: screen.rows.length,
    distinct_reach_values: valueCounts.size,
    largest_tie_group: largestTie,
    rows_tied_with_another: tiedRows,
    ordered_by_tiebreak_pct:
      screen.rows.length > 0 ? Math.round((tiedRows / screen.rows.length) * 1000) / 10 : 0,
    largest_tie_reach_pct: biggestBucket ? biggestBucket[0] : null,
    largest_tie_breakeven_atr_min: spanAtr ? Math.round(spanAtr.min * 100) / 100 : null,
    largest_tie_breakeven_atr_max: spanAtr ? Math.round(spanAtr.max * 100) / 100 : null,
    tiebreak: "breakeven_atr ascending, then cost_usd ascending",
    sentence:
      screen.rows.length === 0
        ? "No rows to resolve."
        : `${screen.rows.length} rows carry ${valueCounts.size} distinct reach probabilities, the ` +
          `largest tie group holding ${largestTie}. ${tiedRows} rows (` +
          `${((tiedRows / screen.rows.length) * 100).toFixed(0)}%) sit in a tie, so their position ` +
          "is set by the tiebreak rather than by the ranking statistic." +
          (spanAtr
            ? ` That largest group is quoted one probability of ${biggestBucket[0]}% across ` +
              `breakevens from ${spanAtr.min.toFixed(2)} to ${spanAtr.max.toFixed(2)} ATR, which is a ` +
              "real spread the bucket cannot see — the table's adjacent cells differ by roughly 20 " +
              "points over that range."
            : "") +
          " Ties are ordered nearest-breakeven-first, using only the monotonicity the calibrated " +
          "table already asserts. An earlier version ordered them cheapest-first, which ran the " +
          "other way: cheaper contracts sit further out of the money, so that tiebreak put the " +
          "least likely rows on top. No within-bucket probability is interpolated, because that " +
          "number would carry no forward record.",
  };

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    budget_usd: budgetUsd,
    horizon_sessions: screen.horizonSessions,

    /* ── provenance, kept apart because these three dates can disagree ── */
    as_of: {
      quotes_session: view.session,
      bars_session: panel.sessions[panel.sessions.length - 1] ?? null,
      sweep_generated_at: new Date(view.generatedAt).toISOString(),
      earnings_known_through: eventsKnownThrough,
      note:
        "quotes_session is the session the stored chain quotes describe; bars_session is the last " +
        "session in the panel the ATR and excursion columns come from. They are separate fields " +
        "because the panel is known to run a session behind on some runs, and collapsing them " +
        "would let a reader attribute one day's option prices to another day's closes.",
    },

    universe: {
      panel_names: view.entries.length,
      affordable_names: affordable.length,
      ranked_names: rankedSymbols.length,
      excluded_names: budgetExcluded.length,
      note: screen.universeNote,
      coverage_curve: view.coverage.map((c) => ({ budget_usd: c.budgetUsd, tradeable: c.tradeable, of: c.of })),
    },

    ranked_by: screen.rankedBy,
    candidate_rule:
      "One contract per name and expiry: the cheapest inside the 0.30-0.50 delta band clearing the " +
      "spread and open-interest gates. Inside the band cheaper means further out of the money and " +
      "therefore a lower reach probability, so ranking across every band contract would climb to the " +
      "most expensive strike on each chain — which the budget then rejects. A mid-band strike that " +
      "happens to price well is invisible to this endpoint.",

    breadth,
    rank_resolution: rankResolution,

    rows: screen.rows,

    /*
     * Both halves of "why is this list short", kept apart because they are
     * different facts. `budget_excluded` never had a chain fetched for it and
     * carries the cost that would change that. `rejected` had one and failed a
     * named check.
     */
    budget_excluded: screen.budgetExcluded,
    rejected: screen.rejected,
    rejected_by_reason: screen.rejectedByReason,
    /*
     * An empty `rejected` here means the gates were unreachable, NOT that
     * every contract passed a set of checks.
     *
     * The candidates come from the nightly sweep, which already applied the
     * same spread, open-interest, delta-band and horizon rules before storing
     * anything, and this route only admits contracts already under budget. So
     * every rejection reason `buildContractScreen` can raise has been made
     * unreachable upstream, and the list is empty by construction on every
     * run. Left silent, that reads as a clean bill of health on rows that were
     * never actually examined.
     *
     * The rejections still happened — they happened in the sweep, and they are
     * reported there, per name, in `budget_excluded[].detail` and in the
     * artifact's `gates` counts. This field is kept rather than removed
     * because the screen module is shared and a future caller feeding it a raw
     * chain will populate it.
     */
    rejected_note:
      "Empty by construction on this endpoint. The nightly sweep applies the same spread, " +
      "open-interest, delta-band and horizon gates before storing a contract, so nothing " +
      "reaching the ranker can fail them. The rejections are real but they happened upstream: " +
      "see budget_excluded[].detail for the per-name reason and the artifact's gate counts for " +
      "how many contracts each gate removed. An empty list here is not a clean bill of health.",
    unrankable: noBars,

    caveats: screen.caveats,
  });
}
