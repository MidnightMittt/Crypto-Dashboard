/**
 * HOW MANY INDEPENDENT BETS IS A CROSS-SECTION ACTUALLY WORTH?
 *
 * Every cross-sectional figure on this site has a hidden denominator. "87.3%
 * vs 85.1% vs 84.4% across three miners" reads as three pieces of evidence
 * and is not: if those names correlate at 0.7, the three numbers are largely
 * one number observed three times. The row-level `independent_n` already
 * handles WINDOW overlap inside a single symbol's own history. It says
 * nothing about whether two symbols are distinguishable from each other,
 * and that is the gap this module closes.
 *
 * ── The two numbers, and why both ────────────────────────────────────
 *
 * For an equally-weighted average of n unit-variance series with average
 * pairwise correlation rho:
 *
 *   Var = (1/n)(1 + (n-1)rho)      so    N_eff = n / (1 + (n-1)rho)
 *
 * This is EXACT, not an approximation, and it holds whatever the
 * correlation structure is — because sum_ij rho_ij = n + n(n-1)rho_bar is
 * true by the definition of rho_bar. It answers: how many independent
 * observations is "the panel agrees" worth? As n grows it approaches 1/rho,
 * so a 122-name panel at rho 0.68 is worth about 1.5 observations, not 122.
 *
 * The one thing to keep straight is what "equally-weighted" means here.
 * Because the arithmetic runs on CORRELATIONS, N_eff describes a basket
 * weighted equally by RISK, not by dollars. That is the right convention for
 * reading a table — every row gets one vote regardless of the name's
 * volatility — but it is not a portfolio weight, and it should not be read
 * as one.
 *
 * N_eff also describes an AVERAGE, and an average hides shape. The second
 * number is the eigenvalue participation ratio:
 *
 *   PR = (sum lambda_i)^2 / sum lambda_i^2
 *
 * which needs no eigensolver: the trace of a correlation matrix is n, and
 * the sum of squared eigenvalues is its squared Frobenius norm, so
 *
 *   PR = n^2 / sum_ij rho_ij^2 = n / (1 + (n-1) * mean(rho^2))
 *
 * the same closed form with rho^2 in place of rho.
 *
 * PR counts the DIRECTIONS carrying comparable variance; N_eff counts
 * INDEPENDENT BETS in a risk-equal basket. Their relationship is not a
 * coincidence: for non-negative correlations rho^2 <= rho, so PR is never
 * BELOW N_eff, and the two coincide only when every pair sits at exactly 0
 * or exactly 1. Everything in between is the panel's dispersion. A hundred
 * names all pairing at 0.5 are worth N_eff = 2.0 read straight down, while
 * spanning PR = 3.9 directions — read top-down the panel is two bets, but it
 * has more shape than that for someone willing to weight it unequally.
 *
 * N_eff is therefore the figure to print beside a ranking, because a ranking
 * IS read straight down. PR is the one that says whether anything survives
 * the common factor.
 *
 * ── What this does NOT claim ─────────────────────────────────────────
 *
 * It does not say a ranking is WRONG. Correlation does not bias the
 * individual estimates, and for a PAIRED comparison ("is WULF's reach
 * different from HUT's?") positive correlation actually helps, because the
 * common factor cancels out of the difference. What collapses is the
 * ranking's INFORMATION CONTENT as a menu: when breadth is 1.5, choosing
 * the top name over the fifth is very nearly the same bet, so the ordering
 * matters far less than its precision suggests. The honest caution is "this
 * is one bet expressed n ways", not "these numbers are unreliable".
 *
 * Correlation is also regime-dependent. The figure is computed over a
 * declared trailing window and the window is reported beside it; a number
 * from a calm tape does not describe a stressed one.
 */

/** Aligned daily log returns; null where a session is missing or interpolated. */
export type ReturnSeries = readonly (number | null)[];

export interface BreadthResult {
  /** Names in the cross-section. */
  n: number;
  /** Sessions of return history the correlations were computed over. */
  sessions: number;
  /** Mean pairwise correlation over pairs with enough overlap. */
  mean_pairwise_rho: number | null;
  /** Pairs that cleared the overlap minimum, out of n(n-1)/2. */
  pairs_measured: number;
  /**
   * n / (1 + (n-1)rho) — independent bets in an equal-weighted basket.
   * Exact for the equal-weighted average's variance.
   */
  effective_bets: number | null;
  /** n / (1 + (n-1)mean(rho^2)) — factors spanning the panel. */
  participation_ratio: number | null;
  /** Independent bets as a share of headcount, the figure that travels best. */
  breadth_pct: number | null;
  /**
   * Pairs at or above NEAR_DUPLICATE_RHO, strongest first. Not a summary —
   * these are the specific rows that are the same row, named so the reader
   * can collapse them by hand.
   */
  near_duplicates: { a: string; b: string; rho: number }[];
  /** How many pairs cleared the threshold, before the list was truncated. */
  near_duplicates_total: number;
  /** What the breadth means for counting. True of any cross-section. */
  sentence: string;
  /**
   * What it means for an ORDERING specifically — kept separate because most
   * consumers are not sorted tables. Splicing "names near each other in the
   * ordering" into a rule ledger's null model, which has no ordering, is how
   * a caution stops being read.
   */
  ranking_caution: string;
}

/** Below this many overlapping returns a pair's correlation is noise, not a measurement. */
export const MIN_PAIR_OVERLAP = 60;

/**
 * At this correlation two names are not "similar", they are one position
 * quoted twice — MSTU and MSTX pair at 0.999 on the committed panel, being
 * two issuers' leveraged wrappers on the same underlying. An aggregate
 * breadth figure is true but abstract; naming the duplicate pair is what
 * actually stops a reader treating the top two rows of a sort as a choice.
 */
export const NEAR_DUPLICATE_RHO = 0.95;

/** Named pairs listed before truncating; the count is always reported in full. */
const MAX_NEAR_DUPLICATES = 12;

/** Closes to aligned log returns, with gaps preserved as null rather than bridged. */
export function logReturns(closes: readonly (number | null)[]): ReturnSeries {
  const out: (number | null)[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    out.push(a !== null && b !== null && a > 0 && b > 0 ? Math.log(b / a) : null);
  }
  return out;
}

/**
 * Pearson correlation over the sessions where BOTH series are present.
 * Null when the overlap is too short to mean anything — never zero, which
 * would read as "measured and independent".
 */
export function pairRho(a: ReturnSeries, b: ReturnSeries): number | null {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    if (x === null || y === null) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < MIN_PAIR_OVERLAP) return null;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  if (!(va > 0) || !(vb > 0)) return null;
  const rho = cov / Math.sqrt(va * vb);
  return Number.isFinite(rho) ? Math.max(-1, Math.min(1, rho)) : null;
}

const r2 = (v: number) => Number(v.toFixed(2));

/**
 * Effective breadth of a named cross-section.
 *
 * Pairs that fail the overlap minimum are EXCLUDED from the mean rather
 * than counted as uncorrelated — treating an unmeasured pair as independent
 * inflates breadth by exactly the amount the caller most wants to believe.
 */
export function effectiveBreadth(
  series: ReadonlyMap<string, ReturnSeries>,
  sessions: number
): BreadthResult {
  const names = [...series.keys()];
  const n = names.length;
  const empty = (sentence: string): BreadthResult => ({
    n,
    sessions,
    mean_pairwise_rho: null,
    pairs_measured: 0,
    effective_bets: null,
    participation_ratio: null,
    breadth_pct: null,
    near_duplicates: [],
    near_duplicates_total: 0,
    sentence,
    ranking_caution: sentence,
  });

  if (n < 2) {
    return empty(
      `Breadth needs at least two names to mean anything; this cross-section has ${n}.`
    );
  }

  let sum = 0, sumSq = 0, pairs = 0;
  const dupes: { a: string; b: string; rho: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const rho = pairRho(series.get(names[i])!, series.get(names[j])!);
      if (rho === null) continue;
      sum += rho;
      sumSq += rho * rho;
      pairs++;
      if (rho >= NEAR_DUPLICATE_RHO) {
        dupes.push({ a: names[i], b: names[j], rho: Number(rho.toFixed(3)) });
      }
    }
  }
  dupes.sort((x, y) => y.rho - x.rho);
  const total = (n * (n - 1)) / 2;
  if (pairs < total / 2) {
    return empty(
      `Only ${pairs} of ${total} pairs had ${MIN_PAIR_OVERLAP}+ overlapping sessions, which is too few to describe the panel's breadth. Reported as unmeasured rather than as a number resting on half the panel.`
    );
  }

  const meanRho = sum / pairs;
  const meanRhoSq = sumSq / pairs;
  const denom = 1 + (n - 1) * meanRho;
  const denomSq = 1 + (n - 1) * meanRhoSq;

  /*
   * A non-positive denominator means the average pair is negatively
   * correlated enough that the equal-weighted basket is self-hedging. The
   * ratio is then meaningless rather than large, so it is refused.
   */
  const bets = denom > 0 ? n / denom : null;
  const pr = denomSq > 0 ? n / denomSq : null;

  return {
    n,
    sessions,
    mean_pairwise_rho: Number(meanRho.toFixed(3)),
    pairs_measured: pairs,
    effective_bets: bets === null ? null : r2(bets),
    participation_ratio: pr === null ? null : r2(pr),
    breadth_pct: bets === null ? null : Number(((bets / n) * 100).toFixed(1)),
    near_duplicates: dupes.slice(0, MAX_NEAR_DUPLICATES),
    near_duplicates_total: dupes.length,
    sentence:
      (bets === null
        ? `${n} names whose average pair is negatively correlated; an equal-weighted basket of them partly hedges itself, so an effective-bets figure would be meaningless and is refused.`
        : describe(n, sessions, meanRho, bets, pr)) + duplicateClause(dupes),
    ranking_caution: bets === null ? NO_RANKING_CAUTION : rankingCaution(bets, n),
  };
}

const NO_RANKING_CAUTION =
  "No ranking caution is offered, because the breadth figure it would rest on was refused.";

/** What the breadth means for a table someone reads top-down. */
function rankingCaution(bets: number, n: number): string {
  const tier =
    bets < 1.5
      ? `Read as a ranking this is close to meaningless: the top row and the middle row are the same bet, so choosing between them is close to choosing nothing.`
      : bets < n / 4
        ? `Read as a ranking, names near each other are frequently the same bet twice — a difference of a few points between neighbours is not a reason to prefer one.`
        : `Read as a ranking, the ordering carries most of the information its length implies; neighbouring rows are still not independent, but they are not interchangeable either.`;
  return (
    `${tier} None of this makes an individual row WRONG — correlation does not bias the individual ` +
    `estimates, and for a PAIRED question ("does A reach further than B?") it actively helps, because ` +
    `the shared factor cancels out of the difference. What it costs is the ordering's value as a menu.`
  );
}

/** The specific rows that are one row, named. Silent when there are none. */
function duplicateClause(dupes: { a: string; b: string; rho: number }[]): string {
  if (dupes.length === 0) return "";
  /*
   * Three decimals, not two. Every pair here rounds to 1.00 at two, which
   * reads as a perfect duplicate and flattens the real difference between
   * 0.999 and 1.000 — and the whole value of this clause is that it names
   * specific measured pairs rather than a category.
   */
  const shown = dupes.slice(0, 3).map((d) => `${d.a}/${d.b} at ${d.rho.toFixed(3)}`);
  const rest = dupes.length - shown.length;
  return (
    ` ${dupes.length} pair${dupes.length === 1 ? " correlates" : "s correlate"} at ${NEAR_DUPLICATE_RHO} or above — ` +
    `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}. ` +
    `Those are not similar names, they are the same position listed twice; collapse them before counting anything.`
  );
}

/**
 * The caution, scaled to the measurement.
 *
 * An earlier draft printed "one exposure expressed n ways" at every breadth
 * level, which was false the first time it ran on the real panel: 122 names
 * measured 5.6 bets across 13 directions, and calling that "one exposure"
 * would have been an overclaim in the cautious direction. A warning that
 * fires at full volume regardless of what was measured teaches the reader to
 * discount it, which costs exactly the cases where it is true.
 */
function describe(
  n: number,
  sessions: number,
  meanRho: number,
  bets: number,
  pr: number | null
): string {
  const obs = Math.round(bets);
  const head =
    `${n} names, mean pairwise correlation ${meanRho.toFixed(2)} over ${sessions} sessions, ` +
    `worth about ${r2(bets)} independent bets — ${((bets / n) * 100).toFixed(1)}% of the headcount. ` +
    `"${n} names show X" is therefore closer to ${obs} observation${obs === 1 ? "" : "s"} than to ${n}.`;

  const caution =
    bets < 1.5
      ? ` At this breadth the set is essentially ONE exposure written ${n} ways, and the second name adds almost nothing to the first.`
      : bets < n / 4
        ? ` The set holds roughly ${obs} genuinely different bets, not ${n}; most of these names are restatements of a few.`
        : ` Breadth is wide enough that the headcount is not badly misleading — the names are not independent, but neither are they interchangeable.`;

  const shape =
    pr === null
      ? ""
      : ` Participation ratio ${r2(pr)} counts the directions spanning these ${n} — ${
          pr > bets * 1.5
            ? `more than the ${r2(bets)} a risk-equal read is worth, so there is shape here that unequal weighting could reach.`
            : `close to the effective-bets figure, so there is little structure here beyond the common factor.`
        }`;

  return head + caution + shape;
}
