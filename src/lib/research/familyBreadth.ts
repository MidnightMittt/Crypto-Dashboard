/**
 * HOW MANY IDEAS DID THE LAB ACTUALLY TEST?
 *
 * `signalValidation.json` reports `familySize: 12` and the page renders "N of
 * 12 measured signals clear their own bar". Both are headcounts, and a
 * headcount is the one thing this repository has already learned not to trust
 * about a correlated set — it is the same error `effectiveBreadth` was written
 * to kill on a table of miners, arriving here on a table of hypotheses.
 *
 * ── What the measurement found, and why it is not a rounding detail ───
 *
 * Three of the twelve are ONE series partitioned. `momentum-12-1` runs 505
 * periods; `momentum-12-1-broad-up` runs 408 of them and
 * `momentum-12-1-broad-down` the other 97, and every spread in the two gated
 * variants is bit-identical to the parent's spread on the same date. The
 * long-only trio is the same arrangement again. So "12 declared hypotheses"
 * contains at most 8 distinct series, and the correlated remainder takes the
 * effective count to roughly two.
 *
 * This does NOT make a surviving result wrong, and the direction matters:
 * Benjamini-Hochberg over 12 correlated p-values is CONSERVATIVE, so a
 * survivor cleared a harder bar than it needed to, not an easier one. What
 * collapses is the claim the headcount makes about COVERAGE — "we tried
 * twelve things and these survived" describes a broad search, and the search
 * was narrow. A reader discounts a survivor differently depending on which of
 * those two they believe.
 *
 * ── Why a bracket rather than a number ────────────────────────────────
 *
 * Hypotheses hold for different periods — 21 sessions for momentum, 5 for
 * reversal — so their period series land on different dates and many pairs
 * never overlap enough to correlate. `effectiveBreadth` refuses those pairs
 * rather than scoring them zero, which is right, but it means the surviving
 * pairs are disproportionately WITHIN an idea (same hold, same calendar)
 * rather than ACROSS ideas. Those are the correlated ones. So the measured
 * mean rho is biased UP and the measured breadth biased DOWN.
 *
 * `bestCaseBets` closes the bracket from the other side by assuming every
 * unmeasurable pair is perfectly independent — the most generous assumption
 * available, and one no honest reading would make. Quoting both is what makes
 * the conclusion safe: on this family the two ends are about 2.2 and 3.2, so
 * "the lab has tested two or three distinct ideas, not twelve" holds whichever
 * end you take, and no argument about the missing pairs can rescue the
 * headcount.
 */

import { BreadthResult, ReturnSeries, effectiveBreadth } from "./effectiveBreadth";

/** The minimum a period series needs before it can join the cross-section. */
const MIN_PERIODS = 8;

/** One hypothesis reduced to what breadth needs: a name and a dated series. */
export interface FamilySeries {
  id: string;
  /** Period entry times and the spread each period contributed. */
  periods: readonly { entryTime: number; spread: number }[];
}

export interface FamilyBreadth {
  /** Declared hypotheses — the headcount the file and the page report. */
  declared: number;
  /** Those with enough periods to correlate at all. */
  measured: number;
  /** The full breadth read, including the named near-duplicate pairs. */
  breadth: BreadthResult;
  /**
   * Effective bets if every pair too sparse to measure were perfectly
   * independent — the other end of the bracket, quoted AGAINST the measured
   * figure so a conclusion only stands when both ends agree.
   *
   * Usually the generous end, but NOT always: when the measured pairs average
   * a negative correlation, diluting that average toward zero across the
   * unmeasured pairs LOWERS the count instead of raising it. So this is "the
   * other end", not "the upper bound", and the sentence orders the two rather
   * than assuming which is which. Null when the breadth read was refused.
   */
  bestCaseBets: number | null;
  /** Pairs that could not be correlated, out of every pair. */
  pairsUnmeasurable: number;
  /**
   * How many distinct ideas the family holds, from mean |rho| — the counting
   * answer, where `breadth.effective_bets` is the portfolio answer.
   *
   * On the equity family the two are 2.2 and 2.0 and the distinction is
   * academic, because nothing in it is inversely related to anything else. On
   * the crypto module family they are 8.5 and 3.0, because `squeezeRisk` is
   * `longShort` with the sign flipped by design — one fades a crowded side,
   * the other trends it, off overlapping inputs. Scoring that pair as 2.0
   * bets of diversification is right for a basket and absurd for a claim
   * about how many ideas were tried.
   *
   * Null only when the breadth read itself was refused.
   */
  distinctTests: number | null;
  /** Duplicate pairs whose correlation is negative — one idea, inverted. */
  inversePairs: number;
  /** The bracket in one sentence, in the direction that survives both ends. */
  sentence: string;
  /**
   * The near-duplicate pairs named in prose, or null when there are none.
   *
   * Split OUT of `sentence` rather than folded into it because the two
   * consumers differ: a JSON reader has no table and needs the pairs spelled
   * out, while the page renders them as a list underneath and would print
   * each pair twice. A caller wanting the standalone paragraph joins the two;
   * one that shows its own list uses `sentence` alone.
   */
  duplicateSentence: string | null;
}

/**
 * Aligns the family's period series on the union of their entry dates and
 * measures the cross-section.
 *
 * Dates a hypothesis did not trade become `null`, not zero. A gated variant
 * sits out most of the calendar, and scoring those absences as flat returns
 * would drag every correlation toward whatever the shared silence looked
 * like — the gate would start to look like an independent idea purely by
 * being switched off.
 */
export function familyBreadth(
  family: readonly FamilySeries[],
  /*
   * What the members are called in the prose. The equity family are declared
   * hypotheses; the crypto family are modules, and calling them hypotheses on
   * a page that uses that word for the other family would read as one study.
   * Defaulted so the equity sentence stays byte-identical.
   */
  unit: string = "hypotheses"
): FamilyBreadth {
  const usable = family.filter((f) => f.periods.length >= MIN_PERIODS);
  const dates = [...new Set(usable.flatMap((f) => f.periods.map((p) => p.entryTime)))].sort(
    (a, b) => a - b
  );

  const aligned = new Map<string, ReturnSeries>();
  for (const f of usable) {
    const at = new Map(f.periods.map((p) => [p.entryTime, p.spread]));
    aligned.set(
      f.id,
      dates.map((d) => at.get(d) ?? null)
    );
  }

  const breadth = effectiveBreadth(aligned, dates.length);
  const n = breadth.n;
  const totalPairs = (n * (n - 1)) / 2;
  const unmeasurable = totalPairs - breadth.pairs_measured;

  /*
   * The generous end. sum(rho) over measured pairs is known exactly from the
   * mean the module already reports, so spreading it over EVERY pair is the
   * same closed form with the unmeasurable pairs entered as zero.
   */
  let bestCase: number | null = null;
  if (breadth.mean_pairwise_rho !== null && totalPairs > 0) {
    const rhoIfRestIndependent = (breadth.mean_pairwise_rho * breadth.pairs_measured) / totalPairs;
    const denom = 1 + (n - 1) * rhoIfRestIndependent;
    if (denom > 0) bestCase = Number((n / denom).toFixed(2));
  }

  return {
    declared: family.length,
    measured: usable.length,
    breadth,
    bestCaseBets: bestCase,
    pairsUnmeasurable: unmeasurable,
    distinctTests: breadth.distinct_tests,
    inversePairs: breadth.near_duplicates.filter((d) => d.rho < 0).length,
    sentence: describe(family.length, breadth, bestCase, unmeasurable, totalPairs, unit),
    duplicateSentence: breadth.near_duplicates.length > 0 ? duplicates(breadth) : null,
  };
}

function describe(
  declared: number,
  breadth: BreadthResult,
  bestCase: number | null,
  unmeasurable: number,
  totalPairs: number,
  unit: string
): string {
  if (breadth.effective_bets === null) {
    return (
      `${declared} declared ${unit}, but their period series could not be correlated ` +
      `well enough to say how many distinct ideas that is. Reported as unmeasured rather ` +
      `than as a headcount. ${breadth.sentence}`
    );
  }

  const measuredBets = breadth.effective_bets;
  const other = bestCase ?? measuredBets;
  const low = Math.min(measuredBets, other);
  const high = Math.max(measuredBets, other);
  /*
   * BETS, not ideas. `effective_bets` is a variance identity and nothing
   * else, and the sentence three clauses down exists to say that those two
   * words are not synonyms — opening with "independent ideas" would concede
   * the point before making it. The word only ever looked harmless because
   * on the equity family the two counts happen to agree.
   */
  const bracket =
    high > low + 0.05
      ? `between ${low.toFixed(1)} and ${high.toFixed(1)} independent bets`
      : `about ${measuredBets.toFixed(1)} independent bets`;

  /*
   * Only claim the true figure sits low when the correlation actually pulls
   * that way. On a family whose measurable pairs average near or below zero
   * there is no collapse to warn about, and warning anyway is how a caution
   * teaches its reader to skip it.
   */
  const missing =
    unmeasurable > 0 && other > measuredBets
      ? /*
         * No cause is named for the sparse pairs. On the equity family they
         * are mostly hypotheses at different holding periods; on the module
         * family they are modules that rarely take a position at all, and one
         * explanation carried onto the other family would be a confident
         * statement about something this function never measured.
         */
        ` The upper end assumes all ${unmeasurable} of ${totalPairs} pairs too sparse to correlate ` +
        `— pairs that never share enough dates — are perfectly independent. They are not, so the ` +
        `true figure sits nearer the lower end.`
      : unmeasurable > 0
        ? ` ${unmeasurable} of ${totalPairs} pairs were too sparse to correlate and are excluded ` +
          `rather than assumed independent; the measurable ones do not average positive, so no ` +
          `collapse is being claimed here.`
        : "";

  /*
   * THE COUNTING FIGURE, AND WHY IT IS NOT THE BRACKET.
   *
   * `effective_bets` uses signed rho, so an inversely-related pair reads as
   * diversification — true of a basket, false of a search. Where the family
   * contains an inversion the two answers separate by a lot, and the sentence
   * has to lead the reader to the one that matches the question being asked,
   * or the bracket becomes a way of overstating coverage rather than
   * measuring it.
   */
  const tests = breadth.distinct_tests;
  const inverse = breadth.near_duplicates.filter((d) => d.rho < 0);
  const diverges = tests !== null && tests < measuredBets - 0.5;
  const counting = !diverges
    ? ""
    : ` Those are independent BETS, not distinct IDEAS, and here the two part company: ` +
      `${inverse.length > 0 ? `${inverse.length} pair${inverse.length === 1 ? " is" : "s are"} inversely related` : `some pairs are inversely related`} ` +
      `— ${inverse.length > 0 ? `${inverse[0].a} and ${inverse[0].b} at ${inverse[0].rho.toFixed(3)}, ` : ""}` +
      `one signal and its own negation. A basket of the two hedges itself, which is why the bets ` +
      `figure is high. A SEARCH over the two has still only tried one thing. Counted that way — on ` +
      `mean |rho| rather than mean rho — the family is worth ${tests.toFixed(1)} distinct ideas, not ` +
      `${measuredBets.toFixed(1)}. For anything about coverage or multiple testing, ${tests.toFixed(1)} ` +
      `is the figure that applies.`;

  const forCorrection = Math.max(1, Math.round(diverges && tests !== null ? tests : high));
  /*
   * The correction spans the members that produced a p-value, which is the
   * measured set — the silent ones were never corrected across and claiming
   * they were would overstate the very strictness this sentence is crediting.
   */
  const stakes =
    ` This does not make a surviving result wrong. Correcting across ${breadth.n} correlated ` +
    `tests is stricter than correcting across ${forCorrection}, so a survivor cleared a harder ` +
    `bar rather than an easier one. What it costs is the COVERAGE the headcount implies: ` +
    `"${declared} ideas were tried" describes a broad search, and this one was narrow.`;

  /*
   * The duplicate pairs are NOT appended here — they are their own field, so
   * a consumer rendering them as a list does not print each pair twice. See
   * `duplicateSentence`.
   */
  /*
   * THE HEADCOUNT THE PERCENTAGE IS OF.
   *
   * `breadth.n` is what could be correlated, which is not always what was
   * declared: seven crypto modules never emit a directional call in the
   * replay and so have no series to correlate at all. Dividing by `n` and
   * calling it "of the headcount" reported 71% on a family where the measured
   * end is 45% of what was declared — a real overstatement, invisible on the
   * equity family only because there the two counts happen to be equal.
   *
   * Rather than pick a denominator, the unequal case refuses the percentage
   * and names both counts. The silent members are UNMEASURED, not
   * independent, and no fraction can say that.
   */
  const opening =
    breadth.n === declared
      ? `${declared} declared ${unit} are worth ${bracket} — ` +
        `${((measuredBets / declared) * 100).toFixed(0)}% of the headcount at the measured end.`
      : `${declared} declared ${unit}, of which ${breadth.n} produce enough readings to correlate ` +
        `at all; those ${breadth.n} are worth ${bracket}. The remaining ${declared - breadth.n} are ` +
        `unmeasured rather than independent, so no share of the headcount is quoted here — a ` +
        `percentage would have to treat silence as either evidence or nothing, and it is neither.`;

  return opening + counting + missing + stakes;
}

/**
 * The specific pairs that are one pair, named.
 *
 * A regime-gated variant is not a second test of an idea, it is the first
 * test's own numbers on a subset of its own dates — which is why these come
 * back at exactly 1.000 rather than merely high, and why naming them beats
 * any aggregate.
 */
function duplicates(breadth: BreadthResult): string {
  const shown = breadth.near_duplicates
    .slice(0, 4)
    .map((d) => `${d.a}/${d.b} at ${d.rho.toFixed(3)}`);
  const rest = breadth.near_duplicates_total - shown.length;
  /*
   * Compared on magnitude, because the list is now matched on magnitude. A
   * pair at -1.000 is as exact a duplicate as one at +1.000, and screening
   * this line on the signed value would describe the family as "0.95 or
   * above" while displaying a negative number three words later.
   */
  const strongest = Math.abs(breadth.near_duplicates[0].rho);
  const anyInverse = breadth.near_duplicates.some((d) => d.rho < 0);
  return (
    `${breadth.near_duplicates_total} pair${breadth.near_duplicates_total === 1 ? "" : "s"} ` +
    `correlate at ${strongest >= 0.999 ? "or above 0.999" : "0.95 or above"} in absolute value — ` +
    `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}. ` +
    `A pair at 1.000 is not two similar tests; it is one series and a subset of itself.` +
    (anyInverse
      ? ` A pair at -1.000 is the same statement upside down: one signal and its negation, ` +
        `which is one idea however many names it is given.`
      : "")
  );
}
