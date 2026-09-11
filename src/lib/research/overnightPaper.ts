import { BarsPanel } from "./barsPanel";
import { LegStats, summariseSeries, overnightSeries, tickCostBp } from "./overnightDecomposition";
import { SpreadObservation } from "../history/spreadHistory";
import { BP, PaperDeclaration, PaperSession } from "./paperEngine";
import { Bar } from "./types";

/**
 * THE OVERNIGHT PAPER LEGS — the strategy priced two ways, on purpose.
 *
 * ── Why two legs and not one ──────────────────────────────────────────
 *
 * The study measures prior CLOSE to next OPEN and charges a MODELLED one-tick
 * round trip. The trade actually placed buys at the 15:50 mark and sells into
 * the next opening auction. Those are not the same strategy, and quietly
 * publishing either one under the other's name would make the live fills
 * unverifiable against the paper line — which is the entire purpose.
 *
 * So both are computed, and the DIFFERENCE between them on shared dates is
 * itself the measurement: how much of the premium is given up by marking ten
 * minutes early and crossing a real book, in basis points, observed rather
 * than assumed. See `markDrag`.
 *
 *   close-to-open   prior close -> next open, modelled tick round trip
 *                   ~300 sessions of backfill. Comparable to the study.
 *
 *   mark-to-open    15:50 ASK -> next open, no cost model at all
 *                   Every price in it is a price somebody could have paid.
 *                   Starts 2026-08-18, because quotes cannot be backfilled.
 *
 * ── Why the mark-to-open leg charges no exit spread ───────────────────
 *
 * A market-on-open order fills at the auction print. It does not cross a
 * book, so charging it a half-spread would invent a cost. The entry half IS
 * charged and is MEASURED: the 15:50 ask against the 15:50 mid, from the
 * recorded book. What the figure excludes — and this belongs beside it, not
 * in a footnote — is market impact and auction imbalance, neither of which a
 * top-of-book quote can see.
 *
 * ── The control is not optional ───────────────────────────────────────
 *
 * The benchmark basket returned +7.0bp a night at t=1.80 against the scanned
 * cohort's +32.2bp at t=1.88 — four and a half times the effect at the same
 * significance, which is the same Sharpe and therefore volatility-scaled
 * market drift rather than a cohort edge. A paper line for the cohort without
 * the same paper line for the control would reproduce exactly that error,
 * nightly and automatically. Both are produced by the same function.
 */

/** The target minute the mark-to-open leg is declared at. Not a median. */
export const MARK_MINUTE = "15:50";

/**
 * Calendar days between consecutive sessions beyond which the hold is not one
 * night. Matches overnightDecomposition's rule so the two legs cannot
 * disagree about which nights are in scope.
 */
export const MAX_GAP_DAYS = 5;

const dayDiff = (a: string, b: string): number =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/**
 * A symbol's panel rows as Bars, with INTERPOLATED sessions zeroed out.
 *
 * A carried-forward fill repeats the previous close in all four price fields.
 * Left in, it manufactures a 0bp overnight return into the fill AND folds a
 * genuine two-day move into the single night out of it — two fabricated
 * observations from one absent session, pointing in different directions.
 *
 * Zeroing rather than deleting is deliberate. Deleting the row would splice
 * the neighbours together into one observation spanning two nights, which is
 * the same fabrication wearing a shorter series. A zero price fails
 * overnightSeries' own `> 0` guard on BOTH sides, so both observations are
 * dropped, which is the honest outcome.
 */
export function panelBars(panel: BarsPanel, symbol: string): Bar[] {
  const sp = panel.symbols[symbol];
  if (!sp) return [];
  const filled = new Set(sp.interpolated);
  return panel.sessions.map((date, i) => {
    const row = sp.bars[i];
    const t = Date.parse(`${date}T00:00:00Z`);
    if (!row || filled.has(i)) return { t, open: 0, high: 0, low: 0, close: 0, volume: 0 };
    const [open, high, low, close, volume] = row;
    return { t, open, high, low, close, volume: volume ?? 0 };
  });
}

/** One name's contribution to one date, before the basket is averaged. */
interface NameDay {
  date: string;
  symbol: string;
  grossBp: number;
  costBp: number;
  netBp: number;
}

/**
 * Average within a date, then emit one PaperSession per date.
 *
 * The averaging is the whole point and it happens HERE rather than in the
 * engine: a basket of correlated miners held overnight is one bet, and
 * handing the engine name-days would inflate every t by roughly the square
 * root of the basket size. Measured independently on this cohort, pooling
 * overstated t by about 40%.
 */
function asBasket(rows: NameDay[]): PaperSession[] {
  const byDate = new Map<string, NameDay[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return [...byDate.entries()]
    .map(([date, xs]) => ({
      date,
      grossBp: mean(xs.map((x) => x.grossBp)),
      costBp: mean(xs.map((x) => x.costBp)),
      netBp: mean(xs.map((x) => x.netBp)),
      names: xs.length,
      /* Fully in and out every night. This is the strategy with the highest
       * turnover anything here will ever run, and therefore the one whose
       * breakeven cost matters most. */
      turnover: 1,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * PRIOR CLOSE -> NEXT OPEN, modelled tick round trip.
 *
 * Delegates the per-night arithmetic to `overnightSeries` rather than
 * repeating it. That function is the study's definition of this leg; a second
 * spelling here would drift on the gap rule or the cost anchor, and the
 * disagreement would surface as a finding rather than as the bug it was.
 */
export function closeToOpenSessions(
  panel: BarsPanel,
  symbols: readonly string[]
): PaperSession[] {
  const rows: NameDay[] = [];
  for (const symbol of symbols) {
    if (!panel.symbols[symbol]) continue;
    const bars = panelBars(panel, symbol);
    const { observations } = overnightSeries(bars, bars.length);
    for (const o of observations) {
      rows.push({ date: o.date, symbol, grossBp: o.grossBp, costBp: o.costBp, netBp: o.netBp });
    }
  }
  return asBasket(rows);
}

/** The 15:50 book for one symbol on one session, or null. */
function markQuote(
  spreads: readonly SpreadObservation[],
  symbol: string,
  session: string
): SpreadObservation | null {
  return (
    spreads.find(
      (o) =>
        o.symbol === symbol &&
        o.session === session &&
        o.window === "entry" &&
        o.targetMinute === MARK_MINUTE
    ) ?? null
  );
}

/**
 * 15:50 ASK -> NEXT OPEN. Every price is one somebody could have paid.
 *
 * `gross` marks at the 15:50 MID and `net` at the 15:50 ASK, so the charged
 * cost is the half-spread actually resting on the book at the moment of the
 * mark — measured, not modelled. Nothing is charged at the exit: a
 * market-on-open fill takes the auction print without crossing a spread.
 */
export function markToOpenSessions(
  panel: BarsPanel,
  symbols: readonly string[],
  spreads: readonly SpreadObservation[]
): PaperSession[] {
  const rows: NameDay[] = [];
  const idx = new Map(panel.sessions.map((d, i) => [d, i]));

  for (const symbol of symbols) {
    const sp = panel.symbols[symbol];
    if (!sp) continue;
    const filled = new Set(sp.interpolated);

    for (const session of new Set(
      spreads.filter((o) => o.symbol === symbol && o.window === "entry").map((o) => o.session)
    )) {
      const i = idx.get(session);
      if (i === undefined) continue;
      const next = i + 1;
      /*
       * The exit bar must EXIST in the panel. A mark with no next session is
       * an open position, not a zero-return one, and the difference is a
       * whole observation.
       */
      if (next >= panel.sessions.length) continue;
      if (filled.has(next)) continue;
      if (dayDiff(session, panel.sessions[next]) > MAX_GAP_DAYS) continue;

      const row = sp.bars[next];
      if (!row) continue;
      const open = row[0];
      if (!(open > 0)) continue;

      const q = markQuote(spreads, symbol, session);
      if (!q || !(q.mid > 0) || !(q.ask > 0)) continue;

      const grossBp = (open / q.mid - 1) * BP;
      const netBp = (open / q.ask - 1) * BP;
      rows.push({
        date: panel.sessions[next],
        symbol,
        grossBp,
        // gross − net by construction, and therefore exactly the measured
        // half-spread expressed against the same denominator as the return.
        costBp: grossBp - netBp,
        netBp,
      });
    }
  }
  return asBasket(rows);
}

/**
 * THE PAIRED DIFFERENCE — what marking at 15:50 costs, measured.
 *
 * Paired on the date, not compared as two means. Both legs see the same
 * overnight market move, so differencing within a date removes it entirely
 * and leaves only the execution effect. Comparing unpaired means over
 * different date ranges would drown a ~10bp execution difference in a ~200bp
 * nightly standard deviation, and at n≈12 that comparison could not detect
 * anything at all.
 *
 * The two figures decompose it:
 *   gross — the price drift from the 15:50 mid to the official close. Pure
 *           timing: whether these names rally or fade into the bell.
 *   net   — the same plus the cost difference, which is the measured
 *           half-spread paid at the mark against the modelled tick the
 *           close-to-open leg is charged. This is the trader's number.
 */
export interface MarkDrag {
  /** Dates on which BOTH legs produced a value. */
  n: number;
  firstDate: string | null;
  lastDate: string | null;
  /** mark-to-open minus close-to-open, per date, in bp. */
  net: LegStats | null;
  gross: LegStats | null;
  /**
   * The smallest drag this many paired dates could have distinguished from
   * zero at t=3. Stated because the answer at small n is "not yet", and a
   * reader must not read that as "no drag".
   */
  detectableAtT3Bp: number | null;
}

export function markDrag(
  mark: readonly PaperSession[],
  closeToOpen: readonly PaperSession[]
): MarkDrag {
  const c2o = new Map(closeToOpen.map((s) => [s.date, s]));
  const paired = mark
    .filter((m) => c2o.has(m.date))
    .map((m) => ({
      date: m.date,
      netBp: m.netBp - c2o.get(m.date)!.netBp,
      grossBp: m.grossBp - c2o.get(m.date)!.grossBp,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const net = summariseSeries(paired.map((p) => p.netBp));
  return {
    n: paired.length,
    firstDate: paired.length ? paired[0].date : null,
    lastDate: paired.length ? paired[paired.length - 1].date : null,
    net,
    gross: summariseSeries(paired.map((p) => p.grossBp)),
    detectableAtT3Bp: net && net.sdBp > 0 ? (3 * net.sdBp) / Math.sqrt(net.n) : null,
  };
}

// ── The declarations, written before the numbers were looked at ────────

/**
 * When the close-to-open claim was fixed.
 *
 * Two dates compete and the LATER one binds, because a declaration is a
 * statement about a basket and is not complete until both exist:
 *   2026-08-15 `6013a3b` declared the leg — prior close to next open, tick-costed.
 *   2026-08-17 `3b6e9a8` fixed the basket membership in `markets/baskets.ts`.
 * Before the second, the cohort was a list inside a research script, which is
 * the state this project has been burned by before.
 */
export const CLOSE_TO_OPEN_DECLARED_ON = "2026-08-17";

/**
 * The mark-to-open leg is declared TODAY, not on 2026-08-18 when the quote
 * capture began.
 *
 * The capture was built to measure this and its ten sessions are real — but
 * the cost treatment below (ask against mid, nothing charged at the auction)
 * was settled while those quotes were already on disk. Dating the declaration
 * to the capture would claim ten prospective observations for a rule written
 * afterwards. They are still reported; they are reported as in-sample, and
 * this leg's paper record starts at n=0 and accrues.
 */
export const MARK_TO_OPEN_DECLARED_ON = "2026-09-11";

/**
 * `note` is the basket's MEMBERSHIP RULE, carried into the statement rather
 * than kept beside it. A basket named in a declaration without the rule that
 * defines it is one refactor away from being a list of names somebody chose,
 * and the fingerprint would not notice the difference.
 */
export function closeToOpenDeclaration(basket: string, note: string): PaperDeclaration {
  return {
    id: `overnight-${basket}-close-to-open`,
    statement:
      `The ${basket} basket (${note}), bought at each session's close and sold at the ` +
      `next open, returns more than zero net of a one-tick round trip.`,
    entry: "official close of session D",
    exit: "official open of session D+1",
    holdSessions: 1,
    declaredOn: CLOSE_TO_OPEN_DECLARED_ON,
    costBasis: "modelled",
    costNote:
      `One tick (${(tickCostBp(100) ?? 0).toFixed(1)}bp on a $100 name) charged against ` +
      `each night's own prior close. A MODEL, and the one the measured book exists to replace.`,
    independenceBasis:
      "Consecutive overnight returns share no bar — one close and the next open — " +
      "so n is the effective sample and no overlap correction is owed. Names within " +
      "a date are averaged before the series is formed, because the basket is one bet.",
    killCriteria:
      "A net mean at or below zero once the record clears the detectable effect at t=3, " +
      "or a control basket showing the same Sharpe — which would make it market drift.",
  };
}

export const MARK_TO_OPEN_DECLARATION: PaperDeclaration = {
  id: "overnight-scanned-mark-to-open",
  statement:
    "The scanned basket, bought at the 15:50 ask and sold into the next opening " +
    "auction, returns more than zero — at prices that were actually quoted.",
  entry: `${MARK_MINUTE} ET ask, from the recorded book`,
  exit: "official open of session D+1, as a market-on-open fill",
  holdSessions: 1,
  declaredOn: MARK_TO_OPEN_DECLARED_ON,
  costBasis: "measured",
  costNote:
    "The half-spread resting on the book at 15:50, taken as the ask against the mid. " +
    "No exit spread is charged: a market-on-open order fills at the auction print and " +
    "crosses no book. EXCLUDES market impact and auction imbalance, which a " +
    "top-of-book quote cannot see.",
  independenceBasis:
    "One mark, one auction, one night; no bar or quote contributes to two observations. " +
    "Names within a date are averaged before the series is formed.",
  killCriteria:
    "A net mean at or below zero once the paired drag against the close-to-open leg " +
    "is distinguishable from zero, or a drag large enough to consume the premium.",
};
