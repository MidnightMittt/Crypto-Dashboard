/**
 * THE EARNINGS EVENT VETO (decision-engine redesign §10 / step 4 — the
 * only new data source in Phase 1).
 *
 * A swing plan's stop is a statement about structure: "if price trades
 * here, the thesis was wrong." Through an earnings gap that statement is
 * meaningless — price jumps the stop rather than trading through it, the
 * planner's excursion statistics (measured on continuous tape) don't
 * apply, and the R:R printed on the plan was never available. So a plan
 * whose holding window would contain the symbol's earnings report is
 * REFUSED, with the date cited — not risk-adjusted, not starred down,
 * refused, the same treatment every other unpriceable condition gets.
 *
 * Deliberate asymmetries:
 *  - ABSENCE OF EVIDENCE NEVER VETOES. A missing or stale calendar means
 *    `null` here and the plan builds exactly as before — the fetch is a
 *    free keyless endpoint that may fail from CI, and a data outage must
 *    not silently block every equity plan.
 *  - Only FUTURE dates within the window veto. Yesterday's report is a
 *    known number in the price, not a pending gap.
 */

export interface EarningsCalendar {
  /** When the calendar was fetched — display context, never a gate. */
  generatedAt: number;
  /** ISO dates (YYYY-MM-DD, exchange calendar days) per symbol. */
  entries: Array<{ symbol: string; date: string }>;
}

/**
 * Plans are refused when earnings fall within this many TRADING SESSIONS
 * (today inclusive). Three sessions ≈ the median time-to-fill of a planned
 * pullback entry, so the window covers "you would likely still be holding
 * (or just filling) when the report hits." A judgement constant, labelled
 * as such — it should eventually be derived from the execution replay's
 * own time-to-fill distribution.
 */
export const EARNINGS_VETO_SESSIONS = 3;

/** Monday–Friday counting, no holiday calendar — a holiday miscount errs by one session on ~9 US days a year, and it errs CONSERVATIVE (vetoing one session early). */
function isWeekday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Trading sessions from `asOf` (inclusive if a weekday) to `dateIso`
 * (inclusive). Returns 0 when earnings are today, 1 when the next session,
 * etc. Negative/expired dates return null — the past cannot veto.
 */
export function sessionsUntil(asOf: number, dateIso: string): number | null {
  const target = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const start = new Date(asOf);
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  if (target < startDay) return null;

  let sessions = 0;
  for (let t = startDay + 86_400_000; t <= target; t += 86_400_000) {
    if (isWeekday(new Date(t))) sessions++;
  }
  return sessions;
}

export interface EarningsVetoResult {
  /** ISO date of the report inside the veto window. */
  date: string;
  /** Trading sessions until it (0 = today). */
  sessions: number;
}

/**
 * The next earnings date for `symbol` inside the veto window, or null.
 *
 * Null is the right answer for the GATE — absence of evidence must not block
 * every plan — but it is NOT a safe thing to display. Use `earningsStatus`
 * for anything a reader sees; see the note there for why that distinction
 * matters more than it sounds.
 */
export function earningsVeto(
  symbol: string,
  calendar: EarningsCalendar | null | undefined,
  asOf: number,
  vetoSessions: number = EARNINGS_VETO_SESSIONS
): EarningsVetoResult | null {
  if (!calendar?.entries?.length) return null;

  let best: EarningsVetoResult | null = null;
  for (const e of calendar.entries) {
    if (e.symbol !== symbol) continue;
    const sessions = sessionsUntil(asOf, e.date);
    if (sessions === null || sessions > vetoSessions) continue;
    if (!best || sessions < best.sessions) best = { date: e.date, sessions };
  }
  return best;
}

/**
 * WHAT WE ACTUALLY KNOW ABOUT EARNINGS — three states, never a boolean.
 *
 * `earningsVeto` returns null for three unrelated situations: no calendar at
 * all, a calendar that does not cover this symbol, and a symbol whose next
 * report is genuinely outside the window. The first two mean "unknown"; only
 * the third means "clear". Collapsing them let the page render an
 * affirmative safety pass derived from having no data.
 *
 * ── The scale of it, measured 2026-08-16 ──────────────────────────────
 *
 * The committed calendar held 17 symbols against a 95-name panel. Of the
 * twelve names in the scanner universe exactly one — IREN — was covered. So
 * eleven of twelve traded symbols displayed "no earnings in the window" on
 * the strength of never having been looked up. For a gate whose whole job is
 * to decide whether a position is safe to carry through a gap, that is the
 * worst available failure: confidently reassuring, and wrong for a reason the
 * reader cannot see.
 *
 * ── Why an absent symbol is UNKNOWN, not clear ────────────────────────
 *
 * A listed operating company reports roughly quarterly. If the calendar
 * offers no future date for it at all, the overwhelmingly likely explanation
 * is that the provider did not return it — not that the company has stopped
 * reporting. Absence of a date is absence of coverage.
 *
 * ── Why staleness is checked here and not left to the fetch ───────────
 *
 * The daily pipeline refreshes this calendar with a deliberate
 * degrade-don't-fail rule: on any provider error it exits 0 and keeps the
 * committed file, because its entries "expire naturally by date". Expiring
 * entries is true and beside the point — a report announced AFTER the last
 * successful fetch never appears at all. So a silently stale calendar loses
 * exactly the dates that matter most, and only a staleness check can see it.
 */
export type EarningsStatus =
  /** A date is known and falls inside the veto window. */
  | { status: "confirmed_date"; date: string; sessions: number }
  /** A date is known and falls OUTSIDE the window — genuinely clear. */
  | { status: "confirmed_none"; nextDate: string; sessions: number }
  /** Nothing is known. The reason is carried so the gap is diagnosable. */
  | { status: "lookup_failed"; reason: EarningsUnknownReason; calendarAgeDays: number | null };

export type EarningsUnknownReason =
  /** No calendar was supplied, or it was empty. */
  | "no_calendar"
  /** A calendar exists but has no future date for this symbol. */
  | "symbol_not_covered"
  /** The calendar is old enough that a newly announced date could be missing. */
  | "calendar_stale";

/**
 * Past this the calendar may be missing dates announced since the last
 * successful fetch. Companies typically confirm a report date two to four
 * weeks ahead, so a week of staleness is enough to lose one.
 */
export const MAX_CALENDAR_AGE_DAYS = 7;

/**
 * What is known about `symbol`'s next report, as one of three states.
 *
 * Never returns a bare boolean, and never reports "clear" without a date to
 * point at. A caller that wants the GATE should use `earningsVeto`; a caller
 * that wants to TELL somebody should use this.
 */
export function earningsStatus(
  symbol: string,
  calendar: EarningsCalendar | null | undefined,
  asOf: number,
  vetoSessions: number = EARNINGS_VETO_SESSIONS
): EarningsStatus {
  const ageDays =
    calendar && Number.isFinite(calendar.generatedAt) && calendar.generatedAt > 0
      ? Math.floor((asOf - calendar.generatedAt) / 86_400_000)
      : null;

  if (!calendar?.entries?.length) {
    return { status: "lookup_failed", reason: "no_calendar", calendarAgeDays: ageDays };
  }

  /*
   * Staleness is checked BEFORE coverage. A stale calendar that happens to
   * contain this symbol still cannot rule out a date announced since the
   * last fetch, so "we have an old date for it" is not the same as knowing.
   */
  if (ageDays !== null && ageDays > MAX_CALENDAR_AGE_DAYS) {
    return { status: "lookup_failed", reason: "calendar_stale", calendarAgeDays: ageDays };
  }

  let soonest: { date: string; sessions: number } | null = null;
  for (const e of calendar.entries) {
    if (e.symbol !== symbol) continue;
    const sessions = sessionsUntil(asOf, e.date);
    if (sessions === null) continue; // already reported; not a pending gap
    if (!soonest || sessions < soonest.sessions) soonest = { date: e.date, sessions };
  }

  if (!soonest) {
    return { status: "lookup_failed", reason: "symbol_not_covered", calendarAgeDays: ageDays };
  }
  return soonest.sessions <= vetoSessions
    ? { status: "confirmed_date", date: soonest.date, sessions: soonest.sessions }
    : { status: "confirmed_none", nextDate: soonest.date, sessions: soonest.sessions };
}

/** One line a reader can act on, for each of the three states. */
export function describeEarningsStatus(s: EarningsStatus): string {
  switch (s.status) {
    case "confirmed_date":
      return s.sessions === 0
        ? `Earnings today (${s.date}) — a stop cannot price a gap.`
        : `Earnings in ${s.sessions} session${s.sessions === 1 ? "" : "s"} (${s.date}) — a stop cannot price a gap.`;
    case "confirmed_none":
      return `No earnings in the next ${EARNINGS_VETO_SESSIONS} sessions; next report ${s.nextDate}.`;
    case "lookup_failed":
      return s.reason === "symbol_not_covered"
        ? "Earnings date UNKNOWN — this symbol is not in the calendar. Absence of a date is not evidence of no report; check before carrying overnight."
        : s.reason === "calendar_stale"
          ? `Earnings date UNKNOWN — the calendar is ${s.calendarAgeDays} days old and may be missing a date announced since. Check before carrying overnight.`
          : "Earnings date UNKNOWN — no calendar available. Check before carrying overnight.";
  }
}
