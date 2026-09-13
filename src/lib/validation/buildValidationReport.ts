/**
 * THE AUDIT — every signal this platform has measured, and how it did.
 *
 * Roadmap Phase 3's exit criterion is "each module shipped as Edge or State
 * or killed, with its verdict published on a negative-results page". This is
 * that page's data layer, and it is deliberately being built BEFORE the next
 * wave of signals: a platform that cannot show its existing failures has no
 * business adding candidates.
 *
 * ── Why this is the product, not a footnote ──────────────────────────
 *
 * Competitors sell indicators. The only durable thing here is the audit — a
 * public, corrected, cost-charged record including the things that did not
 * work. Measured today, 6 of 31 graded signals clear their own bar. That
 * ratio is not embarrassing; it is the reason the 6 are worth anything.
 *
 * ── The distinctions the grouping has to preserve ────────────────────
 *
 * Four outcomes, and flattening any two of them would destroy the point:
 *
 *   cleared        beat its baseline after costs AND survived correction
 *   indistinct     measured, and cannot be told apart from chance
 *   below          measured, and reads WORSE than its own null — the
 *                  strongest possible negative, and the most useful
 *   unmeasured     no historical source exists to test it against
 *
 * "Unmeasured" is not a failure and must never be scored as one; it is a
 * statement about our data, and those modules are displayed as context and
 * never allowed to vote. Conversely "below baseline" is not a shrug — a
 * signal reading below its own null is information, and hiding it among the
 * coin flips would waste the most decision-relevant result we have.
 */

import { breakevenCostPp } from "@/lib/research/edgeGate";
import {
  Decomposition,
  PairedDifference,
  describeDecomposition,
} from "@/lib/research/decomposition";

export type Outcome = "cleared" | "indistinct" | "below" | "unmeasured";

export interface ValidationRow {
  id: string;
  /** "Cross-sectional equity study" or "Crypto composite module". */
  family: string;
  outcome: Outcome;
  /** The engine's own verdict string, preserved verbatim. */
  verdict: string;
  survivesFdr: boolean;
  /** Null for modules whose record is a grade rather than a hypothesis run. */
  n: number | null;
  winRatePct: number | null;
  lowerBoundPct: number | null;
  /**
   * The cost charge at which this stops clearing its null, in percentage
   * points of win rate. Null when there is no bound.
   *
   * The verdict answers yes/no at the declared 2pp. This answers the question
   * behind it: how wrong would that assumption have to be? Two signals with
   * the same verdict and breakevens of 2.1pp and 5.4pp are entirely different
   * propositions, and the verdict alone renders them identical.
   */
  breakevenCostPp: number | null;
  /** Declared before the run, for lab hypotheses. Null for graded modules. */
  killCriteria: string | null;
  /** What retired it despite its own numbers passing. */
  retiredBy: string | null;
  /**
   * The engine's own sentence about this result, where it has one.
   *
   * Crypto module grades record no bare win rate — they record a SENTENCE
   * that already states the rate, the horizon and the base rate it was
   * judged against. Rendering "—" in a win-rate column while that sentence
   * sat unused would have been a worse page built from better data.
   */
  sentence: string | null;
  /**
   * Whether anything on the site actually CONSUMES this result.
   *
   * Clearing the statistical bar and driving a decision are different claims,
   * and the page conflated them until a rendered check caught it: reversal-5d
   * sits at the top of "cleared" on sample size alone while no module quotes
   * it, under a heading that said these were the signals allowed to move a
   * decision. Several momentum variants are likewise measured as supporting
   * evidence for the one that ships, not as separate live claims.
   */
  inUse: boolean;
  /**
   * A caveat that outranks the verdict — a result nobody has investigated,
   * or one whose passing is itself suspicious. Rendered LOUDER than the
   * verdict when present.
   */
  caution: string | null;
  /**
   * Selection skill separated from pool drift, against a declared benchmark.
   *
   * Null on long-short hypotheses BY DESIGN, not for want of data: a
   * dollar-neutral spread carries roughly no market exposure, so comparing it
   * to an index answers nothing. The page renders that as "does not apply"
   * rather than as a gap.
   */
  decomposition: RowDecomposition | null;
}

export interface RowDecomposition {
  benchmark: string;
  /**
   * Periods the BENCHMARK could cover, which is not the hypothesis's own `n`.
   * QQQ begins in 1999 while the panel reaches back to 1984, so these three
   * columns describe a shorter window than the win rate beside them. Carried
   * so the page can say so rather than implying one sample.
   */
  n: number;
  fromDate: string;
  toDate: string;
  selection: PairedDifference;
  poolDrift: PairedDifference;
  versusIndex: PairedDifference;
  /** Plain-English read, refusing to call selection skill an edge on its own. */
  reading: string;
}

export interface ValidationReport {
  rows: ValidationRow[];
  totals: { measured: number; cleared: number; unmeasured: number };
  /** Family size the equity study corrected across. */
  equityFamilySize: number;
  /**
   * What that family size is worth once the hypotheses are correlated against
   * each other — three of the twelve are one series partitioned by regime.
   * Carried BESIDE the headcount rather than replacing it, because a reader
   * needs both to read either: the count is what was declared, the breadth is
   * what was distinct. Null when the study predates the measurement.
   */
  equityFamilyBreadth: FamilyBreadthSummary | null;
  equityInstruments: number;
  costPp: number;
  /**
   * The same read on the crypto modules, and it does not tell the same story.
   *
   * On the equity family the signed and absolute answers agree (2.2 and 2.0),
   * so the breadth note is a footnote to a conclusion that holds either way.
   * On the modules they are 8.5 and 3.0, because two pairs are one series
   * twice and one of those pairs is inverted by design. Rendered in the crypto
   * section rather than folded in with the equity one: the families are
   * corrected separately and combining their breadth would invent a number
   * neither correction uses. Null when the artifact predates the measurement.
   */
  cryptoFamilyBreadth: FamilyBreadthSummary | null;
}

/** The breadth read, reduced to what the page renders. */
export interface FamilyBreadthSummary {
  effectiveBets: number | null;
  /** The other end of the bracket; see familyBreadth.ts on why it is a range. */
  otherEndBets: number | null;
  /**
   * The counting answer to `effectiveBets`'s portfolio answer, from mean
   * |rho|. Equal-ish on a family with no inverse pair, far lower where there
   * is one. Null on an artifact written before the measurement existed — the
   * page then shows the bets figure alone, which is what it always showed.
   */
  distinctTests: number | null;
  meanPairwiseRho: number | null;
  pairsMeasured: number;
  duplicatePairs: { a: string; b: string; rho: number }[];
  /**
   * The bracket in prose, with the duplicate pairs deliberately NOT named in
   * it — `familyBreadth` holds that clause in a separate `duplicateSentence`
   * for JSON readers with no table. This report has one consumer, and it
   * renders `duplicatePairs` as a list, so carrying the prose form too would
   * print every pair twice.
   */
  sentence: string;
}

/** The artifact's own decomposition block, exactly as runLab writes it. */
interface LabDecomposition {
  benchmark: string;
  decomposition: Decomposition;
}

interface LabResult {
  id: string;
  verdict: string;
  survivesFdr: boolean;
  earnsEdge: boolean;
  n: number;
  winRate: number;
  lowerBound: number | null;
  killCriteria: string;
  retiredBy: string | null;
  decomposition?: LabDecomposition | null;
}

interface ModuleGrade {
  verdict: string;
  survivesFdr: boolean;
  /** Null on unmeasured modules — the artifact distinguishes absent from zero. */
  effectiveN?: number | null;
  lowerBound?: number | null;
  /** The engine's own one-line record. Crypto grades carry no bare win rate. */
  sentence?: string;
}

/**
 * A `familyBreadth` block as `familyBreadth()` emits it — the lab artifact's
 * and the backtest artifact's are the same shape, so both flatten through
 * `summariseBreadth`.
 *
 * `distinct_tests` is optional because the equity artifact was written before
 * the counting figure existed. Absent must mean unmeasured; defaulting it to
 * the bets figure would silently assert the two agree, which on the module
 * family is the exact claim being refuted.
 */
interface LabFamilyBreadth {
  breadth: {
    effective_bets: number | null;
    distinct_tests?: number | null;
    mean_pairwise_rho: number | null;
    pairs_measured: number;
    near_duplicates: { a: string; b: string; rho: number }[];
  };
  bestCaseBets: number | null;
  sentence: string;
}

export interface ValidationInputs {
  lab: {
    familySize: number;
    instruments: number;
    costPp: number;
    results: LabResult[];
    /** Absent on artifacts written before the breadth measurement existed. */
    familyBreadth?: LabFamilyBreadth | null;
  };
  moduleGrades: Record<string, ModuleGrade>;
  /**
   * The module family's breadth, from backtestMetricStats.json. Same shape as
   * the lab's, and deliberately a sibling of `moduleGrades` rather than a
   * field inside it — it describes the family the grades were corrected
   * across, not any one grade.
   */
  moduleBreadth?: LabFamilyBreadth | null;
}

/**
 * Flattens the artifact's breadth block for the page.
 *
 * Returns null rather than a zero-filled shape when the study predates the
 * measurement — the page then says the breadth is unmeasured, which is true,
 * instead of rendering "0 effective bets", which would be a far stronger and
 * entirely invented claim.
 */
function summariseBreadth(fb: LabFamilyBreadth | null | undefined): FamilyBreadthSummary | null {
  if (!fb?.breadth) return null;
  return {
    effectiveBets: fb.breadth.effective_bets,
    otherEndBets: fb.bestCaseBets,
    distinctTests: fb.breadth.distinct_tests ?? null,
    meanPairwiseRho: fb.breadth.mean_pairwise_rho,
    pairsMeasured: fb.breadth.pairs_measured,
    duplicatePairs: fb.breadth.near_duplicates,
    sentence: fb.sentence,
  };
}

function outcomeOf(verdict: string, earnsEdge: boolean): Outcome {
  if (verdict === "unmeasured") return "unmeasured";
  if (verdict === "below-base-rate") return "below";
  if (earnsEdge) return "cleared";
  return "indistinct";
}

/**
 * Results whose PASSING is the thing to be suspicious about.
 *
 * `reversal-5d` was retired by its skip-a-session twin — passing alone is the
 * signature of a bid-ask bounce rather than information. After the panel was
 * declared, the twin started passing too, so the retirement no longer fires
 * automatically. Nobody has investigated whether that is real, and the
 * standing objection is untouched: a 5-day rebalance is roughly four times
 * the turnover of the monthly hypotheses at the same flat 2pp charge, which
 * the hypothesis file itself already flags as light for weekly horizons.
 *
 * Nothing on the site quotes reversal, so no claim rests on it. Recording the
 * caution here is what keeps "it passed" from silently becoming "it shipped".
 */
/**
 * The signals something on this site actually reads, declared rather than
 * inferred.
 *
 * Inferring it — "anything that cleared" — is exactly the conflation this
 * exists to prevent, and inferring it from imports would silently change
 * meaning the next time a module is refactored. A short hand-maintained list
 * that a reader can check against the codebase is the honest shape.
 */
const IN_USE = new Set([
  // Read by equityMomentum.ts, and the only item The Brief can offer.
  "momentum-12-1-long-only-broad-up",
  // Its complement, quoted by the module when it withholds the forecast.
  "momentum-12-1-long-only-broad-down",
  // The one crypto module that earns its vote in the composite.
  "etfFlows",
]);

const CAUTIONS: Record<string, string> = {
  "reversal-5d":
    "RESOLVED against it, on its own breakeven. This clears at the declared 2pp but stops clearing at 4.5pp, and it " +
    "rebalances every 5 sessions against the monthly hypotheses' 21 — roughly 4.2 times the turnover. If costs scale " +
    "with turnover, the comparable charge is about 8.4pp, well past where this dies. The verdict beside it is " +
    "correct at the cost that was declared; it does not survive the objection the declaration already flagged.",
  "reversal-5d-skip1":
    "Thinner still: it stops clearing at 2.4pp, barely above the 2pp it was charged, on a strategy turning over four " +
    "times as often as the monthly ones. Its passing removed the automatic retirement of reversal-5d; its breakeven " +
    "removes the reason to care.",
};

/**
 * Reshape the artifact's decomposition for display, or null.
 *
 * The reading is composed HERE rather than stored, so the words and the
 * numbers cannot drift apart in the file — the same rule the narrative
 * composer follows for verdicts.
 */
function toRowDecomposition(d: LabDecomposition | null | undefined): RowDecomposition | null {
  if (!d) return null;
  const c = d.decomposition;
  const periods = c.periods;
  if (periods.length === 0) return null;
  return {
    benchmark: d.benchmark,
    n: c.signalMinusIndex.n,
    fromDate: periods[0],
    toDate: periods[periods.length - 1],
    selection: c.signalMinusUniverse,
    poolDrift: c.universeMinusIndex,
    versusIndex: c.signalMinusIndex,
    reading: describeDecomposition(c),
  };
}

export function buildValidationReport(inputs: ValidationInputs): ValidationReport {
  const rows: ValidationRow[] = [];

  for (const r of inputs.lab.results) {
    rows.push({
      id: r.id,
      family: "Cross-sectional equity study",
      outcome: outcomeOf(r.verdict, r.earnsEdge),
      verdict: r.verdict,
      survivesFdr: r.survivesFdr,
      n: r.n,
      winRatePct: r.winRate * 100,
      lowerBoundPct: r.lowerBound === null ? null : r.lowerBound * 100,
      breakevenCostPp: breakevenCostPp(r.lowerBound),
      killCriteria: r.killCriteria,
      retiredBy: r.retiredBy,
      sentence: null,
      inUse: IN_USE.has(r.id),
      caution: CAUTIONS[r.id] ?? null,
      decomposition: toRowDecomposition(r.decomposition),
    });
  }

  for (const [id, g] of Object.entries(inputs.moduleGrades)) {
    rows.push({
      id,
      family: "Crypto composite module",
      outcome: outcomeOf(g.verdict, g.verdict === "edge" && g.survivesFdr),
      verdict: g.verdict,
      survivesFdr: g.survivesFdr,
      n: g.effectiveN ?? null,
      winRatePct: null,
      lowerBoundPct: g.lowerBound === undefined || g.lowerBound === null ? null : g.lowerBound * 100,
      breakevenCostPp: breakevenCostPp(g.lowerBound ?? null),
      killCriteria: null,
      retiredBy: null,
      sentence: g.sentence ?? null,
      inUse: IN_USE.has(id),
      caution: null,
      /*
       * Crypto modules are graded, not ranked against a panel. There is no
       * universe leg to separate from, so the decomposition is not merely
       * absent here — it is undefined for this kind of result.
       */
      decomposition: null,
    });
  }

  /*
   * Ordered cleared → below → indistinct → unmeasured, and NOT by how well
   * each did. A page that ranked by win rate would put the best-looking
   * numbers on top regardless of whether they mean anything, which is the
   * habit this whole apparatus exists to break. Within a group, strongest
   * evidence first.
   */
  const rank: Record<Outcome, number> = { cleared: 0, below: 1, indistinct: 2, unmeasured: 3 };
  rows.sort((a, b) => rank[a.outcome] - rank[b.outcome] || (b.n ?? 0) - (a.n ?? 0) || a.id.localeCompare(b.id));

  const measured = rows.filter((r) => r.outcome !== "unmeasured").length;
  return {
    rows,
    totals: {
      measured,
      cleared: rows.filter((r) => r.outcome === "cleared").length,
      unmeasured: rows.length - measured,
    },
    equityFamilySize: inputs.lab.familySize,
    equityFamilyBreadth: summariseBreadth(inputs.lab.familyBreadth),
    equityInstruments: inputs.lab.instruments,
    costPp: inputs.lab.costPp,
    cryptoFamilyBreadth: summariseBreadth(inputs.moduleBreadth),
  };
}
