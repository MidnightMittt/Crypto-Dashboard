/**
 * THREE NUMBERS, NOT ONE — separating stock-picking from pool drift.
 *
 * A cross-sectional signal reported as one figure cannot distinguish two
 * claims that have OPPOSITE trading implications:
 *
 *   "my ranking picks well inside my universe"   (selection skill)
 *   "my universe beat the index"                 (pool drift)
 *
 * The first is a signal. The second is asset allocation you already made when
 * you chose the names, and it will not survive a change of universe.
 *
 * Measured, on two near-independent cross-sections of the same rule:
 *
 *                             19 names          59 names
 *   top decile MINUS QQQ    +1.016% t=2.15    -0.036% t=-0.14
 *   ALL names MINUS QQQ     +0.189% t=0.71    -0.500% t=-2.07
 *   top MINUS all names     +0.827% t=2.01    +0.465% t=2.09
 *
 * The selection effect REPLICATES on both. The index comparison FLIPS. A page
 * publishing only the first row would have called the same rule a +1.016%
 * edge on one universe and nothing on the other, and both statements would
 * have been about the universe rather than the signal.
 *
 * ── Paired, then differenced. Never differenced, then paired ──────────
 *
 * Each column is the mean of a PER-PERIOD difference, computed only on the
 * periods all three legs share. Taking two independently-computed averages
 * and subtracting them would discard the pairing, and the pairing is what
 * cancels the common market move — which is most of the variance. Differencing
 * two averages leaves that variance in the denominator and understates the
 * standard error of the thing you actually care about.
 *
 * ── The identity that makes this a decomposition ──────────────────────
 *
 * By construction, for every period:
 *
 *   (signal − index) = (signal − universe) + (universe − index)
 *
 * so the MEANS add exactly. The t-statistics do not, and must not be expected
 * to: each column has its own variance, and a large mean with a large
 * variance is a weaker claim than a small mean with a small one. That the
 * means reconcile and the t's do not is the entire point of reporting three.
 */

/** One period's realised return for one leg, as a fraction (0.012 = +1.2%). */
export interface LegPeriod {
  date: string;
  ret: number;
}

export interface PairedDifference {
  /** Short label, e.g. "signal − universe". */
  label: string;
  /** The question this column answers, in the words a reader needs. */
  question: string;
  /** Mean per-period difference, in percent. */
  meanPct: number;
  /** Standard deviation of the per-period difference, in percent. */
  sdPct: number;
  /** Periods, after the inner join. One period is one observation. */
  n: number;
  /**
   * Clustered by construction: a period contributes ONE number, not one per
   * name. Pooling correlated names as name-days is what inflates t by roughly
   * the square root of the name count.
   */
  t: number;
  /**
   * The smallest effect this test could have called significant at t=3.
   * A null here is not evidence of absence when the effect sought is smaller
   * than this.
   */
  detectablePctAtT3: number;
}

export interface Decomposition {
  /** The periods all three legs shared. Every column uses exactly these. */
  periods: string[];
  /** Periods dropped because a leg had no observation for them. */
  droppedPeriods: string[];
  /** Is the ranking doing anything? */
  signalMinusUniverse: PairedDifference;
  /** Is the pool itself carrying the result? */
  universeMinusIndex: PairedDifference;
  /** Should I trade this instead of buying the index? The only one that pays. */
  signalMinusIndex: PairedDifference;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation, Bessel-corrected. Null below two observations. */
function sd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Below this, a standard deviation is floating-point residue rather than
 * dispersion.
 *
 * A guard of `sd > 0` is NOT enough, and the difference is not academic.
 * Differencing two legs that move together — which is the normal case here,
 * since that is what pairing is for — leaves noise around 1e-16 even when the
 * difference is constant by construction. That is greater than zero, so a
 * `> 0` test passes it through, and a 2% mean over a 1e-16 standard deviation
 * reports t ≈ 2.5e16: the most confident possible way to be wrong, produced
 * by arithmetic rather than by evidence.
 *
 * A tenth of a billionth of a percent is far below any price granularity, so
 * anything under it is treated as no dispersion at all.
 */
const NEGLIGIBLE_SD_PCT = 1e-10;

function summarise(label: string, question: string, diffs: readonly number[]): PairedDifference {
  const meanPct = mean(diffs) * 100;
  const s = sd(diffs);
  const raw = s === null ? 0 : s * 100;
  const sdPct = raw < NEGLIGIBLE_SD_PCT ? 0 : raw;
  const n = diffs.length;
  const se = sdPct / Math.sqrt(n);
  return {
    label,
    question,
    meanPct,
    sdPct,
    n,
    // A leg with no dispersion has no standard error and therefore no t, not
    // an infinite one. Zero says "this test could not distinguish anything".
    t: se > 0 ? meanPct / se : 0,
    detectablePctAtT3: se > 0 ? 3 * se : 0,
  };
}

/**
 * Decompose a signal's return against its own universe and an index.
 *
 * All three legs are inner-joined on date, so a period missing from any one
 * of them is dropped from ALL of them and reported. A period present in two
 * legs and absent from the third is not a two-thirds observation; including
 * it would silently compare different date sets across columns and break the
 * identity the whole decomposition rests on.
 *
 * Returns null below `minPeriods` — a decomposition computed on a handful of
 * periods is three numbers that all mean nothing, and returning it would
 * invite exactly the over-reading it exists to prevent.
 */
export function decompose(
  signal: readonly LegPeriod[],
  universe: readonly LegPeriod[],
  index: readonly LegPeriod[],
  minPeriods = 12
): Decomposition | null {
  const u = new Map(universe.map((p) => [p.date, p.ret]));
  const i = new Map(index.map((p) => [p.date, p.ret]));

  const periods: string[] = [];
  const dropped: string[] = [];
  const su: number[] = [];
  const ui: number[] = [];
  const si: number[] = [];

  for (const p of [...signal].sort((a, b) => a.date.localeCompare(b.date))) {
    const un = u.get(p.date);
    const ix = i.get(p.date);
    if (un === undefined || ix === undefined) {
      dropped.push(p.date);
      continue;
    }
    periods.push(p.date);
    su.push(p.ret - un);
    ui.push(un - ix);
    si.push(p.ret - ix);
  }

  if (periods.length < minPeriods) return null;

  return {
    periods,
    droppedPeriods: dropped,
    signalMinusUniverse: summarise(
      "signal − universe",
      "Is the ranking doing anything?",
      su
    ),
    universeMinusIndex: summarise(
      "universe − index",
      "Is the pool itself carrying the result?",
      ui
    ),
    signalMinusIndex: summarise(
      "signal − index",
      "Should I trade this instead of buying the index?",
      si
    ),
  };
}

/**
 * Plain-English read of a decomposition.
 *
 * Deliberately refuses to call anything an edge on the strength of the first
 * column alone: picking well inside a universe that trailed the index is a
 * real finding about the ranking and a bad reason to put money on it.
 */
export function describeDecomposition(d: Decomposition, atT = 2): string {
  const picks = Math.abs(d.signalMinusUniverse.t) >= atT && d.signalMinusUniverse.meanPct > 0;
  const beatsIndex = d.signalMinusIndex.t >= atT && d.signalMinusIndex.meanPct > 0;
  const poolDrifted = Math.abs(d.universeMinusIndex.t) >= atT;
  /*
   * The DIRECTION of the drift, read from its sign rather than assumed.
   *
   * The first version of this said "moved against the index" whenever drift
   * was significant, and rendered that sentence one line under a measured
   * +0.76% — the pool had BEATEN the index. The words contradicted the number
   * they were explaining. Only reading live output caught it, so the sign is
   * now load-bearing and a test pins each phrase to it.
   */
  const poolBeat = d.universeMinusIndex.meanPct > 0;

  if (picks && beatsIndex) {
    if (!poolDrifted) {
      return "The ranking selects well and the result clears the index, with no meaningful drift in the pool to explain it away.";
    }
    return poolBeat
      ? "The ranking selects well AND the result clears the index — but the pool itself also beat the index over the same periods, so part of the headline belongs to the universe rather than to the ranking."
      : "The ranking selects well and the result still clears the index, having done so while the pool itself trailed the index — the ranking is recovering ground the universe lost.";
  }
  if (picks && !beatsIndex) {
    return "The ranking selects well inside its own universe, but the result does not clear the index. That is a real finding about the ranking and not a reason to trade it over the benchmark.";
  }
  if (!picks && beatsIndex) {
    return "The result clears the index while the ranking shows no selection skill, which points at the universe rather than the signal — the composition is doing the work.";
  }
  return "Neither the ranking nor the result separates from the index on this sample.";
}
