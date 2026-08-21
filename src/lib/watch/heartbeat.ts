/**
 * DID THE WATCHDOG RUN, OR IS IT JUST QUIET?
 *
 * The watchdog has never fired an alert. That single fact is consistent with
 * three completely different situations:
 *
 *   1. It runs every few minutes and no level has been crossed. Working.
 *   2. It has never run at all — cron misconfigured, workflow disabled, the
 *      401 path. Broken, and silently.
 *   3. It runs but every quote is too stale to judge, so every level is
 *      skipped. Broken in the way that looks most like working.
 *
 * From outside, all three produce identical silence. A monitoring system whose
 * failure mode is indistinguishable from its success mode is not monitoring
 * anything, and this is the same defect that produced four wasted days here:
 * a success signal that does not name its subject.
 *
 * So each sweep records what it actually did, and this module turns that
 * record into a claim precise enough to be wrong: not "healthy", but "last
 * swept 4 minutes ago, 3 levels armed, 3 quotes fresh, 0 fired since armed".
 */

/** One sweep's own account of itself. */
export interface SweepRecord {
  /** When the sweep ran, ISO. */
  at: string;
  /** Levels armed at the time of the sweep. */
  armed: number;
  /** Levels whose quote was fresh enough to actually judge. */
  judged: number;
  /** Levels that crossed and fired an alert this sweep. */
  fired: number;
  /** Levels skipped because their quote was too old to trust. */
  skippedStale: number;
}

/**
 * How long the sweep may go silent before something is wrong.
 *
 * The workflow stages five crons across each hour and each one loops
 * internally, so a healthy gap is minutes. Observed GitHub cron drift in this
 * repo runs 41-123 minutes, though, so the threshold has to tolerate a late
 * start without excusing a dead scheduler. Two hours is longer than the worst
 * drift measured and far shorter than a day of silence.
 */
export const SWEEP_SILENT_AFTER_MINUTES = 120;

export type SweepHealth = "never_ran" | "silent" | "blind" | "watching";

export interface SweepLiveness {
  health: SweepHealth;
  lastSweptAt: string | null;
  minutesSinceSweep: number | null;
  armed: number;
  /** Alerts fired across the retained record. Zero is not automatically bad. */
  firedRecently: number;
  sentence: string;
}

/**
 * Turn the sweep record into a claim that can be checked.
 *
 * `blind` is the state worth building this for: the sweep is running, on time,
 * and judging nothing because every quote is stale. It reports zero fires
 * exactly like a healthy quiet market does, and without this it would never
 * be caught.
 */
export function assessSweepLiveness(
  records: readonly SweepRecord[],
  now: Date = new Date()
): SweepLiveness {
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at));
  const last = sorted[sorted.length - 1];

  if (!last) {
    return {
      health: "never_ran",
      lastSweptAt: null,
      minutesSinceSweep: null,
      armed: 0,
      firedRecently: 0,
      sentence:
        "The watchdog has NEVER RUN. No sweep has ever recorded itself, so every armed level is " +
        "unwatched and the absence of alerts means nothing. Check that the workflow is enabled " +
        "and that its secret matches production — a 401 leaves exactly this trace.",
    };
  }

  const ms = now.getTime() - Date.parse(last.at);
  const minutes = Math.floor(ms / 60_000);
  const firedRecently = sorted.reduce((s, r) => s + r.fired, 0);

  if (minutes > SWEEP_SILENT_AFTER_MINUTES) {
    return {
      health: "silent",
      lastSweptAt: last.at,
      minutesSinceSweep: minutes,
      armed: last.armed,
      firedRecently,
      sentence:
        `The watchdog last swept ${minutes} minutes ago, past the ${SWEEP_SILENT_AFTER_MINUTES}-minute ` +
        `limit. ${last.armed} level${last.armed === 1 ? " is" : "s are"} armed and NOT being watched. ` +
        `Any level crossed since then passed unnoticed.`,
    };
  }

  /*
   * Running, on time, and judging nothing. The dangerous state: it reports the
   * same zero fires that a quiet healthy market does.
   */
  if (last.armed > 0 && last.judged === 0) {
    return {
      health: "blind",
      lastSweptAt: last.at,
      minutesSinceSweep: minutes,
      armed: last.armed,
      firedRecently,
      sentence:
        `The watchdog swept ${minutes} minutes ago but could judge NONE of its ${last.armed} armed ` +
        `level${last.armed === 1 ? "" : "s"} — every quote was too stale to trust, so all were ` +
        `skipped. It is running and blind, which produces the same silence as a quiet market. ` +
        `The quote feed is the thing to check, not the scheduler.`,
    };
  }

  return {
    health: "watching",
    lastSweptAt: last.at,
    minutesSinceSweep: minutes,
    armed: last.armed,
    firedRecently,
    sentence:
      `The watchdog swept ${minutes} minute${minutes === 1 ? "" : "s"} ago and judged ${last.judged} ` +
      `of ${last.armed} armed level${last.armed === 1 ? "" : "s"} against a fresh quote` +
      (last.skippedStale > 0 ? `, skipping ${last.skippedStale} on a stale one` : "") +
      `. ${firedRecently} alert${firedRecently === 1 ? " has" : "s have"} fired across the retained ` +
      `record. It is watching — zero fires here means no level was crossed, not that nothing ran.`,
  };
}
