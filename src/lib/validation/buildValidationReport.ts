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
}

export interface ValidationReport {
  rows: ValidationRow[];
  totals: { measured: number; cleared: number; unmeasured: number };
  /** Family size the equity study corrected across. */
  equityFamilySize: number;
  equityInstruments: number;
  costPp: number;
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
    "Passes only since the panel was declared, and nobody has investigated why. Its retirement is OPEN, not " +
    "overturned: a 5-day rebalance turns over roughly four times as often as the monthly hypotheses at the same flat " +
    "2pp charge, which is the cost assumption this family is weakest on. No module on this site quotes it.",
  "reversal-5d-skip1":
    "The falsification test for reversal-5d. It now passes, which removes the automatic retirement — but a robustness " +
    "test flipping after a change made for unrelated reasons is a reason to look harder, not to ship.",
};

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
      killCriteria: r.killCriteria,
      retiredBy: r.retiredBy,
      sentence: null,
      inUse: IN_USE.has(r.id),
      caution: CAUTIONS[r.id] ?? null,
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
      killCriteria: null,
      retiredBy: null,
      sentence: g.sentence ?? null,
      inUse: IN_USE.has(id),
      caution: null,
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
