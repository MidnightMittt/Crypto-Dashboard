/**
 * PIPELINE LIVENESS — did the machinery behind these numbers actually run?
 *
 * A terminal that looks live when it is not discredits every number on it.
 * This module exists because that failure happened here and nothing said so:
 * `daily-intelligence` has never once completed a green SCHEDULED run — two
 * scheduled attempts failed, the single success was a manual dispatch — and
 * the signal ledger sat at three entries for days. It was found by running
 * `git log` by hand. From the site, everything looked fine.
 *
 * So the pipeline reports on itself, in the dossier, where a reader is
 * already deciding how much to trust the page.
 *
 * ── Counting sessions, conservatively ─────────────────────────────────
 *
 * "Behind" is counted in WEEKDAYS strictly between the last update and today,
 * excluding both ends. Friday's data read on Sunday is 0 behind — no session
 * has closed since. Read on Monday it is still 0, because Monday's close has
 * not happened and a job that runs after it cannot be late yet. Read on
 * Tuesday it is 1: Monday was missed.
 *
 * That deliberately errs toward silence. A staleness warning that fires on a
 * Monday morning for a store that is working perfectly trains the reader to
 * ignore it, and an ignored warning is worse than none. There is no holiday
 * calendar, which errs the same way — a store is never called late because of
 * Thanksgiving.
 */

/** A store the daily pipeline is supposed to append to. */
export interface StoreInput {
  /** The file, so a reader can go and look. */
  store: string;
  /** What it feeds, in the reader's words rather than the filename's. */
  what: string;
  /** ISO date (YYYY-MM-DD) of its most recent content. Null = never written. */
  lastUpdate: string | null;
}

export type LivenessStatus = "current" | "late" | "stale" | "never";

export interface StoreLiveness extends StoreInput {
  /** Weekdays missed. Null when the store has never been written. */
  sessionsBehind: number | null;
  status: LivenessStatus;
}

export interface LivenessRead {
  stores: StoreLiveness[];
  /** The worst store's lag — the number that decides the headline. */
  worstSessionsBehind: number | null;
  /** How many stores are not current. */
  degraded: number;
  asOf: string;
}

/**
 * One missed session is a hiccup; two is a pattern; four is a week of silence.
 * Declared rather than inlined so the thresholds can be argued with.
 */
export const LATE_AFTER_SESSIONS = 1;
export const STALE_AFTER_SESSIONS = 3;

const DAY_MS = 86_400_000;

/** Weekdays strictly between two UTC dates, excluding both endpoints. */
export function weekdaysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  let count = 0;
  for (let t = from + DAY_MS; t < to; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function statusOf(sessionsBehind: number): LivenessStatus {
  if (sessionsBehind > STALE_AFTER_SESSIONS) return "stale";
  if (sessionsBehind > LATE_AFTER_SESSIONS) return "late";
  return "current";
}

/**
 * Assess every declared store against today.
 *
 * `nowIso` is passed rather than read from the clock so this is testable and
 * so the caller decides what "today" means — the same discipline the rest of
 * the platform applies to as-of dates.
 */
export function assessLiveness(stores: StoreInput[], nowIso: string): LivenessRead {
  const assessed: StoreLiveness[] = stores.map((s) => {
    if (!s.lastUpdate) return { ...s, sessionsBehind: null, status: "never" as const };
    const behind = weekdaysBetween(s.lastUpdate, nowIso);
    return { ...s, sessionsBehind: behind, status: statusOf(behind) };
  });

  const measured = assessed
    .map((s) => s.sessionsBehind)
    .filter((n): n is number => n !== null);

  return {
    stores: assessed,
    worstSessionsBehind: measured.length ? Math.max(...measured) : null,
    degraded: assessed.filter((s) => s.status !== "current").length,
    asOf: nowIso,
  };
}

/**
 * One sentence a reader can act on.
 *
 * Never "all systems operational" — that is a claim about the future. It
 * states what was last written and when, which is the only thing actually
 * known.
 */
export function describeLiveness(read: LivenessRead): string {
  if (read.stores.length === 0) return "No pipeline stores are declared for this page.";
  const never = read.stores.filter((s) => s.status === "never");
  if (never.length === read.stores.length) {
    return "None of the daily stores behind this page has ever been written.";
  }
  if (read.degraded === 0) {
    return `Every daily store is current as of ${read.asOf}; the most recent session has been recorded in all of them.`;
  }
  const worst = read.stores
    .filter((s) => s.status !== "current")
    .map((s) => `${s.what} (${s.sessionsBehind ?? "never"} behind)`)
    .join(", ");
  return `${read.degraded} of ${read.stores.length} daily stores are behind: ${worst}. Numbers drawn from them describe an older session than today's.`;
}
