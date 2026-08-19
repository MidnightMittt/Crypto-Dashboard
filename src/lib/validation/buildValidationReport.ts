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
  equityInstruments: number;
  costPp: number;
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

export interface ValidationInputs {
  lab: { familySize: number; instruments: number; costPp: number; results: LabResult[] };
  moduleGrades: Record<string, ModuleGrade>;
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
    equityInstruments: inputs.lab.instruments,
    costPp: inputs.lab.costPp,
  };
}
