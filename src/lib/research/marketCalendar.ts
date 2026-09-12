/**
 * THE US EQUITY SESSION CALENDAR, FORWARD ONLY.
 *
 * Every calendar elsewhere in this repository is derived from data: the bars
 * panel builds a quorum calendar out of what actually traded, which is the
 * right way to know whether 2026-04-03 was a session. That method has one
 * limitation and this module exists for exactly it — it cannot see forward.
 *
 * "The first forward leg resolves on [date]" is a claim about a date that has
 * not happened. Nothing in the observed record can answer it, so the holidays
 * are DECLARED here and the projection is labelled as a projection.
 *
 * ── Why a declared table rather than an API ───────────────────────────
 *
 * `recordSpreads.ts` asks Tradier's market calendar, which is authoritative
 * and correct for its purpose: it runs at capture time and needs to know about
 * TODAY. This runs inside `daily-intelligence`, which is deliberately
 * secret-free, and it needs to know about a Tuesday five weeks out. A ten-row
 * table that a test checks against the observed record beats a network call
 * the nightly job cannot make.
 *
 * ── The table is CHECKED, not asserted ────────────────────────────────
 *
 * `marketCalendar.test.ts` reconciles this list against the bars panel's own
 * quorum calendar over the window they overlap: every weekday the panel has no
 * session for must appear here, and every holiday here that falls inside the
 * panel's span must be absent from it. A wrong or missing date fails the suite
 * rather than silently shifting a projected resolution by a session.
 *
 * The reconciliation is what makes this list evidence instead of a memo. It is
 * also why the list starts in 2025 rather than today — the earlier dates carry
 * no forward value at all and exist only to be checked.
 */

/**
 * NYSE/Nasdaq full closures. Half sessions (the day after Thanksgiving,
 * Christmas Eve when it falls midweek) are deliberately ABSENT: a shortened
 * session is still a session, it still produces a daily bar, and it still
 * advances every horizon measured in sessions.
 *
 * 2025-01-09, the national day of mourning for President Carter, is included
 * for the same reason the fixed holidays are — it was a real closure, and a
 * table that only knows the recurring ones would be wrong in a way nobody
 * would think to look for. It falls outside the current panel span, so the
 * reconciliation test cannot confirm it; it is declared on the record and
 * flagged here as unconfirmed rather than quietly trusted.
 */
export const US_MARKET_HOLIDAYS: readonly string[] = [
  // 2025
  "2025-01-01", // New Year's Day
  "2025-01-09", // National day of mourning — President Carter (unconfirmed by the panel)
  "2025-01-20", // Martin Luther King Jr. Day
  "2025-02-17", // Washington's Birthday
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25", // Christmas
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day observed — the 4th is a Saturday
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth observed — the 19th is a Saturday
  "2027-07-05", // Independence Day observed — the 4th is a Sunday
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas observed — the 25th is a Saturday
];

/**
 * The last date this table can speak for.
 *
 * A projection that runs past it is REFUSED rather than extrapolated. Counting
 * weekdays through an undeclared Thanksgiving would return a date that is
 * wrong by exactly one session and looks exactly like a right one — the same
 * failure mode as a stale panel, which is worth one explicit boundary check to
 * avoid. Extend the table and this moves with it.
 */
export const HOLIDAYS_DECLARED_THROUGH = "2027-12-31";

const HOLIDAY_SET = new Set(US_MARKET_HOLIDAYS);

/** ISO date -> UTC ms at midnight. Parsed as UTC so no local zone can shift it. */
function parseIso(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

const DAY_MS = 86_400_000;

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Whether the US equity market holds a regular session on this date.
 *
 * Weekend or declared holiday means no. Note this answers a CALENDAR question
 * and not a data question: a session can trade and still be missing from the
 * panel because the provider did not serve it.
 */
export function isSessionDate(date: string): boolean {
  const ms = parseIso(date);
  if (Number.isNaN(ms)) return false;
  const dow = new Date(ms).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !HOLIDAY_SET.has(date);
}

export interface Projection {
  /** The projected date, or null when the table cannot reach it. */
  date: string | null;
  /** Why there is no date. Null when there is one. */
  refusedBecause: string | null;
}

/**
 * The date `count` sessions after `from`, on the declared calendar.
 *
 * `from` need not itself be a session — the count is of sessions strictly
 * after it, so passing a Saturday and passing the Friday before it give the
 * same answer, which is the behaviour a caller projecting from "the last
 * session in the panel" wants.
 *
 * `count` of 0 returns `from` unchanged: zero sessions away is here.
 */
export function projectSessionsForward(from: string, count: number): Projection {
  if (count < 0 || !Number.isInteger(count)) {
    return { date: null, refusedBecause: `session count must be a non-negative integer, got ${count}` };
  }
  const startMs = parseIso(from);
  if (Number.isNaN(startMs)) {
    return { date: null, refusedBecause: `"${from}" is not an ISO date` };
  }
  if (count === 0) return { date: from, refusedBecause: null };

  const limitMs = parseIso(HOLIDAYS_DECLARED_THROUGH);
  let ms = startMs;
  let remaining = count;
  while (remaining > 0) {
    ms += DAY_MS;
    if (ms > limitMs) {
      return {
        date: null,
        refusedBecause:
          `projecting ${count} sessions from ${from} runs past ${HOLIDAYS_DECLARED_THROUGH}, ` +
          `the last date the declared holiday table covers`,
      };
    }
    if (isSessionDate(toIso(ms))) remaining--;
  }
  return { date: toIso(ms), refusedBecause: null };
}
