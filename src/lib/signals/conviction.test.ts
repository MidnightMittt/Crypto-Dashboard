import { describe, expect, it } from "vitest";
import {
  ConvictionInputs,
  assessConviction,
  validationCeiling,
  describeConvictionLevel,
} from "./conviction";

/** Strong inputs, unanimous signals — the only combination that reads high. */
const best = (over: Partial<ConvictionInputs> = {}): ConvictionInputs => ({
  confidencePct: 85,
  agreementPct: 100,
  grade: "validated",
  validatedWeightPct: 80,
  ...over,
});

describe("assessConviction — the validation ceiling", () => {
  it("allows high only when validated modules carry the weight", () => {
    const c = assessConviction(best());
    expect(c.level).toBe("high");
    expect(c.cappedBy).toBeNull();
  });

  /*
   * THE CASE THAT BINDS EVERY EQUITY PAGE TODAY. Perfect inputs, unanimous
   * signals, and nothing behind them has ever predicted anything out of
   * sample. That is context, and context does not earn high conviction.
   */
  it("caps a flawless-looking read when nothing has a forward record", () => {
    const c = assessConviction(best({ grade: "descriptive", validatedWeightPct: 0 }));
    expect(c.level).toBe("moderate");
    expect(c.cappedBy?.because).toContain("No signal behind this read has a forward record");
    // The RAW read is preserved, so the cap is visibly a cap and not a downgrade.
    expect(c.because).toContain("every signal agrees");
  });

  /*
   * 0% validated and 15% validated are both "mostly unproven". Letting 15%
   * buy a higher ceiling would claim a precision the grade boundaries do not
   * carry — only the wording differs.
   */
  it("treats every unvalidated grade as the same ceiling, differing only in wording", () => {
    const zero = assessConviction(best({ grade: "descriptive", validatedWeightPct: 0 }));
    const some = assessConviction(best({ grade: "unvalidated", validatedWeightPct: 15 }));
    const mixed = assessConviction(best({ grade: "mixed", validatedWeightPct: 45 }));
    expect([zero.level, some.level, mixed.level]).toEqual(["moderate", "moderate", "moderate"]);
    expect(some.cappedBy?.because).toContain("15%");
    expect(mixed.cappedBy?.because).toContain("45%");
  });

  /*
   * Thin evidence already drives the RAW read to low, so the validation
   * ceiling at moderate takes nothing away and is correctly not reported.
   * This is why evidence and agreement are not modelled as ceilings at all:
   * they cannot bind on anything the raw read has not already lowered.
   */
  it("does not claim a cap on a read that was already below it", () => {
    const c = assessConviction(best({ grade: "descriptive", confidencePct: 10 }));
    expect(c.level).toBe("low");
    expect(c.cappedBy).toBeNull();
  });

  /*
   * Contradiction drives the RAW read to low on its own, so the matching
   * ceiling takes nothing away and is correctly not reported as a cap — the
   * rule the next test states. The ceiling is still listed, because the
   * reasoning has to stay auditable whether or not it bound.
   */
  it("goes low on contradiction without needing a ceiling to do it", () => {
    const c = assessConviction(best({ agreementPct: 10 }));
    expect(c.level).toBe("low");
    expect(c.because).toContain("contradict each other");
    expect(c.cappedBy).toBeNull();
  });

  /*
   * A cap only counts as a cap when it actually lowers something. A thin-input
   * read is already low on its own merits, so nothing was taken away from it
   * and reporting a cap would overstate what the ceiling did.
   */
  it("reports no cap when the raw read was already at or below the ceiling", () => {
    const c = assessConviction(best({ confidencePct: 10, grade: "validated" }));
    expect(c.level).toBe("low");
    expect(c.cappedBy).toBeNull();
  });

  /* "Mostly agree" when every signal agrees is a small lie about the evidence. */
  it("describes unanimity as unanimity even at moderate conviction", () => {
    const c = assessConviction(best({ confidencePct: 50, agreementPct: 100, grade: "validated" }));
    expect(c.level).toBe("moderate");
    expect(c.because).toBe("Every signal agrees, but on evidence that is only partial.");

    const most = assessConviction(best({ confidencePct: 50, agreementPct: 75, grade: "validated" }));
    expect(most.because).toBe("Reasonable evidence, and most signals agree.");
  });

  /*
   * Split is not contradicting. The live page said "the signals contradict
   * each other" one clause before its own stat said "the signals are split".
   */
  it("distinguishes split signals from contradicting ones", () => {
    expect(assessConviction(best({ agreementPct: 50 })).because).toBe(
      "The signals are split, so any single read is a compromise."
    );
    expect(assessConviction(best({ agreementPct: 10 })).because).toBe(
      "The signals contradict each other."
    );
  });

  it("never returns a level above its lowest ceiling", () => {
    const grades = ["validated", "mixed", "unvalidated", "descriptive"] as const;
    for (const grade of grades) {
      for (const confidencePct of [5, 45, 85]) {
        for (const agreementPct of [0, 50, 80, 100]) {
          const input = { confidencePct, agreementPct, grade, validatedWeightPct: 30 };
          const c = assessConviction(input);
          const rank = { low: 0, moderate: 1, high: 2 } as const;
          const ceiling = validationCeiling(input);
          if (ceiling) {
            expect(rank[c.level], `${grade}/${confidencePct}/${agreementPct}`).toBeLessThanOrEqual(
              rank[ceiling.level]
            );
          }
        }
      }
    }
  });
});

describe("describeConvictionLevel — the cap leads when it binds", () => {
  /*
   * "Moderate" alone invites the reader to assume this ticker merely looked
   * average. The truth is that NO ticker can currently read higher, and that
   * is the more important fact.
   */
  it("says capped, and says what would lift it", () => {
    const line = describeConvictionLevel(
      assessConviction(best({ grade: "descriptive", validatedWeightPct: 0 }))
    );
    expect(line).toContain("Moderate, capped");
    expect(line).toContain("No signal behind this read has a forward record");
    expect(line).toContain("Lifts when");
  });

  it("states the plain read when nothing capped it", () => {
    const line = describeConvictionLevel(assessConviction(best()));
    expect(line).toBe("High. Strong evidence and every signal agrees.");
    expect(line).not.toContain("capped");
  });

  /* Every ceiling names something observable — never "more data". */
  it("promises an observable release condition, not a vague one", () => {
    const ceiling = validationCeiling(best({ grade: "descriptive" }))!;
    expect(ceiling.liftedWhen.length).toBeGreaterThan(10);
    expect(ceiling.liftedWhen.toLowerCase()).not.toContain("more data");
    expect(validationCeiling(best({ grade: "validated" }))).toBeNull();
  });
});
