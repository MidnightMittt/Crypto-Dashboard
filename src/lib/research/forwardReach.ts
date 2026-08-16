/**
 * FORWARD SCORING — the only thing that turns "measured" into "validated".
 *
 * Every number this platform publishes about equities is in-sample: the
 * replay walked one fixed history and reported what happened in it. That is
 * honest and it is useful, but it is not evidence about the next trade. A
 * backtest can only ever be a hypothesis; the test is what happens after the
 * hypothesis was written down.
 *
 * This module is that record for the crispest claim the page makes. When a
 * ticker page says "a level this far away was reached 71% of the time within
 * ten sessions", that is a falsifiable prediction with a two-week horizon.
 * So it gets registered, resolved against what price actually did, and
 * scored — predicted against observed, out of sample, no exceptions.
 *
 * ── Why the reach rate and not the win rate ───────────────────────────
 *
 * Because it resolves fastest and cleanest. A win rate needs an entry, an
 * exit rule, costs and a holding period before it means anything; a reach
 * rate needs one question answered by the high and low of ten daily bars.
 * Fast feedback on a clean claim beats slow feedback on a compound one, and
 * the machinery generalises to the slower claims once it is proven here.
 *
 * ── The rules that keep it honest ─────────────────────────────────────
 *
 *  - A prediction is registered with the probability the page ACTUALLY
 *    showed, frozen at registration. Re-deriving it at scoring time would
 *    let a later model change rewrite its own history.
 *  - Registration is idempotent per (date, symbol, direction): re-running
 *    the daily job replaces rather than duplicates, so a retry cannot stuff
 *    the sample.
 *  - An outcome is OBSERVED as soon as it happens and COUNTED only once its
 *    window closes. See below — this cost us the first published number.
 *
 * ── The censoring bug, and why it published 100% ──────────────────────
 *
 * The original rule resolved a hit the session the level traded, but a miss
 * only after the full ten sessions. Both halves were defended in the comment
 * that used to sit here: calling a not-yet-reached level a miss early would
 * bias every bucket toward failure. True — and it missed the mirror image.
 * Hits and misses were entering the sample on DIFFERENT SCHEDULES, so at any
 * moment the scored set held every hit so far plus only those misses old
 * enough to have finished. That is classic right-censoring, and it points in
 * the flattering direction, which is what made it dangerous.
 *
 * It was not theoretical. On 2026-08-16 the record read 38 resolved, 38
 * reached — 100.0% delivered against 85.4% promised — and every one of those
 * 38 was three or four days old against a ten-session horizon. Zero had a
 * finished window. The rate was not a measurement of anything; a three-day-old
 * cohort can contain nothing but hits by construction. The misses from those
 * same windows were sitting in the "open" pile waiting for day ten.
 *
 * So: `reached` still records what price did the moment it does it — that
 * observation is real and worth keeping — but `windowComplete` is what admits
 * a prediction to the sample, and `summarise` counts nothing else. Numerator
 * and denominator now describe the same set.
 *
 * This is the only claim here that could develop the bias, which is worth
 * knowing when the next one is added: a forward RETURN (see forwardVerdict)
 * is undefined before its horizon, so it has nowhere to leak. A reach is a
 * path-dependent EVENT, observable early, and every claim shaped like one
 * needs this same guard.
 */

export const REACH_HORIZON_SESSIONS = 10;

export interface ReachPrediction {
  /** ISO date the prediction was registered — the day the page said it. */
  date: string;
  symbol: string;
  /** long = support below price, short = resistance above it. */
  direction: "long" | "short";
  level: number;
  distanceAtr: number;
  /** The published bucket this was quoted from. */
  distanceAtrMax: number;
  touchesMin: number;
  /** The probability the page showed, frozen at registration. */
  predictedPct: number;
  /**
   * What price has done SO FAR. A hit is recorded the session the level
   * trades; a miss cannot be known before the window closes. This is an
   * observation, not an admission to the sample — see `windowComplete`.
   */
  reached: boolean | null;
  sessionsToReach: number | null;
  resolvedDate: string | null;
  /** Sessions of price that exist after the registration date, capped at the horizon. */
  sessionsObserved: number;
  /**
   * THE GATE. True once the full horizon has elapsed, at which point the row
   * is frozen and counts. A hit with an open window is real but uncounted,
   * because its cohort's misses have not had their chance to appear yet.
   */
  windowComplete: boolean;
}

export interface ReachCalibrationCell {
  distanceAtrMax: number;
  touchesMin: number;
  predictedPct: number;
  observedPct: number;
  resolved: number;
  reached: number;
}

export interface ForwardReachRecord {
  version: 1;
  horizonSessions: number;
  generatedAt: number;
  predictions: ReachPrediction[];
  calibration: ReachCalibrationCell[];
  /**
   * Totals across every COMPLETED window, the headline honesty number.
   *
   * `open` and `openReached` describe the rest: predictions registered but
   * not yet finished, and how many of those have already touched their level.
   * They are reported rather than hidden — `openReached / open` is a lower
   * bound on where that cohort will land, and quoting it AS the rate is
   * precisely the mistake this record made once already.
   */
  totals: {
    resolved: number;
    reached: number;
    predictedPct: number | null;
    observedPct: number | null;
    open: number;
    openReached: number;
  };
}

export const EMPTY_FORWARD_REACH: ForwardReachRecord = {
  version: 1,
  horizonSessions: REACH_HORIZON_SESSIONS,
  generatedAt: 0,
  predictions: [],
  calibration: [],
  totals: { resolved: 0, reached: 0, predictedPct: null, observedPct: null, open: 0, openReached: 0 },
};

function keyOf(p: { date: string; symbol: string; direction: string }): string {
  return `${p.date}|${p.symbol}|${p.direction}`;
}

/**
 * Add today's predictions, replacing any already registered for the same
 * day, symbol and side. Existing resolutions are never disturbed.
 */
export function registerPredictions(
  existing: ReachPrediction[],
  fresh: ReachPrediction[]
): ReachPrediction[] {
  const byKey = new Map(existing.map((p) => [keyOf(p), p]));
  for (const p of fresh) {
    const prior = byKey.get(keyOf(p));
    // A resolved prediction is history and stays exactly as it was.
    if (prior && prior.reached !== null) continue;
    byKey.set(keyOf(p), p);
  }
  return [...byKey.values()];
}

export interface SessionBar {
  t: number;
  high: number;
  low: number;
}

/**
 * Advance every prediction whose window is still open.
 *
 * `barsAfter` supplies the sessions strictly after the registration date for
 * one symbol. A hit is recorded the session the level trades and a miss can
 * only be known at the end — but NEITHER is admitted to the sample until
 * `windowComplete`, so the two outcomes are never counted on different
 * clocks. Once complete a row is frozen and never re-read, which also means
 * a later data revision cannot rewrite settled history.
 */
export function resolvePredictions(
  predictions: ReachPrediction[],
  barsAfter: (symbol: string, dateIso: string) => SessionBar[],
  horizon = REACH_HORIZON_SESSIONS
): ReachPrediction[] {
  return predictions.map((p) => {
    if (p.windowComplete) return p;
    const bars = barsAfter(p.symbol, p.date).slice(0, horizon);
    const windowComplete = bars.length >= horizon;
    const observed = { ...p, sessionsObserved: bars.length, windowComplete };

    /*
     * A hit already on the books stays on the books. Re-scanning would find
     * the same session anyway; short-circuiting makes it impossible for a
     * revised bar to un-hit a level that demonstrably traded.
     */
    if (p.reached === true) return observed;

    for (let i = 0; i < bars.length; i++) {
      const hit = p.direction === "long" ? bars[i].low <= p.level : bars[i].high >= p.level;
      if (hit) {
        return {
          ...observed,
          reached: true,
          sessionsToReach: i + 1,
          resolvedDate: new Date(bars[i].t).toISOString().slice(0, 10),
        };
      }
    }
    // Not reached — and only a MISS once the whole window has passed.
    if (!windowComplete) return observed;
    return {
      ...observed,
      reached: false,
      sessionsToReach: null,
      resolvedDate: new Date(bars[bars.length - 1].t).toISOString().slice(0, 10),
    };
  });
}

/** Fewer resolved than this and the cell is not published — the same discipline the in-sample tables use. */
export const MIN_FORWARD_N = 30;

export function summarise(predictions: ReachPrediction[]): {
  calibration: ReachCalibrationCell[];
  totals: ForwardReachRecord["totals"];
} {
  /*
   * COMPLETED WINDOWS ONLY. Not `reached !== null` — that set is enriched
   * with hits, because a hit can be observed on session 1 while a miss from
   * the same day is still waiting for session 10.
   */
  const resolved = predictions.filter((p) => p.windowComplete);
  const open = predictions.filter((p) => !p.windowComplete);
  const groups = new Map<string, ReachPrediction[]>();
  for (const p of resolved) {
    const k = `${p.distanceAtrMax}|${p.touchesMin}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  const calibration: ReachCalibrationCell[] = [];
  for (const [, group] of groups) {
    if (group.length < MIN_FORWARD_N) continue;
    const reached = group.filter((p) => p.reached).length;
    calibration.push({
      distanceAtrMax: group[0].distanceAtrMax,
      touchesMin: group[0].touchesMin,
      // The average of what was PROMISED, so the comparison is like for like.
      predictedPct: group.reduce((s, p) => s + p.predictedPct, 0) / group.length,
      observedPct: (reached / group.length) * 100,
      resolved: group.length,
      reached,
    });
  }
  calibration.sort((a, b) => a.distanceAtrMax - b.distanceAtrMax || a.touchesMin - b.touchesMin);

  const reachedAll = resolved.filter((p) => p.reached).length;
  return {
    calibration,
    totals: {
      resolved: resolved.length,
      reached: reachedAll,
      predictedPct: resolved.length
        ? resolved.reduce((s, p) => s + p.predictedPct, 0) / resolved.length
        : null,
      observedPct: resolved.length ? (reachedAll / resolved.length) * 100 : null,
      open: open.length,
      openReached: open.filter((p) => p.reached === true).length,
    },
  };
}

/**
 * Keep the file bounded without discarding evidence: completed windows are
 * the record and are dropped oldest-first only past the cap, while open ones
 * are always kept because they have not had their say yet.
 *
 * Open means the WINDOW is open, not that the outcome is unknown. A level hit
 * on session 2 is still owed its remaining eight sessions before it counts,
 * and pruning it as though it were settled would drop exactly the rows whose
 * cohort-mates are the misses — reintroducing the censoring from the other end.
 */
export const MAX_PREDICTIONS = 60_000;

export function prune(predictions: ReachPrediction[], cap = MAX_PREDICTIONS): ReachPrediction[] {
  if (predictions.length <= cap) return predictions;
  const open = predictions.filter((p) => !p.windowComplete);
  const closed = predictions
    .filter((p) => p.windowComplete)
    .sort((a, b) => a.date.localeCompare(b.date));
  const keepClosed = closed.slice(Math.max(0, closed.length - Math.max(0, cap - open.length)));
  return [...keepClosed, ...open];
}
