/**
 * Overlap-aware inference. Every statistic in this repo's backtest reports
 * has, until now, treated its observations as independent. Most of them are
 * not, and the error is not small.
 *
 * ── The problem, concretely ─────────────────────────────────────────────
 *
 * A 30-day forward return sampled once per day shares 29 of its 30 days
 * with the observation before it. A trade opened daily and held for a week
 * overlaps the six trades around it. In both cases N daily rows encode far
 * fewer than N independent facts about the world, yet `signTestPValue(n,
 * wins)` in metrics.ts is handed the raw N and returns a p-value computed
 * as if every row were a fresh coin flip. The resulting p-values are
 * optimistic by roughly a factor of sqrt(overlap), which is how a 30-day
 * result can read p<0.01 while carrying nothing like that much evidence.
 *
 * This was not a theoretical concern when it was found: correcting for it
 * REVERSED the conclusion of the Phase 6 weekly-regime study (see
 * weeklyRegimeStudy.md's own R5e), where 1,382 "trades" turned out to be
 * 438 independent ones and a large apparent effect disappeared.
 *
 * ── What this module does about it ──────────────────────────────────────
 *
 * Two complementary tools, deliberately both, because they fail differently:
 *
 *   1. `movingBlockBootstrap` — resamples contiguous BLOCKS rather than
 *      individual points, so the dependence inside a block is carried into
 *      every resample. Uses all the data. This is the standard econometric
 *      treatment for overlapping returns and is the one to quote.
 *   2. `nonOverlappingByTime` / `allOffsetSubsamples` — throw data away
 *      until what remains is genuinely independent. Much weaker, but it
 *      relies on no distributional assumption at all, so when it agrees
 *      with the bootstrap the conclusion is solid, and when it disagrees
 *      the bootstrap's block length is suspect.
 *
 * Nothing here re-derives a signal or a return. This is purely the
 * measurement layer, the same scope metrics.ts has.
 */

// ── Deterministic RNG ───────────────────────────────────────────────────

import { mulberry32 } from "./random";

/** Re-exported so existing callers keep working; the implementation now lives in random.ts, shared with the panel estimator. */
export { mulberry32 } from "./random";

// ── Effective sample size ───────────────────────────────────────────────

/**
 * How many genuinely independent observations N overlapping ones are worth.
 *
 * Deliberately the crude n/blockLength rather than an autocorrelation-based
 * estimate. The overlap here is not something to be inferred from the data
 * — it is KNOWN exactly from how the observation was constructed (a 30-day
 * forward return sampled daily overlaps by exactly 30), so estimating it
 * would add noise to a quantity already known with certainty.
 */
export function effectiveSampleSize(n: number, blockLength: number): number {
  if (n <= 0) return 0;
  return n / Math.max(1, blockLength);
}

// ── Non-overlapping subsampling ─────────────────────────────────────────

/**
 * Greedy strictly-non-overlapping selection over real time windows: walk
 * chronologically, take an item, then skip every item that starts before
 * the taken one ends.
 *
 * Use when observations have genuinely varying durations (resolved trades,
 * which are held for however long they take to hit a stop or target).
 * `allOffsetSubsamples` is the better choice for fixed-horizon returns.
 */
export function nonOverlappingByTime<T>(
  items: T[],
  startOf: (item: T) => number,
  endOf: (item: T) => number
): T[] {
  const chronological = [...items].sort((a, b) => startOf(a) - startOf(b));
  const kept: T[] = [];
  let freeAt = -Infinity;
  for (const item of chronological) {
    if (startOf(item) < freeAt) continue;
    kept.push(item);
    freeAt = endOf(item);
  }
  return kept;
}

/**
 * Every non-overlapping subsample of a fixed-horizon series: taking every
 * `stride`-th observation yields `stride` different valid subsamples
 * depending on where you start.
 *
 * Returning all of them (rather than just the offset-0 one) is the point.
 * A single subsample is an arbitrary choice that can flatter or damn a
 * result by luck; the SPREAD across offsets shows how much the answer
 * depended on that choice, which is itself diagnostic.
 */
export function allOffsetSubsamples<T>(items: T[], stride: number): T[][] {
  const s = Math.max(1, Math.floor(stride));
  const out: T[][] = [];
  for (let offset = 0; offset < s; offset++) {
    const subsample: T[] = [];
    for (let i = offset; i < items.length; i += s) subsample.push(items[i]);
    out.push(subsample);
  }
  return out;
}

// ── Moving block bootstrap ──────────────────────────────────────────────

const DEFAULT_ITERATIONS = 2000;

/**
 * Moving block bootstrap of the MEAN of `values`, in the original
 * chronological order.
 *
 * Draws ceil(n/blockLength) contiguous blocks of length `blockLength` from
 * uniformly random start positions, concatenates them, truncates back to n,
 * and takes the mean — repeated `iterations` times. Because whole blocks
 * move together, the serial dependence within a block survives resampling,
 * which is exactly what an IID bootstrap destroys and what makes an IID
 * bootstrap (and the plain sign test) overconfident here.
 *
 * Returns the raw distribution so callers can take whatever summary they
 * need; `blockBootstrapProportion` below is the common case.
 */
export function movingBlockBootstrap(
  values: number[],
  blockLength: number,
  iterations = DEFAULT_ITERATIONS,
  seed = 12345
): number[] {
  const n = values.length;
  const block = Math.max(1, Math.min(Math.floor(blockLength), n));
  if (n === 0) return [];

  const rng = mulberry32(seed);
  const maxStart = n - block; // inclusive
  const blocksNeeded = Math.ceil(n / block);
  const distribution: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    let sum = 0;
    let count = 0;
    for (let b = 0; b < blocksNeeded && count < n; b++) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let k = 0; k < block && count < n; k++) {
        sum += values[start + k];
        count++;
      }
    }
    distribution.push(sum / count);
  }
  return distribution;
}

export interface OverlapAdjustedProportion {
  n: number;
  successes: number;
  /** Observed proportion, 0-1. Unaffected by the correction — only its uncertainty is. */
  point: number;
  blockLength: number;
  /** n / blockLength: how many independent observations this sample is really worth. */
  effectiveN: number;
  /** Standard error from the block bootstrap. Compare to sqrt(p(1-p)/n) to see the size of the correction. */
  bootstrapSe: number;
  /** Naive binomial SE, i.e. what the uncorrected reports implicitly assumed. */
  naiveSe: number;
  /** Percentile bootstrap interval. */
  lower: number;
  upper: number;
  /** Two-sided p-value against `nullProportion`, using the bootstrap SE. */
  pValue: number;
  nullProportion: number;
}

export interface ProportionDifference {
  difference: number;
  se: number;
  pValue: number;
  lower: number;
  upper: number;
}

/**
 * Difference between two overlap-corrected proportions measured on DISJOINT
 * samples — the statistic an interaction test actually needs ("does this
 * signal behave differently in regime A than in regime B?"), as opposed to
 * two separate against-a-coin-flip tests, which cannot answer it.
 *
 * Because the two samples share no observations, their sampling errors are
 * independent and the variances add: se_diff = sqrt(se_a^2 + se_b^2). Each
 * input se is already the block-bootstrap one, so the dependence WITHIN each
 * sample is carried through.
 *
 * Callers must not pass overlapping samples (e.g. a bucket and its own
 * superset) — the independence assumption is what makes this valid.
 */
export function differenceOfProportions(
  a: OverlapAdjustedProportion,
  b: OverlapAdjustedProportion
): ProportionDifference {
  const difference = a.point - b.point;
  const se = Math.sqrt(a.bootstrapSe ** 2 + b.bootstrapSe ** 2);
  return {
    difference,
    se,
    pValue: se > 0 ? twoSidedNormalP(difference / se) : 1,
    lower: difference - 1.96 * se,
    upper: difference + 1.96 * se,
  };
}

/** (z_{alpha/2} + z_beta) for 80% power at a two-sided alpha of 0.05: 1.960 + 0.842. */
const POWER_Z = 2.802;

/**
 * Smallest difference in proportions detectable at 80% power, given the
 * ACTUAL standard error of the difference.
 *
 * Take the SE from `differenceOfProportions` (which is built from the block
 * bootstrap) rather than deriving one from a nominal sample size. The two
 * are not interchangeable and mixing them produces nonsense: `effectiveN`
 * is the deliberately pessimistic n/blockLength bound, which assumes every
 * observation inside a block is perfectly redundant, while the bootstrap SE
 * measures how redundant they ACTUALLY are. Feeding the pessimistic N into
 * a power formula and comparing the answer to a p-value computed from the
 * empirical SE can report a result as significant and "undetectable" at the
 * same time — which is how this function was originally written, and wrong.
 */
export function detectableDifferenceFromSe(seOfDifference: number): number {
  return POWER_Z * seOfDifference;
}

/**
 * A-priori version: smallest detectable difference from a planned sample
 * size alone, for study DESIGN before any data exists. Assumes p near 0.5
 * and equal arms. Do not use it to interpret a completed test — use
 * `detectableDifferenceFromSe` for that.
 */
export function detectableDifference(effectiveNPerArm: number): number {
  if (effectiveNPerArm <= 0) return 1;
  return POWER_Z * Math.sqrt((2 * 0.25) / effectiveNPerArm);
}

/** Standard normal two-sided tail, via the Abramowitz-Stegun 7.1.26 erf approximation (|error| < 1.5e-7 — far below any precision this report quotes). */
function twoSidedNormalP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.min(1, Math.max(0, 1 - y));
}

/**
 * The headline function: a win rate, with an honest uncertainty attached.
 *
 * `successes` is a 0/1 series IN CHRONOLOGICAL ORDER — order matters, since
 * the whole method depends on adjacent observations being the dependent
 * ones. Passing a shuffled series would silently destroy the correction and
 * hand back the naive answer, so callers must not sort by anything else.
 */
export function blockBootstrapProportion(
  successes: number[],
  blockLength: number,
  nullProportion = 0.5,
  iterations = DEFAULT_ITERATIONS,
  seed = 12345
): OverlapAdjustedProportion | null {
  const n = successes.length;
  if (n === 0) return null;

  const wins = successes.reduce((a, b) => a + b, 0);
  const point = wins / n;
  const distribution = movingBlockBootstrap(successes, blockLength, iterations, seed);

  const mean = distribution.reduce((a, b) => a + b, 0) / distribution.length;
  const variance =
    distribution.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, distribution.length - 1);
  const bootstrapSe = Math.sqrt(variance);
  const naiveSe = Math.sqrt((point * (1 - point)) / n);

  const sorted = [...distribution].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

  // A degenerate sample (every observation identical) has zero spread, so
  // there is no evidence of a difference to report rather than an infinite z.
  const pValue = bootstrapSe > 0 ? twoSidedNormalP((point - nullProportion) / bootstrapSe) : 1;

  return {
    n,
    successes: wins,
    point,
    blockLength: Math.max(1, Math.min(Math.floor(blockLength), n)),
    effectiveN: effectiveSampleSize(n, blockLength),
    bootstrapSe,
    naiveSe,
    lower: pick(0.025),
    upper: pick(0.975),
    pValue,
    nullProportion,
  };
}
