/**
 * THE EDGE GATE, made executable.
 *
 * The roadmap's first standing rule says a signal "ships as Edge only if the
 * Wilson lower bound clears 50% + costs", and that failures ship too, as
 * published negative results. Both halves were prose. This module is the
 * first half; `/validation` is the second.
 *
 * ── Why this exists as product code rather than a script ──────────────
 *
 * A gate that lives in a one-off script gets run once, at the moment someone
 * wants an answer, and its verdict decays silently as data accumulates. The
 * classification it produces decides which modules are allowed to move a
 * trading decision, so it belongs where it can be tested, re-run and shown.
 *
 * ── Three deliberate strictnesses ─────────────────────────────────────
 *
 * 1. EFFECTIVE n ONLY. Overlapping forward windows share price action, so
 *    raw n overstates independent evidence — the correction that reversed
 *    conclusions before (see docs, and `effectiveSampleSize` in overlap.ts).
 *    A record without an effective sample cannot be judged, and says so
 *    rather than falling back to raw n.
 *
 * 2. THE BAR IS THE BASE RATE, NOT 50%. "Clears 50%" is only right when the
 *    asset has no drift. A long-only read in a rising market beats a coin
 *    flip by doing nothing at all, so the null is the measured base rate for
 *    that horizon and that instrument.
 *
 * 3. NOT-DISTINGUISHABLE IS ITS OWN VERDICT. Collapsing "we measured it and
 *    it is a coin flip" into "failed" loses the distinction a reader needs:
 *    the first is a finding, the second may just be a thin sample. Both are
 *    disqualifying for Edge; only one is worth re-testing later.
 */

/** A module's measured directional record at one holding period. */
export interface EdgeRecord {
  /** Fraction of calls that resolved in the claimed direction, 0-1. */
  winRate: number;
  /** What that rate must beat: the drift-matched null for the same horizon. */
  baseRate: number;
  /**
   * Independent observations after the overlap correction. Null when the
   * measurement exists but its effective sample was never computed — which
   * is a reason to withhold a verdict, never a reason to use raw n.
   */
  effectiveN: number | null;
  /** Which horizon this record describes, for display. */
  holdingPeriod: string;
}

export type EdgeVerdict =
  /** Wilson lower bound clears the base rate. Allowed to vote. */
  | "edge"
  /** Interval straddles the base rate — measured, and it is a coin flip. */
  | "not-distinguishable"
  /** Point estimate sits below the null. Reliably unhelpful, as measured. */
  | "below-base-rate"
  /** No usable measurement. Not a failure — an absence. */
  | "unmeasured";

export interface EdgeAssessment {
  verdict: EdgeVerdict;
  /** Wilson lower bound on the win rate, or null when unjudgeable. */
  lowerBound: number | null;
  /** Percentage points of lower bound above (+) or below (−) the null. */
  marginPp: number | null;
  effectiveN: number | null;
  holdingPeriod: string | null;
  /** One sentence stating the verdict and the number behind it. */
  sentence: string;
}

/**
 * Wilson score interval lower bound.
 *
 * Wilson rather than normal-approximation because the interesting cases here
 * are small samples and rates near the boundary, where the normal interval
 * misbehaves badly enough to invent significance — `funding` carries an
 * effective n of 17, which is exactly where that matters.
 *
 * Reimplemented rather than imported from scripts/backtest/metrics.ts: that
 * module is backtest tooling and this is product code, and a runtime import
 * across that boundary would drag the harness into the bundle.
 */
export function wilsonLowerBound(p: number, n: number, z = 1.96): number {
  if (!Number.isFinite(p) || !Number.isFinite(n) || n <= 0) return 0;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - half) / (1 + (z * z) / n));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Applies the gate. Costs are passed in percentage points of win rate that
 * the edge must additionally clear — a signal that beats the null by less
 * than it costs to trade is not an edge, it is a fee.
 */
export function assessEdge(record: EdgeRecord | null, costPp = 0): EdgeAssessment {
  if (
    record === null ||
    record.effectiveN === null ||
    record.effectiveN <= 0 ||
    !Number.isFinite(record.winRate)
  ) {
    return {
      verdict: "unmeasured",
      lowerBound: null,
      marginPp: null,
      effectiveN: record?.effectiveN ?? null,
      holdingPeriod: record?.holdingPeriod ?? null,
      sentence:
        "No measured directional record with an effective sample behind it. " +
        "This is an absence of evidence, not evidence the module fails.",
    };
  }

  const { winRate, baseRate, effectiveN, holdingPeriod } = record;
  const lowerBound = wilsonLowerBound(winRate, effectiveN);
  const bar = baseRate + costPp / 100;
  const marginPp = (lowerBound - bar) * 100;

  if (lowerBound > bar) {
    return {
      verdict: "edge",
      lowerBound,
      marginPp,
      effectiveN,
      holdingPeriod,
      sentence:
        `Wins ${pct(winRate)} at ${holdingPeriod} against a ${pct(baseRate)} base rate. ` +
        `The 95% lower bound is ${pct(lowerBound)} on ${effectiveN} independent observations — ` +
        `clear of the null, so this is allowed to move a decision.`,
    };
  }

  if (winRate < baseRate) {
    return {
      verdict: "below-base-rate",
      lowerBound,
      marginPp,
      effectiveN,
      holdingPeriod,
      sentence:
        `Wins ${pct(winRate)} at ${holdingPeriod} against a ${pct(baseRate)} base rate — ` +
        `below the null on ${effectiveN} independent observations. Doing nothing beat it.`,
    };
  }

  return {
    verdict: "not-distinguishable",
    lowerBound,
    marginPp,
    effectiveN,
    holdingPeriod,
    sentence:
      `Wins ${pct(winRate)} at ${holdingPeriod} against a ${pct(baseRate)} base rate, but the ` +
      `95% lower bound is ${pct(lowerBound)} on ${effectiveN} independent observations — the ` +
      `interval contains the null, so this is a coin flip as measured.`,
  };
}

/** Only an `edge` verdict earns a directional vote. */
export function mayVote(assessment: EdgeAssessment): boolean {
  return assessment.verdict === "edge";
}

// ── Grading a whole family at once ──────────────────────────────────────

/**
 * One module's validation verdict, computed once in the backtest harness and
 * committed so the runtime never re-derives it.
 *
 * This exists because the alternative — grading at request time — would put a
 * multiple-testing correction inside a page render, where it would be
 * recomputed per visitor against a family that changes with whatever happens
 * to be loaded. The correction is only meaningful over the WHOLE candidate
 * family, so it belongs where the whole family is in scope: the harness.
 */
export interface ModuleGrade {
  metricId: string;
  verdict: EdgeVerdict;
  /** Horizon the verdict was reached at, null when unmeasured. */
  holdingPeriod: string | null;
  lowerBound: number | null;
  effectiveN: number | null;
  /**
   * Whether this module's best cell survives Benjamini-Hochberg across every
   * (module, horizon) test in the family. A module can clear the Wilson gate
   * and still fail this — that is the point of running both.
   */
  survivesFdr: boolean;
  sentence: string;
}

export interface ModuleHorizons {
  metricId: string;
  horizons: Record<
    string,
    { effectiveN: number; winRate: number | null; baseRate: number | null; pValue?: number | null }
  >;
}

/**
 * Grades every module at its own most favourable horizon and corrects across
 * the family.
 *
 * `fdr` is injected rather than imported so this module stays free of a
 * dependency cycle and the correction used stays visible at the call site —
 * which correction was applied is part of the result's meaning.
 */
export function gradeModules(
  modules: ModuleHorizons[],
  fdr: (pValues: number[], q: number) => Array<{ significant: boolean }>,
  costPp = 0,
  q = 0.05
): ModuleGrade[] {
  /*
   * The family is every cell that produced a p-value, FAILURES INCLUDED.
   * Correcting only over cells that already looked good is the selection the
   * correction exists to undo.
   */
  const family: Array<{ metricId: string; hp: string; p: number }> = [];
  for (const m of modules) {
    for (const [hp, r] of Object.entries(m.horizons)) {
      if (typeof r.pValue === "number" && Number.isFinite(r.pValue)) {
        family.push({ metricId: m.metricId, hp, p: r.pValue });
      }
    }
  }
  const corrected = fdr(
    family.map((f) => f.p),
    q
  );
  const survivors = new Set(
    family.filter((_, i) => corrected[i]?.significant).map((f) => `${f.metricId}:${f.hp}`)
  );

  return modules.map((m) => {
    // Most favourable horizon by margin over its own null — see assessEdge.
    let best: EdgeRecord | null = null;
    let bestMargin = -Infinity;
    for (const [hp, r] of Object.entries(m.horizons)) {
      if (r.winRate === null || r.baseRate === null || r.effectiveN <= 0) continue;
      const margin = wilsonLowerBound(r.winRate, r.effectiveN) - r.baseRate;
      if (margin > bestMargin) {
        bestMargin = margin;
        best = {
          winRate: r.winRate,
          baseRate: r.baseRate,
          effectiveN: r.effectiveN,
          holdingPeriod: hp,
        };
      }
    }

    const a = assessEdge(best, costPp);
    return {
      metricId: m.metricId,
      verdict: a.verdict,
      holdingPeriod: a.holdingPeriod,
      lowerBound: a.lowerBound,
      effectiveN: a.effectiveN,
      survivesFdr: best !== null && survivors.has(`${m.metricId}:${best.holdingPeriod}`),
      sentence: a.sentence,
    };
  });
}

/**
 * A module has earned its vote only if it clears the gate AND survives the
 * family correction. Both, because they fail in different ways: the gate
 * catches effects too small to trade, the correction catches effects that
 * are only there because we looked thirty-six times.
 */
export function isValidatedEdge(grade: ModuleGrade): boolean {
  return grade.verdict === "edge" && grade.survivesFdr;
}

/**
 * THE COST AT WHICH A RESULT STOPS CLEARING.
 *
 * The gate asks "does the lower bound beat the null plus 2pp". That answers a
 * yes/no and hides the question a reader actually has: HOW WRONG would the
 * cost assumption have to be to change the answer?
 *
 * It is nearly free to answer. `lowerBound` is a function of the win rate and
 * the sample size only — costs enter the gate as a bar, never as an input to
 * the estimate — so the breakeven charge is just the distance from the bound
 * to the null.
 *
 * ── Why this is a sensitivity, not a tuning knob ──────────────────────
 *
 * Re-running a study at a cost chosen after seeing the result is exactly the
 * p-hacking the declared-family discipline exists to prevent. Reporting the
 * breakeven is the opposite move: the declared 2pp verdict stands unchanged,
 * and the reader additionally learns the margin. A signal clearing at 2pp
 * with a 2.1pp breakeven and one with a 5.4pp breakeven are wildly different
 * propositions that the verdict alone renders identical.
 *
 * This matters most for the weekly hypotheses, where the hypothesis file
 * already concedes a flat 2pp is light: a 5-day rebalance turns over roughly
 * four times as often as a monthly one at the same charge.
 */
export function breakevenCostPp(lowerBound: number | null, baseRate = 0.5): number | null {
  if (lowerBound === null || !Number.isFinite(lowerBound)) return null;
  return (lowerBound - baseRate) * 100;
}
