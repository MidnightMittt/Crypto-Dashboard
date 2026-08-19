/**
 * WHERE A VALUE SITS IN ITS OWN HISTORY — one implementation, several callers.
 *
 * A LEVEL is nearly meaningless on its own. Forty percent of volume printing
 * short is routine for one symbol and extraordinary for another; a gamma of
 * $12m is enormous for a small miner and unremarkable for a megacap. The
 * informative statement is positional — "higher than N of the last M
 * sessions" — which is the discipline every band on this site already claims
 * to apply.
 *
 * ── MID-RANK, and why the naive version is dangerous ──────────────────
 *
 * The obvious `below / n` returns 0 when the value ties the entire
 * distribution — exactly what happens when two series move identically and
 * their relative strength is 0 at every point. That reads as the 0th
 * percentile: a maximally BEARISH signal manufactured out of zero variance.
 * It was caught by the "both rise together" test in the relative-strength
 * read, and it is the same failure as a zero-variance p-value.
 *
 * Splitting the tied mass puts a value equal to everything at 0.5, which is
 * the honest answer: a measure with no variation carries no directional
 * information.
 *
 * ── Why this file exists ──────────────────────────────────────────────
 *
 * This arithmetic was written THREE times — equityEvidence, volTermStructure
 * and finraShortVolume — each with the tie-splitting rediscovered and
 * re-explained in its own comment. Three copies of one estimator is three
 * chances for a future fix to land in one of them. The charter's rule is that
 * every calculation has a single source of truth, and this is that source.
 *
 * ── What is deliberately NOT shared ───────────────────────────────────
 *
 * The SUFFICIENCY THRESHOLD stays with each caller, because the three
 * genuinely disagree and should: a directional band wants 60 sessions before
 * it will speak, a short-volume read is useful at 8, and the vol term
 * structure treats an empty history as "no information" rather than as a
 * refusal. Merging those would silently change three published behaviours
 * under the banner of removing duplication. Only the arithmetic is one thing.
 */

/**
 * Mid-rank position of `value` within `history`, from 0 to 1.
 *
 * Returns null ONLY when there is nothing to compare against. A caller that
 * wants a larger minimum enforces it itself — see the note above on why that
 * policy is not centralised here.
 */
export function midRankPercentile(value: number, history: readonly number[]): number | null {
  if (history.length === 0) return null;

  let below = 0;
  let equal = 0;
  for (const h of history) {
    if (h < value) below++;
    else if (h === value) equal++;
  }
  return (below + 0.5 * equal) / history.length;
}

/** The same figure as a rounded 0-100, for callers that report percent. */
export function midRankPercentilePct(value: number, history: readonly number[]): number | null {
  const p = midRankPercentile(value, history);
  return p === null ? null : Math.round(p * 100);
}
