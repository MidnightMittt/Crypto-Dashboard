import { describe, expect, it } from "vitest";
import { ModuleGrade } from "@/lib/research/edgeGate";
import { gradeEvidence, GradeInputs } from "./evidenceGrade";

const grade = (over: Partial<ModuleGrade> & { metricId: string }): ModuleGrade => ({
  verdict: "edge",
  holdingPeriod: "24h",
  lowerBound: 0.6,
  effectiveN: 271,
  survivesFdr: true,
  sentence: "",
  ...over,
});

const inputs = (over: Partial<GradeInputs> = {}): GradeInputs => ({
  contributing: [{ id: "etfFlows", label: "ETF Flows", weight: 0.08 }],
  grades: { etfFlows: grade({ metricId: "etfFlows" }) },
  isStateBasis: false,
  ...over,
});

describe("gradeEvidence", () => {
  /*
   * THE LIVE CRYPTO SHAPE, 2026-08-15. Nine Edge voters, one validated, and
   * the failing eight carry 89% of the weight. A count would read "1 of 9";
   * the weighted answer is 11%, and that is the number that matters because
   * the composite is a weighted sum.
   */
  it("measures validated WEIGHT, not a count of modules", () => {
    const g = gradeEvidence(
      inputs({
        contributing: [
          { id: "funding", label: "Funding", weight: 0.15 },
          { id: "squeezeRisk", label: "Squeeze Risk", weight: 0.14 },
          { id: "openInterest", label: "Open Interest", weight: 0.09 },
          { id: "etfFlows", label: "ETF Flows", weight: 0.08 },
        ],
        grades: {
          etfFlows: grade({ metricId: "etfFlows" }),
          funding: grade({ metricId: "funding", verdict: "below-base-rate", survivesFdr: false }),
          squeezeRisk: grade({ metricId: "squeezeRisk", verdict: "not-distinguishable", survivesFdr: false }),
          openInterest: grade({ metricId: "openInterest", verdict: "below-base-rate", survivesFdr: false }),
        },
      })
    );
    expect(g.validatedCount).toBe(1);
    expect(g.contributingCount).toBe(4);
    // 0.08 of 0.46 total weight.
    expect(Math.round(g.validatedWeightPct)).toBe(17);
    expect(g.label).toBe("unvalidated");
    expect(g.sentence).toContain("hypothesis rather than an edge");
    expect(g.sentence).toContain("ETF Flows");
  });

  /*
   * BOTH TESTS, NOT EITHER. Clearing the Wilson gate on a family of
   * thirty-six looks is not enough, and surviving FDR while the effect is
   * too small to trade after costs is not enough either.
   */
  it("requires the gate AND the family correction", () => {
    const gateOnly = gradeEvidence(
      inputs({ grades: { etfFlows: grade({ metricId: "etfFlows", survivesFdr: false }) } })
    );
    expect(gateOnly.validatedCount).toBe(0);

    const fdrOnly = gradeEvidence(
      inputs({
        grades: {
          etfFlows: grade({ metricId: "etfFlows", verdict: "not-distinguishable", survivesFdr: true }),
        },
      })
    );
    expect(fdrOnly.validatedCount).toBe(0);
  });

  it("reads validated when the weight genuinely rests on proven signals", () => {
    const g = gradeEvidence(
      inputs({
        contributing: [
          { id: "etfFlows", label: "ETF Flows", weight: 0.7 },
          { id: "funding", label: "Funding", weight: 0.3 },
        ],
        grades: {
          etfFlows: grade({ metricId: "etfFlows" }),
          funding: grade({ metricId: "funding", verdict: "not-distinguishable", survivesFdr: false }),
        },
      })
    );
    expect(g.label).toBe("validated");
    expect(Math.round(g.validatedWeightPct)).toBe(70);
    expect(g.sentence).toContain("survived correction for multiple");
  });

  /*
   * A State basis never claimed to forecast, so scoring it 0% against a bar
   * it was not entered for would be the wrong criticism. Every equity is
   * this case today.
   */
  it("gives a State-basis read its own label rather than failing it", () => {
    const g = gradeEvidence(inputs({ isStateBasis: true, grades: {} }));
    expect(g.label).toBe("descriptive");
    expect(g.sentence).toContain("describes current conditions rather than forecasting");
    expect(g.sentence).not.toContain("hypothesis rather than an edge");
  });

  it("treats a module with no grade as unvalidated rather than assuming either way", () => {
    const g = gradeEvidence(inputs({ grades: {} }));
    expect(g.validatedCount).toBe(0);
    expect(g.label).toBe("unvalidated");
  });

  it("survives an empty or zero-weight contribution set without dividing by zero", () => {
    const empty = gradeEvidence(inputs({ contributing: [] }));
    expect(empty.validatedWeightPct).toBe(0);
    expect(Number.isFinite(empty.validatedWeightPct)).toBe(true);

    const zero = gradeEvidence(inputs({ contributing: [{ id: "a", label: "A", weight: 0 }] }));
    expect(zero.validatedWeightPct).toBe(0);
  });

  it("names the validated modules heaviest first, so the reader can go check them", () => {
    const g = gradeEvidence(
      inputs({
        contributing: [
          { id: "small", label: "Small", weight: 0.1 },
          { id: "big", label: "Big", weight: 0.9 },
        ],
        grades: {
          small: grade({ metricId: "small" }),
          big: grade({ metricId: "big" }),
        },
      })
    );
    expect(g.validatedModules).toEqual(["Big", "Small"]);
    expect(g.sentence).toContain("Big and Small");
  });
});
