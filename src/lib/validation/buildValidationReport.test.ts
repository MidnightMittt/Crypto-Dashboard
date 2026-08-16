import { describe, expect, it } from "vitest";
import { ValidationInputs, buildValidationReport } from "./buildValidationReport";

function inputs(over: Partial<ValidationInputs> = {}): ValidationInputs {
  return {
    lab: {
      familySize: 12,
      instruments: 86,
      costPp: 2,
      results: [
        {
          id: "winner",
          verdict: "edge",
          survivesFdr: true,
          earnsEdge: true,
          n: 412,
          winRate: 0.602,
          lowerBound: 0.554,
          killCriteria: "Retire if the lower bound fails to clear 50% + costs.",
          retiredBy: null,
        },
        {
          id: "coin-flip",
          verdict: "not-distinguishable",
          survivesFdr: true,
          earnsEdge: false,
          n: 513,
          winRate: 0.552,
          lowerBound: 0.508,
          killCriteria: "Retire if the spread is not positive.",
          retiredBy: null,
        },
        {
          id: "worse-than-null",
          verdict: "below-base-rate",
          survivesFdr: false,
          earnsEdge: false,
          n: 504,
          winRate: 0.478,
          lowerBound: 0.435,
          killCriteria: "Retire if it fails the gate.",
          retiredBy: null,
        },
        {
          id: "retired",
          verdict: "edge",
          survivesFdr: true,
          earnsEdge: false,
          n: 100,
          winRate: 0.56,
          lowerBound: 0.53,
          killCriteria: "Retire if its twin fails.",
          retiredBy: "its-twin",
        },
      ],
    },
    moduleGrades: {
      etfFlows: { verdict: "edge", survivesFdr: true, effectiveN: 48, sentence: "Wins 60.0% at 24h against a 50.0% base rate." },
      funding: { verdict: "below-base-rate", survivesFdr: false, effectiveN: 33, sentence: "Reads below its own drift-matched null." },
      options: { verdict: "unmeasured", survivesFdr: false },
    },
    ...over,
  };
}

describe("buildValidationReport — the four outcomes", () => {
  const report = buildValidationReport(inputs());
  const byId = (id: string) => report.rows.find((r) => r.id === id)!;

  it("separates cleared, below-baseline, indistinct and unmeasured", () => {
    expect(byId("winner").outcome).toBe("cleared");
    expect(byId("worse-than-null").outcome).toBe("below");
    expect(byId("coin-flip").outcome).toBe("indistinct");
    expect(byId("options").outcome).toBe("unmeasured");
  });

  /*
   * "Unmeasured" is a statement about OUR DATA, not about the signal. Scoring
   * it as a failure would blame a module for our missing history, and would
   * also flatter the survival rate's denominator in the wrong direction.
   */
  it("excludes unmeasured modules from the measured denominator", () => {
    expect(report.totals.measured).toBe(6);
    expect(report.totals.unmeasured).toBe(1);
    expect(report.totals.cleared).toBe(2);
  });

  /*
   * A signal that survives FDR and clears its own gate can still be retired
   * by a robustness dependency. The outcome must follow earnsEdge, not the
   * verdict string, or a retired signal would appear on the page as a winner.
   */
  it("does not count a retired signal as cleared, despite its own verdict", () => {
    expect(byId("retired").verdict).toBe("edge");
    expect(byId("retired").outcome).not.toBe("cleared");
    expect(byId("retired").retiredBy).toBe("its-twin");
  });
});

describe("buildValidationReport — ordering", () => {
  /*
   * Grouped by outcome, NOT ranked by win rate. A page sorted by how good the
   * numbers look would put the best-looking figures on top regardless of
   * whether they survived anything, which is precisely the habit this page
   * exists to break.
   */
  it("orders cleared, then below-baseline, then indistinct, then unmeasured", () => {
    const outcomes = buildValidationReport(inputs()).rows.map((r) => r.outcome);
    const rank = { cleared: 0, below: 1, indistinct: 2, unmeasured: 3 } as const;
    for (let i = 1; i < outcomes.length; i++) {
      expect(rank[outcomes[i]]).toBeGreaterThanOrEqual(rank[outcomes[i - 1]]);
    }
  });

  it("puts the strongest evidence first inside a group", () => {
    const cleared = buildValidationReport(inputs()).rows.filter((r) => r.outcome === "cleared");
    expect(cleared[0].id).toBe("winner"); // n=412 beats etfFlows' n=48
  });
});

describe("buildValidationReport — the cautions", () => {
  /*
   * reversal-5d passes only since the panel was declared and nobody has
   * investigated why. Its retirement is open, not overturned. A page that
   * showed the verdict without the caveat would turn "it passed" into "it
   * shipped" by omission.
   */
  it("attaches the standing caution to the reversal pair", () => {
    const r = buildValidationReport(
      inputs({
        lab: {
          ...inputs().lab,
          results: [
            {
              id: "reversal-5d",
              verdict: "edge",
              survivesFdr: true,
              earnsEdge: true,
              n: 2168,
              winRate: 0.566,
              lowerBound: 0.545,
              killCriteria: "Retire if the spread is not positive.",
              retiredBy: null,
            },
          ],
        },
      })
    );
    expect(r.rows[0].caution).toMatch(/retirement is OPEN, not overturned/);
    expect(r.rows[0].caution).toMatch(/No module on this site quotes it/);
  });

  it("leaves ordinary results uncautioned", () => {
    expect(buildValidationReport(inputs()).rows.find((r) => r.id === "winner")!.caution).toBeNull();
  });
});

describe("buildValidationReport — provenance", () => {
  it("carries the family size the correction was made across", () => {
    const r = buildValidationReport(inputs());
    expect(r.equityFamilySize).toBe(12);
    expect(r.equityInstruments).toBe(86);
    expect(r.costPp).toBe(2);
  });

  it("preserves the declared kill criteria for lab hypotheses", () => {
    const r = buildValidationReport(inputs());
    expect(r.rows.find((x) => x.id === "winner")!.killCriteria).toMatch(/Retire if/);
    // Graded modules have no declared kill criteria; null rather than a blank.
    expect(r.rows.find((x) => x.id === "etfFlows")!.killCriteria).toBeNull();
  });

  /*
   * Crypto grades carry no bare win rate, only a sentence that already states
   * the rate, horizon and base rate. Dropping it would have meant rendering
   * "—" while better data sat unused in the artifact.
   */
  it("carries the engine's own sentence for graded modules", () => {
    const r = buildValidationReport(inputs());
    expect(r.rows.find((x) => x.id === "etfFlows")!.sentence).toMatch(/Wins 60\.0%/);
    expect(r.rows.find((x) => x.id === "winner")!.sentence).toBeNull();
  });

  it("labels which study each row came from", () => {
    const r = buildValidationReport(inputs());
    expect(r.rows.find((x) => x.id === "winner")!.family).toMatch(/equity study/);
    expect(r.rows.find((x) => x.id === "funding")!.family).toMatch(/Crypto composite/);
  });
});

describe("buildValidationReport — cleared is not the same as used", () => {
  /*
   * The page conflated these until a rendered check caught it: reversal-5d
   * sorts to the top of "cleared" on sample size while nothing quotes it,
   * under a heading claiming those were the signals allowed to move a
   * decision. Statistical survival and live consumption are separate facts.
   */
  it("marks only the results something on the site actually reads", () => {
    const r = buildValidationReport(
      inputs({
        lab: {
          ...inputs().lab,
          results: [
            {
              id: "momentum-12-1-long-only-broad-up",
              verdict: "edge",
              survivesFdr: true,
              earnsEdge: true,
              n: 412,
              winRate: 0.602,
              lowerBound: 0.554,
              killCriteria: "Retire if it fails the gate.",
              retiredBy: null,
            },
            {
              id: "momentum-12-1",
              verdict: "edge",
              survivesFdr: true,
              earnsEdge: true,
              n: 504,
              winRate: 0.571,
              lowerBound: 0.528,
              killCriteria: "Retire if it fails the gate.",
              retiredBy: null,
            },
          ],
        },
      })
    );
    expect(r.rows.find((x) => x.id === "momentum-12-1-long-only-broad-up")!.inUse).toBe(true);
    // Cleared the same bar, supports the one that ships, quoted by nothing.
    expect(r.rows.find((x) => x.id === "momentum-12-1")!.inUse).toBe(false);
    expect(r.rows.find((x) => x.id === "etfFlows")!.inUse).toBe(true);
  });

  it("does not mark a failing module as in use just because it is named", () => {
    expect(buildValidationReport(inputs()).rows.find((x) => x.id === "funding")!.inUse).toBe(false);
  });
});
