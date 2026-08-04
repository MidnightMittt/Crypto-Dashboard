/**
 * Multiple-hypothesis-testing correction — a DIFFERENT statistical concern
 * from `metrics.ts`'s single-sample significance test, kept in its own file
 * rather than bolted onto that one. `signTestPValue` answers "is this ONE
 * signal's win rate unlikely to be a coin flip." This module answers "if I
 * ran 105 of those tests at once, how many of the 'significant' ones are
 * actually just what chance would produce" — the exact problem
 * `metricCombinations.ts`'s bounded automatic-pair scan runs into (105
 * pairs x 4 holding periods means ~22 false positives are statistically
 * guaranteed at raw p<0.05 even with zero real effect).
 */

export interface FdrResult {
  pValue: number;
  /** 1-indexed rank within the sorted family this p-value belongs to (rank 1 = smallest p-value). */
  rank: number;
  /** True only if this p-value clears the Benjamini-Hochberg threshold for its rank AND every smaller p-value in the family also did. */
  significant: boolean;
}

/**
 * Benjamini-Hochberg procedure at false-discovery rate `q` (default 0.05):
 * sort p-values ascending, find the LARGEST rank k where p(k) <= (k/m) * q,
 * then mark every p-value at or below that rank significant (not just the
 * ones individually under their own threshold — BH's own guarantee only
 * holds for the contiguous block up to the largest passing rank).
 *
 * Chosen over Bonferroni (q/m for every test) because Bonferroni is
 * needlessly conservative for an exploratory scan like this and would bury
 * real effects; BH is the standard correction for "many tests, want to
 * bound the expected FALSE discovery rate" rather than "guarantee zero
 * false positives at any cost."
 */
export function benjaminiHochberg(pValues: number[], q = 0.05): FdrResult[] {
  const m = pValues.length;
  if (m === 0) return [];

  const indexed = pValues.map((p, originalIndex) => ({ p, originalIndex }));
  indexed.sort((a, b) => a.p - b.p);

  let largestSignificantRank = 0;
  for (let rank = 1; rank <= m; rank++) {
    const threshold = (rank / m) * q;
    if (indexed[rank - 1].p <= threshold) largestSignificantRank = rank;
  }

  const results: FdrResult[] = new Array(m);
  for (let rank = 1; rank <= m; rank++) {
    const { p, originalIndex } = indexed[rank - 1];
    results[originalIndex] = { pValue: p, rank, significant: rank <= largestSignificantRank };
  }
  return results;
}
