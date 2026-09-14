import { Bar } from "./types";
import { atrPctSeries } from "../technicals/indicators";
import { tradingSessionsBetween } from "./marketCalendar";
import { reachRateFor } from "../dossier/equityExpectations";
import type { EquityExecutionSnapshot } from "../dossier/equityExpectations";
import { REACH_HORIZON_SESSIONS } from "./forwardReach";
import { excursionStats, reachAt } from "./exitDesign";
import { survivalAt } from "./stopViability";

/**
 * ROWS THAT ARE PLACEABLE TRADES, RANKED BY THE ONE STATISTIC WITH A FORWARD
 * RECORD.
 *
 * ── The gap this closes ───────────────────────────────────────────────
 *
 * `/api/screen/reach` ranks the universe by how far each name travels. It is
 * genuinely useful and it stops one step short of a trade: its best-ranked
 * candidate can be a $190 stock whose nearest call costs $1,500 against an
 * account holding under $200. The screen has no way to know that, because it
 * never touches a chain. Nothing joined "this name has the best asymmetry" to
 * "and here is a contract you can actually buy."
 *
 * This module is that join. A row here is one contract: symbol, expiry,
 * strike, mid, what it costs, how many fit the budget, the move it needs to
 * break even, and the calibrated probability of that move happening.
 *
 * ── What it ranks by, and why it is allowed to ────────────────────────
 *
 * Rank by the thing with a forward record. On this site exactly one statistic
 * has one: reach probability, `forwardReachRecord.json`, 1,171 resolved
 * windows, promised 54.43% and delivered 52.18%.
 *
 * But that record calibrates ONE estimator — `reachRateFor(distanceAtr,
 * touches)`, a pooled bucket lookup measured on support and resistance ZONES
 * over 10 sessions. It takes no symbol. Its population is structural levels,
 * and an option's breakeven is not one: it is wherever strike plus premium
 * lands, with no order flow defending it and no touch history. Quoting the
 * table there is an extrapolation ACROSS POPULATIONS, and a forward record
 * travels with the population it was measured on, not with the word "reach".
 *
 * So it was measured first — `scripts/audit/reachTransfer.ts` — against the
 * arbitrary-price counterpart on the same panel, same 10-session window, same
 * bucket edges. Every published cell sits inside the arbitrary-price range,
 * and at the bucket midpoint the zone table agrees to about a point:
 *
 *     bucket   structural   arbitrary at midpoint
 *          1        70.7%                   71.3%
 *          2        48.7%                   47.4%
 *          3        25.5%                   25.0%
 *
 * There is no magnet effect. Reach is governed by distance in ATR and the
 * structural framing adds nothing measurable, so the record transfers and the
 * ranking is licensed. Had it not transferred, this module would rank by
 * nothing and say so.
 *
 * ── What the ranking therefore IS, stated plainly ─────────────────────
 *
 * `reachRateFor` is monotone decreasing in one argument. So this ranking is a
 * re-expression of ONE quantity: the move a contract needs, divided by how
 * far the underlying typically travels in a day. It is not a composite and
 * must not be dressed as one. Its whole content is "cheap relative to how
 * much this name moves", and its whole value is that the mapping from that
 * ratio to a probability has been checked against 1,171 resolved forward
 * windows instead of asserted.
 *
 * ── The horizon is 10 sessions and contracts that cannot hold it are cut ──
 *
 * The calibration is a 10-SESSION probability. A contract with five sessions
 * left cannot borrow it: the probability would describe a window the contract
 * does not live through. Those rows are REJECTED with a named reason rather
 * than quietly scored, which is the same discipline that corrected the IV/RV
 * forward leg from 21 sessions to 15 — a measurement clock that does not
 * match the trade clock is a defect whichever direction it points.
 *
 * ── The direction column, and why it is beside the rank and not inside ──
 *
 * The published table pools direction: the replay recorded whether a level
 * was reached, never whether it sat above or below. A call needs price UP.
 * Measured, up-reach beats down-reach at every distance — but with each
 * symbol's own drift removed, only 6-15% of that gap survives inside 1.5 ATR,
 * against 33-68% past 2 ATR. Near the money the asymmetry is the market
 * having risen; past 2 ATR it is the real right tail.
 *
 * Option breakevens live past 2 ATR, so the pooled rate understates a call
 * there by roughly two to three points. That is reported per row as
 * `direction_skew_pp` and is deliberately NOT folded into the rank: the
 * measurement is in-sample on one 300-session panel that rose, and a
 * correction of that provenance belongs where a reader can see it and refuse
 * it, not silently inside the sort key.
 *
 * ── Unvalidated columns ───────────────────────────────────────────────
 *
 * Excursion asymmetry and IV/RV are carried as columns and marked. Both are
 * computed from bars nobody disputes and neither has a forward record of its
 * own; ordering by them would be exactly the error the IV/RV kill line exists
 * to prevent. They inform, they do not sort.
 */

/** Sessions the ranking probability describes. Fixed by what was calibrated. */
export const HORIZON_SESSIONS = REACH_HORIZON_SESSIONS;

/** Wilder's period, matching every other ATR consumer in the repo. */
export const ATR_PERIOD = 14;

/**
 * Widest bid/ask spread tolerated, as a percent of mid.
 *
 * A quoted mid is not a fill. On a 40%-wide market the mid is a midpoint
 * between two prices nobody trades at, and a screen that ranks by a
 * probability computed off that midpoint is ranking fiction. 25 is generous
 * for this account's names — the miners quote wide — and it is a declared
 * parameter rather than a hidden filter so a caller can see what it removed.
 */
export const MAX_SPREAD_PCT_OF_MID = 25;

/** Contracts with less open interest than this are treated as not tradeable. */
export const MIN_OPEN_INTEREST = 10;

/**
 * The distance past which the drift-controlled direction gap is mostly real
 * rather than mostly the panel having risen. Measured, not chosen.
 */
export const SKEW_REAL_BEYOND_ATR = 2;

export type RejectReason =
  | "no_two_sided_market"
  | "spread_too_wide"
  | "thin_open_interest"
  | "unaffordable"
  | "expiry_shorter_than_horizon"
  | "no_atr"
  | "beyond_reach_table"
  | "breakeven_behind_spot";

export interface ChainContract {
  symbol: string;
  expiry: string;
  kind: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  openInterest: number;
  volume: number;
  /** Percent, e.g. 82.4. Carried for the unvalidated IV column only. */
  ivPct: number | null;
  delta: number | null;
}

export interface SymbolInput {
  symbol: string;
  spot: number;
  bars: readonly Bar[];
  contracts: readonly ChainContract[];
  /** Dated catalyst before or at expiry, if the calendar knows one. */
  eventDate?: string | null;
  /**
   * The last date the earnings calendar actually swept to.
   *
   * Required to tell "no catalyst before expiry" from "nobody looked". The
   * committed calendar sweeps through 2026-10-09 while the affordability
   * artifact carries expiries out to 2027-01-15, so for a November contract a
   * bare `eventBeforeExpiry: false` would be a claim the data cannot support —
   * and the more dangerous direction, because a clean catalyst column is read
   * as permission to hold through the window.
   */
  eventsKnownThrough?: string | null;
  /** Screen ratio from the IV/RV collector. Unvalidated — column only. */
  ivRvRatio?: number | null;
}

export interface ScreenRow {
  symbol: string;
  kind: "call" | "put";
  expiry: string;
  strike: number;
  /** Calendar days to expiry. */
  dte: number;
  /** Sessions to expiry on the declared market calendar. */
  sessionsToExpiry: number;
  spot: number;
  bid: number;
  ask: number;
  mid: number;
  spreadPctOfMid: number;
  openInterest: number;
  volume: number;
  delta: number | null;
  /** Cash outlay for one contract, in dollars. */
  costUsd: number;
  contractsAffordable: number;
  /** Price the underlying must reach for the contract to break even at expiry. */
  breakeven: number;
  /** That breakeven as a percent move from spot. Signed by direction. */
  breakevenMovePct: number;
  /** The same distance in the symbol's own ATR — the ranking input. */
  breakevenAtr: number;

  /* ── the ranking statistic, and the only validated number on the row ── */
  reachPct: number;
  /** Attempts behind the bucket the rate came from. */
  reachAttempts: number;
  reachBucketAtr: number;

  /* ── measured beside the rank, never inside it ── */
  /**
   * The same question asked of THIS symbol's own bars, in the paying
   * direction: how often it travelled the breakeven move within the horizon.
   *
   * This column was added to make a tied bucket readable, and then measured
   * and found unable to do that job. It IS continuous where `reachPct` is a
   * six-edge bucket lookup — on the live $195 run it turned a 45-row tie into
   * 37 distinct values spanning 27.9% to 71.7%. But the separation does not
   * reproduce. Split the history in half and correlate each symbol's estimate
   * across the halves (`scripts/audit/symbolReachReliability.ts`) and the
   * agreement is rho 0.211 at t 1.17 over 31 symbols — indistinguishable from
   * zero. A variance decomposition agrees from the other side: observed
   * cross-sectional dispersion is 9.7pp against a 9.4pp sampling floor at
   * n_eff ~28, leaving 2.2pp attributable to symbols genuinely differing.
   *
   * So it is kept as a displayed column and NOT as the tiebreak, and the
   * distinction matters: `asymmetryRatio` and `ivRvRatio` below are
   * unvalidated in the sense of not yet scored, while this one has been
   * scored and came back noise. Two rows differing by 10pp here are not
   * distinguishable, and the caveat says so rather than letting a continuous
   * column imply a resolution it does not have.
   */
  symbolReachPct: number | null;
  /** Overlapping entry windows behind `symbolReachPct`. */
  symbolReachN: number | null;
  /** Non-overlapping windows the same span holds. The honest sample size. */
  symbolReachIndependentN: number | null;
  /** Points the pooled rate understates a call (or overstates a put) here. */
  directionSkewPp: number | null;
  /** Unvalidated: median up excursion over median down, from the same bars. */
  asymmetryRatio: number | null;
  /** Unvalidated, and gated: IV over trailing RV. */
  ivRvRatio: number | null;
  ivPct: number | null;

  /* ── catalyst overlay ── */
  eventDate: string | null;
  /**
   * True when a dated event falls between now and expiry, false when the
   * calendar swept the whole window and found none, NULL when the calendar's
   * sweep ends before expiry and the question is therefore unanswered.
   *
   * The null is the point. A boolean here can only say yes or no, and "no"
   * from a calendar that stopped looking six weeks before the contract expires
   * is the same sentence as "no" from one that checked — while meaning the
   * opposite thing about what the reader knows.
   */
  eventBeforeExpiry: boolean | null;
  /** How far the calendar looked, so the field above can be judged. */
  eventsKnownThrough: string | null;
}

export interface RejectedRow {
  symbol: string;
  expiry: string;
  kind: "call" | "put";
  strike: number;
  reason: RejectReason;
  /** The sentence a reader needs to know whether to care. */
  detail: string;
}

/**
 * What the stored affordability sweep already knows the budget cannot reach.
 *
 * The screen never fetches a chain for these, so they cannot appear as
 * rejected rows — there is no row. Passing them in is what keeps the short
 * list explainable: a name absent because it costs $1,520 and a name absent
 * because the sweep never saw it are different facts, and a screen that shows
 * neither reads as coverage.
 */
export interface BudgetExclusion {
  symbol: string;
  /** Cheapest qualifying contract, or null when nothing qualified at all. */
  costUsd: number | null;
  detail: string;
}

export interface ScreenInput {
  symbols: readonly SymbolInput[];
  /** Cash the caller can actually deploy, in dollars. */
  budgetUsd: number;
  snapshot: EquityExecutionSnapshot | null;
  /** ISO date the screen is run on. */
  today: string;
  /** Names the stored sweep excluded before any chain was fetched. */
  budgetExcluded?: readonly BudgetExclusion[];
}

export interface ContractScreen {
  horizonSessions: number;
  budgetUsd: number;
  rows: ScreenRow[];
  rejected: RejectedRow[];
  /** How many rows each reason removed, so a short list is explainable. */
  rejectedByReason: Record<string, number>;
  /**
   * Names the budget removed before a chain was ever fetched, nearest to
   * reachable first — so the list doubles as "what does growing the account
   * buy next".
   */
  budgetExcluded: BudgetExclusion[];
  /** One sentence a reader can act on about how much the budget removed. */
  universeNote: string;
  rankedBy: string;
  caveats: string[];
}

/**
 * The drift-controlled up-minus-down gap, in points, at this distance.
 *
 * Interpolated between the distances actually measured by
 * `scripts/audit/reachTransfer.ts`. Below the first measured distance it
 * returns the first value rather than extrapolating toward zero, and above
 * the last it holds the last — an interpolation table does not get to invent
 * behaviour outside the range that produced it.
 *
 * Sign follows the trade: positive means the pooled rate UNDERSTATES this
 * direction.
 */
const SKEW_TABLE: readonly { atr: number; pp: number }[] = [
  { atr: 0.5, pp: 0.2 },
  { atr: 1.0, pp: 0.4 },
  { atr: 1.5, pp: 1.0 },
  { atr: 2.0, pp: 2.3 },
  { atr: 3.0, pp: 3.2 },
  { atr: 5.0, pp: 2.5 },
];

export function directionSkewPp(distanceAtr: number, kind: "call" | "put"): number | null {
  if (!Number.isFinite(distanceAtr) || distanceAtr <= 0) return null;
  const t = SKEW_TABLE;
  let half: number;
  if (distanceAtr <= t[0].atr) half = t[0].pp;
  else if (distanceAtr >= t[t.length - 1].atr) half = t[t.length - 1].pp;
  else {
    let i = 0;
    while (i < t.length - 1 && t[i + 1].atr < distanceAtr) i++;
    const lo = t[i];
    const hi = t[i + 1];
    half = lo.pp + ((hi.pp - lo.pp) * (distanceAtr - lo.atr)) / (hi.atr - lo.atr);
  }
  /*
   * The measured gap is up MINUS down, so it is split: a call gains half of
   * it against the pooled rate and a put loses half. Attributing the whole
   * gap to one side would double-count, because the pooled rate already sits
   * between the two.
   */
  /*
   * Rounded as a MAGNITUDE and signed afterwards, which is not cosmetic:
   * Math.round breaks ties toward positive infinity, so rounding the signed
   * value turned a 1.15 gap into +1.2 for the call and -1.1 for the put. The
   * two are the same measurement read from opposite ends and have to come back
   * equal and opposite, or the table would show a direction preference that
   * came from a rounding rule rather than from the panel.
   */
  const magnitude = Math.round((half / 2) * 10) / 10;
  return kind === "call" ? magnitude : -magnitude;
}

function push(
  rejected: RejectedRow[],
  c: ChainContract,
  reason: RejectReason,
  detail: string
): void {
  rejected.push({ symbol: c.symbol, expiry: c.expiry, kind: c.kind, strike: c.strike, reason, detail });
}

export function buildContractScreen(input: ScreenInput): ContractScreen {
  const { budgetUsd, snapshot, today } = input;
  const rows: ScreenRow[] = [];
  const rejected: RejectedRow[] = [];

  for (const s of input.symbols) {
    const bars = s.bars;
    /*
     * ATR in PRICE units, via the percent series rather than `atr()`.
     *
     * Not a workaround for a type: `atrPctSeries` is structurally typed on
     * high/low/close and guarantees its last element equals `atr()` over the
     * same input as a percent of the last close, which is pinned by a test.
     * Going through it keeps this module off the nominal `Candle` shape and
     * its volumeUsd field, which a bars panel does not carry and which would
     * otherwise have to be faked at the call site.
     */
    const atrAbs = (() => {
      const series = atrPctSeries(bars, ATR_PERIOD);
      const pct = series.length > 0 ? series[series.length - 1] : null;
      const close = bars.length > 0 ? bars[bars.length - 1].close : null;
      return pct !== null && close !== null && close > 0 ? (pct * close) / 100 : null;
    })();
    const exc = excursionStats(bars, HORIZON_SESSIONS);
    /*
     * Asymmetry from the same bars the reach rate uses, so the unvalidated
     * column and the ranked column describe the same window. Down is
     * negative; the ratio is of magnitudes.
     */
    const asymmetry =
      exc && exc.downMedianPct < 0
        ? Math.round((exc.upMedianPct / Math.abs(exc.downMedianPct)) * 100) / 100
        : null;

    for (const c of s.contracts) {
      if (atrAbs === null || !(atrAbs > 0)) {
        push(rejected, c, "no_atr", `${s.symbol} has too few real bars for a ${ATR_PERIOD}-period ATR, so the breakeven cannot be expressed in the units the reach table is keyed on.`);
        continue;
      }
      const bid = c.bid;
      const ask = c.ask;
      if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || ask < bid) {
        push(rejected, c, "no_two_sided_market", "No two-sided market: one or both sides of the quote are missing or non-positive, so there is no mid to price from.");
        continue;
      }
      const mid = (bid + ask) / 2;
      const spreadPct = ((ask - bid) / mid) * 100;
      if (spreadPct > MAX_SPREAD_PCT_OF_MID) {
        push(rejected, c, "spread_too_wide", `Spread is ${spreadPct.toFixed(0)}% of mid, past the ${MAX_SPREAD_PCT_OF_MID}% limit. The mid is a midpoint between two prices nobody trades at, so any probability computed off it is fiction.`);
        continue;
      }
      if (c.openInterest < MIN_OPEN_INTEREST) {
        push(rejected, c, "thin_open_interest", `Open interest ${c.openInterest} is under ${MIN_OPEN_INTEREST}. Getting in is not the problem; getting out is.`);
        continue;
      }

      const costUsd = mid * 100;
      const affordable = Math.floor(budgetUsd / costUsd);
      if (affordable < 1) {
        push(rejected, c, "unaffordable", `One contract costs $${costUsd.toFixed(0)} against a $${budgetUsd.toFixed(0)} budget.`);
        continue;
      }

      const sessions = tradingSessionsBetween(today, c.expiry);
      if (sessions < HORIZON_SESSIONS) {
        push(rejected, c, "expiry_shorter_than_horizon", `${sessions} sessions to expiry, and the reach probability is calibrated over ${HORIZON_SESSIONS}. A contract cannot borrow a probability describing a window it does not live through.`);
        continue;
      }

      const breakeven = c.kind === "call" ? c.strike + mid : c.strike - mid;
      if (breakeven <= 0) {
        push(rejected, c, "breakeven_behind_spot", "Breakeven is at or below zero, which a put's strike minus its premium can be. Not a tradeable row.");
        continue;
      }
      /*
       * Signed by direction so the column reads as the move the trade needs:
       * a call needs price up, a put needs it down, and both are quoted as
       * the percent from spot in the direction that pays.
       */
      const movePct = ((breakeven - s.spot) / s.spot) * 100;
      const wrongSide = c.kind === "call" ? movePct < 0 : movePct > 0;
      const distanceAtr = Math.abs(breakeven - s.spot) / atrAbs;

      /*
       * A breakeven already behind spot means the QUOTE IS BELOW INTRINSIC.
       *
       * Worth being precise about, because the obvious reading — "deep in the
       * money" — is wrong. A call's breakeven is strike plus premium, and a
       * call cannot be worth less than spot minus strike, so on any coherent
       * quote strike + premium >= spot however deep the contract is. The
       * inequality can only fail when the premium is below intrinsic value,
       * and on a fifteen-minute-delayed chain the overwhelmingly likely cause
       * is a stale mid against a spot that has since moved, not free money.
       *
       * So this is a data guard wearing an arithmetic condition. It matters
       * because such a row would otherwise show a zero-distance breakeven,
       * borrow the nearest bucket's high rate and sort straight to the top —
       * the screen's first place handed to its worst quote.
       */
      if (wrongSide) {
        push(rejected, c, "breakeven_behind_spot", `Breakeven $${breakeven.toFixed(2)} is behind spot $${s.spot.toFixed(2)} in the paying direction, so the quote is below intrinsic value and the contract needs no move to pay. On a delayed chain that is a stale mid rather than an opportunity, and no reach probability describes it.`);
        continue;
      }

      const cell = reachRateFor(distanceAtr, 0, snapshot, "zone");
      if (cell === null) {
        push(rejected, c, "beyond_reach_table", `Breakeven is ${distanceAtr.toFixed(1)} ATR away and the calibrated table has no cell that far out, so there is no validated probability to rank this by.`);
        continue;
      }

      /*
       * The symbol's own history at this exact move, in the direction that
       * pays. Two different functions because they are two different
       * measurements: a call needs the HIGHS to reach the breakeven, a put
       * needs the LOWS to touch it, and `survivalAt` reports the complement.
       * Using the up-side estimator for both would quote a put the
       * probability of the move it loses on.
       */
      const symbolReach = (() => {
        const move = Math.abs(movePct);
        if (!(move > 0)) return null;
        if (c.kind === "call") {
          const cell = reachAt(bars, move, HORIZON_SESSIONS);
          return cell === null
            ? null
            : { pct: cell.reachPct, n: cell.n, independentN: cell.independentN };
        }
        const cell = survivalAt(bars, move, HORIZON_SESSIONS);
        return cell === null
          ? null
          : { pct: 100 - cell.survivalPct, n: cell.n, independentN: cell.independentN };
      })();

      const eventDate = s.eventDate ?? null;
      const knownThrough = s.eventsKnownThrough ?? null;
      /*
       * A found event is a fact whatever the sweep's horizon; an absence is
       * only a fact inside it. So `true` needs no coverage check and `false`
       * needs the calendar to have reached expiry.
       */
      const hasEvent = eventDate !== null && eventDate > today && eventDate <= c.expiry;
      const eventBeforeExpiry = hasEvent
        ? true
        : knownThrough !== null && knownThrough >= c.expiry
          ? false
          : null;
      rows.push({
        symbol: s.symbol,
        kind: c.kind,
        expiry: c.expiry,
        strike: c.strike,
        dte: Math.max(0, Math.round((Date.parse(`${c.expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)),
        sessionsToExpiry: sessions,
        spot: s.spot,
        bid,
        ask,
        mid: Math.round(mid * 100) / 100,
        spreadPctOfMid: Math.round(spreadPct * 10) / 10,
        openInterest: c.openInterest,
        volume: c.volume,
        delta: c.delta,
        costUsd: Math.round(costUsd * 100) / 100,
        contractsAffordable: affordable,
        breakeven: Math.round(breakeven * 100) / 100,
        breakevenMovePct: Math.round(movePct * 10) / 10,
        breakevenAtr: Math.round(distanceAtr * 100) / 100,
        reachPct: Math.round(cell.reachRatePct * 10) / 10,
        reachAttempts: cell.attempts,
        reachBucketAtr: cell.distanceAtrMax,
        symbolReachPct: symbolReach === null ? null : Math.round(symbolReach.pct * 10) / 10,
        symbolReachN: symbolReach?.n ?? null,
        symbolReachIndependentN: symbolReach?.independentN ?? null,
        directionSkewPp: directionSkewPp(distanceAtr, c.kind),
        asymmetryRatio: asymmetry,
        ivRvRatio: s.ivRvRatio ?? null,
        ivPct: c.ivPct,
        eventDate,
        eventBeforeExpiry,
        eventsKnownThrough: knownThrough,
      });
    }
  }

  /*
   * Ranked by the validated statistic, ties broken by distance to breakeven
   * and only then by cost.
   *
   * The tiebreak matters more than it looks, and the first version of it was
   * backwards. The reach table is a BUCKET lookup over half-open intervals
   * labelled by their upper edge, so every contract landing in the same
   * interval carries the identical probability and on a short list most of
   * them do — a live run at $195 put 45 of 64 rows in the (1, 2] bucket, all
   * quoted 48.7%. That interval is wide enough to matter: the table's own
   * neighbouring cell says 70.7% at 1 ATR, so the 45 rows span a real ~20pp
   * range the ranking cannot see.
   *
   * Breaking that tie by cost was not neutral. Cheaper contracts sit further
   * out of the money, so within the bucket cost and distance are negatively
   * correlated (rho -0.268 measured on that run), and cheapest-first pushed
   * the LEAST likely rows to the top: mean breakeven 1.50 ATR in the displayed
   * top half against 1.36 in the bottom, with the independent symbol-specific
   * estimate agreeing at 50.8% versus 54.5%. An ordering that runs against
   * the statistic it claims to rank by is worse than an arbitrary one, because
   * it looks deliberate.
   *
   * Distance-ascending fixes it using only what the calibrated table already
   * asserts — that reach falls monotonically in distance, which is the same
   * property the forward record tests. It does NOT interpolate a finer
   * probability: inventing a within-bucket rate would produce a number no
   * forward record covers. Cost stays as the third key, where it breaks
   * genuine ties without steering them.
   */
  rows.sort(
    (a, b) =>
      b.reachPct - a.reachPct || a.breakevenAtr - b.breakevenAtr || a.costUsd - b.costUsd
  );

  const rejectedByReason: Record<string, number> = {};
  for (const r of rejected) rejectedByReason[r.reason] = (rejectedByReason[r.reason] ?? 0) + 1;

  const budgetExcluded = [...(input.budgetExcluded ?? [])].sort(
    (a, b) => (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity)
  );
  const ranked = input.symbols.length;
  const nextUp = budgetExcluded.find((e) => e.costUsd !== null);
  const universeNote =
    budgetExcluded.length === 0
      ? `Ranked across all ${ranked} names the sweep priced; the budget removed none of them.`
      : `Ranked inside the ${ranked} of ${ranked + budgetExcluded.length} names a $${budgetUsd.toFixed(0)} ` +
        `budget can enter. ${budgetExcluded.length} were excluded on cost before any chain was read` +
        (nextUp
          ? `, the nearest being ${nextUp.symbol} at $${nextUp.costUsd!.toFixed(0)}.`
          : ".") +
        " They are listed rather than hidden, because the list is also the answer to what the next thousand dollars buys.";

  return {
    horizonSessions: HORIZON_SESSIONS,
    budgetUsd,
    rows,
    rejected,
    rejectedByReason,
    budgetExcluded,
    universeNote,
    rankedBy:
      `reach_pct — the calibrated probability that the underlying travels the breakeven distance ` +
      `within ${HORIZON_SESSIONS} sessions. It is the only column here with a forward record ` +
      `(1,171 resolved windows, promised 54.43% and delivered 52.18%). Because the estimator is a ` +
      `bucket lookup on distance in ATR, this ordering is monotone in one quantity: the move the ` +
      `contract needs divided by how far the name moves in a day. It is not a composite.`,
    caveats: [
      `The probability describes the UNDERLYING reaching the breakeven at any point in ${HORIZON_SESSIONS} sessions. It is not the probability the contract is profitable when sold, which depends on when the move happens and what implied vol does — an option reaching breakeven on session 9 of 10 is worth less than one reaching it on session 2.`,
      "The reach table is pooled across direction. direction_skew_pp is the measured, drift-controlled correction and is deliberately NOT applied to the rank — it comes from one 300-session panel that rose, and a correction of that provenance belongs where it can be refused.",
      "asymmetry_ratio and iv_rv_ratio are UNVALIDATED and neither contributes to the ordering. Both are now under pre-declared kill lines: IV/RV's gate arrives 2026-11-16, and asymmetry's forward record (asymmetry-excursion-screen, declared 2026-09-14) is accruing from zero on the same 10-session resolution calendar reach uses. Neither can speak until its own gates are met, and the asymmetry and reach records are never independent corroboration of each other — they share resolution windows.",
      `symbol_reach_pct was added to read ties and then measured and found unable to. It asks the same question of the name's own bars over the same ${HORIZON_SESSIONS} sessions, and it does separate tied rows — but split the history in half and the two halves agree at rho 0.211 (t 1.17, n 31), which is not distinguishable from zero. Its cross-sectional spread is 9.7pp against a 9.4pp sampling floor at roughly 28 independent windows. Read it as one name's history, not as a finer ranking: two rows differing by 10pp here are the same row.`,
      `reach_pct is a bucket lookup over half-open distance intervals, and the buckets are wide. On the live $195 run, 45 of 64 rows shared the (1, 2] bucket at 48.7% while the table's own next cell says 70.7% at 1 ATR — a real ~20pp spread the ranking cannot resolve. Ties are therefore ordered by distance to breakeven, nearest first, which uses only the monotonicity the calibrated table already asserts. No within-bucket probability is interpolated, because that number would have no forward record behind it.`,
      "Rejected rows are listed by name and reason rather than hidden, so a short list is explainable. A screen that silently drops what it cannot price reads as coverage.",
      "Contracts come from a delayed chain. Every quote here is at least fifteen minutes old, so treat mid as an estimate of where the market was, not where it is.",
      "event_before_expiry is null, not false, whenever the earnings calendar's sweep ends before the contract does. A false there would claim a clean window the calendar never checked, and a clean catalyst column reads as permission to hold through it.",
    ],
  };
}
