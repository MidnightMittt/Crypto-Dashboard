/**
 * HOW OLD IS THIS PRICE, IN SESSIONS — stated, never inferred.
 *
 * The failure this exists to prevent was observed, not imagined. On
 * 2026-08-20 `/api/asset/CIFR` served a close from 2026-08-14 with no
 * indication of its age. By the afternoon that number was 3.6% from the
 * live price, which looks tolerable; the same number had been 10.6% wrong
 * that morning. The value had drifted back toward the truth by coincidence,
 * and a consumer sampling it at the wrong moment would have had no way to
 * tell an accurate price from a lucky one.
 *
 * So staleness here is a statement about PROVENANCE, never about agreement.
 * A stale price that happens to match the tape is still stale, and this
 * module will say so. Nothing in it looks at the value.
 *
 * ── Why sessions rather than hours ────────────────────────────────────
 *
 * A daily close is expected to be up to one calendar day old during the
 * session that follows it — that is the datum working correctly, not decay.
 * Wall-clock age cannot express that: it reports a healthy Friday close as
 * "72 hours old" on Monday morning. Trading sessions are the unit in which
 * the question "should this have been updated by now?" has an answer.
 */

/** Sessions behind at or above which the price is no longer the latest close. */
export const STALE_AT_SESSIONS = 1;

export interface PriceStaleness {
  /**
   * Completed trading sessions between the price's own session and the most
   * recent completed one. 0 means this IS the latest close.
   */
  ageSessions: number;
  stale: boolean;
  /** What is wrong and what it means, when stale. Null when current. */
  reason: string | null;
  /** The session the price should have been, so a consumer can check our arithmetic. */
  latestCompletedSession: string;
}

/**
 * Wall-clock date in US market time, which is the clock sessions are named by.
 *
 * Exported because more than one subsystem needs "what time is it where the
 * market is", and a second copy of this would drift from this one. Timezone
 * arithmetic done twice is timezone arithmetic done differently.
 */
export function easternDate(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** US regular close, 16:00 ET. A session is only "completed" after it. */
const CLOSE_HOUR_ET = 16;

export const isWeekend = (iso: string): boolean => {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

const shiftDays = (iso: string, delta: number): string =>
  new Date(new Date(`${iso}T12:00:00Z`).getTime() + delta * 86_400_000).toISOString().slice(0, 10);

/**
 * The most recent session whose close has happened.
 *
 * Holidays are NOT modelled. That makes this over-report staleness by one
 * session on a market holiday — the safe direction, since the consequence is
 * a consumer declining to trust a price rather than trusting a stale one.
 * Under-reporting would be the dangerous error and is not possible here.
 */
export function latestCompletedSession(now: Date): string {
  const { date, hour } = easternDate(now);
  let candidate = hour >= CLOSE_HOUR_ET && !isWeekend(date) ? date : shiftDays(date, -1);
  while (isWeekend(candidate)) candidate = shiftDays(candidate, -1);
  return candidate;
}

/** Weekdays strictly after `from`, up to and including `to`. Zero if `to` <= `from`. */
export function sessionsBetween(from: string, to: string): number {
  let count = 0;
  let cursor = shiftDays(from, 1);
  // Bounded: a gap this large is a broken pipeline, not a stale file, and the
  // caller gets a number big enough to act on either way.
  for (let guard = 0; cursor <= to && guard < 400; guard++) {
    if (!isWeekend(cursor)) count++;
    cursor = shiftDays(cursor, 1);
  }
  return count;
}

export function assessPriceStaleness(priceAsOf: string | null, now: Date): PriceStaleness {
  const latest = latestCompletedSession(now);
  if (priceAsOf === null) {
    return {
      ageSessions: 0,
      stale: true,
      reason: "No price at all: this symbol has no usable close in the committed bars panel.",
      latestCompletedSession: latest,
    };
  }

  const ageSessions = sessionsBetween(priceAsOf, latest);
  if (ageSessions < STALE_AT_SESSIONS) {
    return { ageSessions, stale: false, reason: null, latestCompletedSession: latest };
  }

  const plural = ageSessions === 1 ? "session" : "sessions";
  return {
    ageSessions,
    stale: true,
    reason:
      `This close is from ${priceAsOf}, ${ageSessions} trading ${plural} behind the latest ` +
      `completed session (${latest}). Do not size or trigger from it. Its distance from the ` +
      `live price is unknown and is not bounded by how close it happens to look — the same ` +
      `figure can read 10% wrong in the morning and 4% wrong by the afternoon without ` +
      `becoming any more current.`,
    latestCompletedSession: latest,
  };
}
