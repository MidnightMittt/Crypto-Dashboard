import { SessionModel } from "./types";

/**
 * SESSION-DATE NORMALISATION — the canonical period key for panel
 * clustering.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The panel estimator clusters contemporaneous observations by a `period`
 * key so their cross-sectional dependence is preserved. Until now that key
 * was the raw bar timestamp, which works only while every instrument is
 * sampled at the same instant — true for a crypto-only universe, false the
 * moment anything else arrives.
 *
 * The failure is silent and it inflates confidence, which is the worst
 * combination. A US equity closing at 16:00 ET and a crypto perp closing at
 * 00:00 UTC would land in different periods, be treated as independent, and
 * produce an overstated effective sample — the exact error the panel
 * estimator was built to prevent, reintroduced through the key.
 *
 * ── The rule ────────────────────────────────────────────────────────────
 *
 *   A bar belongs to the calendar date, IN ITS OWN SESSION TIMEZONE, of the
 *   instant immediately before its close.
 *
 * One rule, and it resolves every case correctly:
 *
 *   - A crypto daily bar closing Tuesday 00:00 UTC covers Monday's trading.
 *     Stepping back 1ms lands on Monday 23:59:59.999 UTC → session Monday.
 *     Keying on the raw close would have called it Tuesday, misaligning it
 *     by a full day against every session-based market.
 *   - A US equity bar closing Monday 16:00 ET covers Monday. Stepping back
 *     1ms stays on Monday in ET → session Monday. The two now agree.
 *   - An FX bar closing Monday 17:00 ET covers Sunday 17:00 → Monday 17:00,
 *     conventionally "Monday". Same rule, same answer.
 *
 * The 1ms step is what makes midnight-boundary closes correct rather than
 * off by one, and it costs nothing.
 *
 * ── Why timezone-aware rather than a fixed UTC offset ───────────────────
 *
 * US sessions shift between EST and EDT, so a fixed offset is wrong for
 * roughly half the year — and wrong in a way that would silently split one
 * session into two period keys across the DST boundary. `Intl` performs the
 * real zone arithmetic, including historical DST rules, and is deterministic
 * for a given (timestamp, zone) pair.
 */

/** Formatters are expensive to construct and this runs per observation, so one is cached per zone. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(timeZone, created);
  return created;
}

/**
 * Calendar date of `t` in `timeZone`, as `YYYY-MM-DD`.
 *
 * `en-CA` is used because it formats as ISO-8601 by default, which avoids
 * parsing locale-dependent part ordering.
 */
export function calendarDateInZone(t: number, timeZone: string): string {
  return formatterFor(timeZone).format(new Date(t));
}

/**
 * The canonical period key for a bar closing at `t`.
 *
 * Returns UTC midnight of the session date as an epoch, so keys are plain
 * comparable numbers, sort chronologically, and are stable across machines
 * regardless of the local zone the process happens to run in.
 */
export function sessionPeriodKey(t: number, session: SessionModel): number {
  // Step back one millisecond so a close landing exactly on a date boundary
  // is attributed to the session it completes, not the one it opens.
  const iso = calendarDateInZone(t - 1, session.timezone);
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Human-readable session date, for reports and diagnostics. Same rule as
 * `sessionPeriodKey`, so the two can never disagree about which session a
 * bar belongs to.
 */
export function sessionDateLabel(t: number, session: SessionModel): string {
  return calendarDateInZone(t - 1, session.timezone);
}

/**
 * Do two bars from differently-scheduled instruments belong to the same
 * trading session? Provided so the alignment question can be asked directly
 * rather than by comparing two keys and hoping the caller got the rule right.
 */
export function sameSession(
  aT: number,
  aSession: SessionModel,
  bT: number,
  bSession: SessionModel
): boolean {
  return sessionPeriodKey(aT, aSession) === sessionPeriodKey(bT, bSession);
}
