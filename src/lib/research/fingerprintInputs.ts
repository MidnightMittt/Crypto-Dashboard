import { DIMENSIONS } from "./fingerprint";

/**
 * TURNING A MARKET DAY INTO A VECTOR, without seeing the future.
 *
 * The fingerprint definition (`fingerprint.ts`) says WHAT the dimensions are.
 * This says how a day's raw readings become the standardised numbers that
 * definition expects, and it is where look-ahead would hide if it were going
 * to hide anywhere.
 *
 * ── The one invariant that matters ────────────────────────────────────
 *
 * A fingerprint for date D must be computable from data available at the
 * close of D, and must never change when later data arrives. Both halves
 * matter: the first is obvious, the second is the one that gets violated
 * quietly. Standardising a dimension against the FULL history — including
 * days after D — is the classic version of that mistake, and it is
 * invisible in the output: the numbers look reasonable, the backtest
 * improves, and the improvement is entirely the leak.
 *
 * So `RollingStandardiser` reads before it writes, always. `z()` computes
 * against everything recorded so far and only then records today. Feeding a
 * longer series can extend the output but can never alter a value already
 * produced, which is exactly the property the tests assert by replaying
 * prefixes.
 */

/** Below this, a z-score is noise dressed as a measurement. */
const MIN_HISTORY = 60;

/**
 * Standard deviations beyond which values are clipped.
 *
 * Not cosmetic. Distance is Euclidean, so one 40-sigma reading — a
 * post-split price, a data error, a genuine once-a-decade dislocation —
 * would dominate every comparison it appears in and make that day similar to
 * nothing. Clipping keeps an extreme day extreme without letting it swamp
 * the other ten dimensions.
 */
const CLIP = 4;

export class RollingStandardiser {
  /** dimension id -> every raw value seen STRICTLY BEFORE the current call. */
  private readonly prior = new Map<string, number[]>();

  /**
   * The z-score of `value` against this dimension's own past, then record it.
   *
   * Returns null until there is enough history, which is honest rather than
   * inconvenient: the fingerprint contract already handles missing
   * dimensions by comparing the intersection, so an instrument's first
   * months simply carry a thinner vector instead of a fabricated one.
   */
  z(dimension: string, value: number): number | null {
    if (!Number.isFinite(value)) return null;
    const history = this.prior.get(dimension) ?? [];

    let out: number | null = null;
    if (history.length >= MIN_HISTORY) {
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const variance = history.reduce((s, x) => s + (x - mean) ** 2, 0) / (history.length - 1);
      const sd = Math.sqrt(variance);
      // A dimension that never varies carries no information; 0 is the
      // truthful answer there, not a divide-by-zero infinity.
      out = sd > 1e-9 ? Math.max(-CLIP, Math.min(CLIP, (value - mean) / sd)) : 0;
    }

    // WRITE AFTER READ. Reversing these two lines is the leak.
    history.push(value);
    this.prior.set(dimension, history);
    return out;
  }

  /** How many observations back this dimension, for diagnostics. */
  seen(dimension: string): number {
    return this.prior.get(dimension)?.length ?? 0;
  }
}

/**
 * The raw, pre-standardisation reading for each dimension.
 *
 * Deliberately a plain record keyed by dimension id rather than a positional
 * tuple: a mis-ordered tuple would silently compare trend against
 * volatility, and nothing downstream could detect it.
 *
 * A dimension the caller cannot supply is simply absent. It must NOT be
 * passed as 0 — zero standardises to "exactly average", which is a claim,
 * and the distance function already excludes absent dimensions rather than
 * penalising them.
 */
export type RawReadings = Partial<Record<string, number>>;

const KNOWN = new Set(DIMENSIONS.map((d) => d.id));

/**
 * Standardise a day's raw readings, dropping anything the definition does
 * not recognise.
 *
 * The unknown-key guard exists because the ingest and the definition live in
 * different files: a dimension renamed in one and not the other would
 * otherwise produce vectors that silently never match on that axis, which
 * looks like "no similar days" rather than like a bug.
 */
export function standardise(
  raw: RawReadings,
  scaler: RollingStandardiser
): { values: Partial<Record<string, number>>; unknown: string[] } {
  const values: Partial<Record<string, number>> = {};
  const unknown: string[] = [];

  /*
   * Iterated in DEFINITION order rather than object-key order, so the
   * standardiser sees dimensions in the same sequence on every day and for
   * every instrument. Object key order would depend on how the caller built
   * the record, which is not a property worth depending on.
   */
  for (const dim of DIMENSIONS) {
    const v = raw[dim.id];
    if (v === undefined) continue;
    const z = scaler.z(dim.id, v);
    if (z !== null) values[dim.id] = z;
  }

  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) unknown.push(key);
  return { values, unknown };
}
