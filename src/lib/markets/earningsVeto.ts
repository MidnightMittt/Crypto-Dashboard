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
 * The next earnings date for `symbol` inside the veto window, or null when
 * none is known — which, per the asymmetry above, is indistinguishable
 * from "no earnings soon" on purpose.
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
