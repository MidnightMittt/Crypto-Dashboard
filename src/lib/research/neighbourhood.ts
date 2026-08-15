import { Neighbour, summariseIndependence } from "./fingerprint";

/**
 * WHAT HAPPENED NEXT, in the environments most like this one.
 *
 * The broad-bucket analogs this replaces reported "71,585 times seen" for
 * NVDA. That number was arithmetically correct and completely misleading:
 * it counted the same market environments thousands of times over, once per
 * correlated instrument and once per overlapping window. A reader seeing
 * five figures reasonably concludes the finding is settled.
 *
 * So every statistic here is reported against `effectiveN` — the count after
 * correlation and overlap are charged for — and the raw match count is shown
 * beside it rather than instead of it. If the two differ by an order of
 * magnitude, that gap IS the finding, and the summary says so.
 */

/** What a single historical neighbour actually did next. */
export interface NeighbourOutcome {
  /** Return over the fixed forward horizon, in percent. */
  forwardReturnPct: number;
  /** Worst drawdown before the horizon ended (negative), in percent. */
  maxAdversePct: number;
  /** Best excursion reached before the horizon ended, in percent. */
  maxFavourablePct: number;
  /** Sessions until the position resolved, when it did. */
  sessionsHeld: number | null;
}

export interface NeighbourhoodStats {
  matches: number;
  effectiveN: number;
  /** Distinct time periods the matches fall into. */
  episodes: number;
  /** Distinct instruments contributing. */
  instruments: number;

  medianReturnPct: number;
  meanReturnPct: number;
  /** Share that ended the horizon positive, in percent. */
  positiveRatePct: number;
  /**
   * Mean return of the WHOLE library over the same horizon — the return of
   * picking a day at random. Every claim below is stated against this, never
   * against zero.
   */
  baselineReturnPct: number;
  /** Median minus baseline. What the fingerprint actually added. */
  edgeVsBaselinePct: number;

  /** p80 of the drawdown endured, the number a stop has to survive. */
  typicalDrawdownPct: number;
  /** p75 of how far the winners ran. */
  typicalRunPct: number;
  medianSessionsHeld: number | null;

  /** How far the nearest and furthest accepted neighbours sat. */
  nearestDistance: number;
  furthestDistance: number;

  independenceLine: string;
  /** The one honest sentence about what this sample can support. */
  summary: string;
}

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

const median = (xs: number[]): number => quantile([...xs].sort((a, b) => a - b), 0.5);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * The minimum effective sample worth quoting a probability from.
 *
 * Not the raw match count — that is exactly the number this module refuses
 * to trust. Below this the neighbourhood is reported as too thin to support
 * a claim, which is a finding rather than a failure.
 */
export const MIN_EFFECTIVE_N = 8;

export function summariseNeighbourhood(
  neighbours: Neighbour<NeighbourOutcome>[],
  options: {
    /** Mean forward return across the WHOLE library, over the same horizon. */
    baselineReturnPct: number;
    /** Correlation between instruments in the panel, measured not assumed. */
    rho: number;
    windowDays: number;
    forwardHorizonDays: number;
  }
): NeighbourhoodStats | null {
  if (neighbours.length === 0) return null;

  const returns = neighbours.map((n) => n.outcome.forwardReturnPct);
  const independence = summariseIndependence(
    neighbours.map((n) => n.fingerprint.date),
    neighbours.map((n) => n.fingerprint.symbol),
    options.rho,
    options.windowDays,
    options.forwardHorizonDays
  );

  const med = median(returns);
  const drawdowns = neighbours.map((n) => Math.abs(n.outcome.maxAdversePct)).sort((a, b) => a - b);
  const runs = neighbours
    .filter((n) => n.outcome.forwardReturnPct > 0)
    .map((n) => n.outcome.maxFavourablePct)
    .sort((a, b) => a - b);
  const held = neighbours.map((n) => n.outcome.sessionsHeld).filter((x): x is number => x !== null);
  const distances = neighbours.map((n) => n.distance);

  const stats: NeighbourhoodStats = {
    matches: neighbours.length,
    effectiveN: independence.effectiveN,
    episodes: independence.episodes,
    instruments: new Set(neighbours.map((n) => n.fingerprint.symbol)).size,

    medianReturnPct: med,
    meanReturnPct: mean(returns),
    positiveRatePct: (returns.filter((r) => r > 0).length / returns.length) * 100,
    baselineReturnPct: options.baselineReturnPct,
    edgeVsBaselinePct: med - options.baselineReturnPct,

    typicalDrawdownPct: quantile(drawdowns, 0.8),
    typicalRunPct: runs.length > 0 ? quantile(runs, 0.75) : 0,
    medianSessionsHeld: held.length > 0 ? Math.round(median(held)) : null,

    nearestDistance: Math.min(...distances),
    furthestDistance: Math.max(...distances),

    independenceLine: independence.line,
    summary: "",
  };

  stats.summary = composeSummary(stats);
  return stats;
}

/**
 * The sentence a reader stops at.
 *
 * Leads with whichever fact most changes what they should do. A thin
 * effective sample outranks a good-looking median, because a median drawn
 * from two independent observations is not a finding however attractive it
 * looks — and the raw count sitting next to it is precisely what would
 * mislead them.
 */
function composeSummary(s: NeighbourhoodStats): string {
  if (s.effectiveN < MIN_EFFECTIVE_N) {
    return `${s.matches} similar environments were found, but they cluster into ${s.episodes} periods across ${s.instruments} instruments that move together — worth about ${s.effectiveN.toFixed(1)} independent observations. That is too thin to quote a probability from, so the distribution below is shown as description rather than as evidence.`;
  }

  const direction = s.edgeVsBaselinePct > 0 ? "better" : "worse";
  const magnitude = Math.abs(s.edgeVsBaselinePct);

  /*
   * An edge inside a fifth of a percent is not an edge at a sample this
   * size; calling it one would be reading noise as signal.
   */
  if (magnitude < 0.2) {
    return `Across ${s.effectiveN.toFixed(0)} independent similar environments the median return was ${fmt(s.medianReturnPct)}, essentially the same as the ${fmt(s.baselineReturnPct)} a random day over the same horizon produced. Being in this environment did not, historically, change the odds.`;
  }

  return `Across ${s.effectiveN.toFixed(0)} independent similar environments the median return was ${fmt(s.medianReturnPct)} — ${magnitude.toFixed(1)} points ${direction} than the ${fmt(s.baselineReturnPct)} a random day produced over the same horizon. ${s.positiveRatePct.toFixed(0)}% ended positive, and the typical one drew down ${s.typicalDrawdownPct.toFixed(1)}% first.`;
}

const fmt = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
