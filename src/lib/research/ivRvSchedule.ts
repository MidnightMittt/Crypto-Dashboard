import { projectSessionsForward } from "./marketCalendar";

/**
 * WHEN THIS COLLECTOR CAN FIRST SAY ANYTHING.
 *
 * `buildIvRvHistory` reports `resolved: 0` and that is the whole of what the
 * IV/RV work currently knows. A zero with no schedule beside it reads as
 * "broken" to anyone who did not write it, and — worse — reads as "any day
 * now" to anyone hoping. Both readings lead somewhere bad: the first to
 * someone re-running a job that is working correctly, the second to someone
 * putting money on a threshold before a single forward leg has landed.
 *
 * So the artefact carries the schedule, and the schedule is arithmetic rather
 * than a promise: an observation resolves exactly `horizonSessions` sessions
 * after the session it was taken on, and the panel says how many of those have
 * elapsed.
 *
 * ── Three states, not two ─────────────────────────────────────────────
 *
 * "Unresolved" hides a distinction that matters. An observation whose forward
 * window has not finished yet WILL resolve. One whose window has finished and
 * still has no number never will — the panel has a gap inside it, and
 * `forwardRvPct` refuses a vol computed across a hole rather than understating
 * it. Counting those together would make the open pile look like a sample
 * still arriving when part of it is permanently lost, and would quietly
 * inflate every projection of how much evidence is coming.
 *
 * ── The count that lands, not just the date ───────────────────────────
 *
 * Observations arrive in cohorts — seventy-odd names recorded on one night —
 * so resolutions arrive in cohorts too. `nextResolutionCount` says how many
 * land on the projected date, which is the difference between "evidence starts
 * trickling in" and "sixty-two rows appear at once". Neither is 62 independent
 * bets: implied vol across this universe moves largely as one factor, and the
 * effective breadth is a fraction of the row count.
 */

export interface ScheduleObservation {
  /** The observation's index in the panel calendar. */
  sessionIndex: number;
  /** Whether its forward leg produced a number. */
  resolved: boolean;
}

export interface ResolutionSchedule {
  /** Sessions the forward leg spans. */
  horizonSessions: number;
  /** Observations joined to the panel. resolved + unresolvable + pending. */
  joined: number;
  /** Forward leg landed. The only rows that can support a conclusion. */
  resolved: number;
  /**
   * Forward window has fully elapsed and still produced nothing — a gap in the
   * panel inside the window. These NEVER resolve and are not waiting on time.
   */
  unresolvable: number;
  /** Forward window has not finished. Will resolve when the bars arrive. */
  pending: number;
  /** Sessions that must still elapse before the earliest pending row lands. */
  sessionsUntilNextResolution: number | null;
  /** How many rows land on that date. Resolutions arrive in cohorts. */
  nextResolutionCount: number;
  /** Projected calendar date of the next resolution, or null if not projectable. */
  projectedNextResolution: string | null;
  /** Why there is no projected date. Null when there is one. */
  projectionNote: string | null;
  /** The panel session the projection counts forward from. */
  projectedFrom: string | null;
}

/**
 * Build the schedule from joined observations and the panel calendar.
 *
 * `lastSessionIndex` is taken from the panel rather than inferred from the
 * observations: the newest observation is not necessarily the newest session,
 * and using it would understate how much of every forward window has already
 * elapsed.
 */
export function buildResolutionSchedule(input: {
  observations: readonly ScheduleObservation[];
  horizonSessions: number;
  sessions: readonly string[];
}): ResolutionSchedule {
  const { observations, horizonSessions, sessions } = input;
  const lastIndex = sessions.length - 1;
  const projectedFrom = lastIndex >= 0 ? sessions[lastIndex] : null;

  let resolved = 0;
  let unresolvable = 0;
  let pending = 0;
  /** Sessions remaining -> how many rows land then. */
  const landings = new Map<number, number>();

  for (const o of observations) {
    if (o.resolved) {
      resolved++;
      continue;
    }
    const remaining = o.sessionIndex + horizonSessions - lastIndex;
    if (remaining <= 0) {
      // Elapsed and still empty: a gap inside the window. Not waiting on time.
      unresolvable++;
      continue;
    }
    pending++;
    landings.set(remaining, (landings.get(remaining) ?? 0) + 1);
  }

  const sessionsUntilNextResolution = landings.size ? Math.min(...landings.keys()) : null;
  const nextResolutionCount =
    sessionsUntilNextResolution === null ? 0 : (landings.get(sessionsUntilNextResolution) ?? 0);

  let projectedNextResolution: string | null = null;
  let projectionNote: string | null = null;
  if (sessionsUntilNextResolution === null) {
    projectionNote =
      pending === 0 && observations.length > 0
        ? "nothing is pending — every joined observation has either resolved or been lost to a gap"
        : "no joined observations to schedule";
  } else if (projectedFrom === null) {
    projectionNote = "the panel has no sessions to project from";
  } else {
    const p = projectSessionsForward(projectedFrom, sessionsUntilNextResolution);
    projectedNextResolution = p.date;
    projectionNote = p.refusedBecause;
  }

  return {
    horizonSessions,
    joined: observations.length,
    resolved,
    unresolvable,
    pending,
    sessionsUntilNextResolution,
    nextResolutionCount,
    projectedNextResolution,
    projectionNote,
    projectedFrom,
  };
}

/**
 * One sentence a trader can act on, generated FROM the schedule so it cannot
 * drift from the counts beside it.
 *
 * The rule this encodes: while `resolved` is zero there is no evidence here of
 * any kind, and the sentence says so before it says anything else. A reader
 * who takes only the first clause should still come away correct.
 */
export function scheduleReading(s: ResolutionSchedule): string {
  const lost =
    s.unresolvable > 0
      ? ` ${s.unresolvable} of the ${s.joined} joined can never resolve — the panel has a gap inside their forward window.`
      : "";

  if (s.joined === 0) {
    return "No implied readings have joined the bars panel yet, so there is nothing to resolve.";
  }

  const when =
    s.projectedNextResolution !== null && s.sessionsUntilNextResolution !== null
      ? `in ${s.sessionsUntilNextResolution} session${s.sessionsUntilNextResolution === 1 ? "" : "s"}, ` +
        `projected ${s.projectedNextResolution}`
      : s.sessionsUntilNextResolution !== null
        ? `in ${s.sessionsUntilNextResolution} sessions — no calendar date, because ${s.projectionNote}`
        : "never";

  if (s.resolved === 0) {
    if (s.pending === 0) {
      return (
        `Nothing has resolved and nothing is pending.${lost} This collector cannot support a ` +
        `threshold, a ranking or a screen, and on current data it never will without more bars.`
      );
    }
    return (
      `NO forward leg has resolved. ${s.pending} observations are waiting on time; the first ` +
      `${s.nextResolutionCount} land ${when}.${lost} Until then nothing here supports a threshold, ` +
      `a ranking or a screen — the ratio is collected, not tested.`
    );
  }

  const more =
    s.pending > 0
      ? ` ${s.pending} still pending, the next ${s.nextResolutionCount} ${when}.`
      : " Nothing further is pending.";
  return (
    `${s.resolved} of ${s.joined} forward legs have resolved.${more}${lost} Judge the sample against ` +
    `the panel's effective breadth rather than its row count — implied vol across this universe ` +
    `moves largely as one factor, so these are far fewer than ${s.resolved} independent bets.`
  );
}
