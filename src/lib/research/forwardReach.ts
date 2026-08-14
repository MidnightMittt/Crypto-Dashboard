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
 *  - Resolution only happens once the full horizon has elapsed. A level
 *    reached on session 3 resolves immediately as a hit; one NOT yet reached
 *    stays open until session 10, because calling it a miss early would
 *    bias every bucket toward failure.
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
  /** Null until the horizon has fully elapsed. */
  reached: boolean | null;
  sessionsToReach: number | null;
  resolvedDate: string | null;
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
  /** Totals across every resolved prediction, the headline honesty number. */
  totals: { resolved: number; reached: number; predictedPct: number | null; observedPct: number | null };
}

export const EMPTY_FORWARD_REACH: ForwardReachRecord = {
  version: 1,
  horizonSessions: REACH_HORIZON_SESSIONS,
  generatedAt: 0,
  predictions: [],
  calibration: [],
  totals: { resolved: 0, reached: 0, predictedPct: null, observedPct: null },
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
 * Resolve every prediction whose horizon has fully elapsed.
 *
 * `barsAfter` supplies the sessions strictly after the registration date for
 * one symbol. A hit is recorded as soon as the level trades; a miss only
 * once the full horizon of sessions exists, so an unfinished window never
 * counts against the rate.
 */
export function resolvePredictions(
  predictions: ReachPrediction[],
  barsAfter: (symbol: string, dateIso: string) => SessionBar[],
  horizon = REACH_HORIZON_SESSIONS
): ReachPrediction[] {
  return predictions.map((p) => {
    if (p.reached !== null) return p;
    const bars = barsAfter(p.symbol, p.date).slice(0, horizon);
    if (bars.length === 0) return p;

    for (let i = 0; i < bars.length; i++) {
      const hit = p.direction === "long" ? bars[i].low <= p.level : bars[i].high >= p.level;
      if (hit) {
        return {
          ...p,
          reached: true,
          sessionsToReach: i + 1,
          resolvedDate: new Date(bars[i].t).toISOString().slice(0, 10),
        };
      }
    }
    // Not reached — but only a MISS once the whole window has passed.
    if (bars.length < horizon) return p;
    return {
      ...p,
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
  const resolved = predictions.filter((p) => p.reached !== null);
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
    },
  };
}

/**
 * Keep the file bounded without discarding evidence: resolved predictions
 * are the record and are dropped oldest-first only past the cap, while open
 * ones are always kept because they have not had their say yet.
 */
export const MAX_PREDICTIONS = 60_000;

export function prune(predictions: ReachPrediction[], cap = MAX_PREDICTIONS): ReachPrediction[] {
  if (predictions.length <= cap) return predictions;
  const open = predictions.filter((p) => p.reached === null);
  const closed = predictions
    .filter((p) => p.reached !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const keepClosed = closed.slice(Math.max(0, closed.length - Math.max(0, cap - open.length)));
  return [...keepClosed, ...open];
}
