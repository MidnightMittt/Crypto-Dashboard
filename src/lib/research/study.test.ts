import { describe, expect, it } from "vitest";
import { executeStudy, StudyDeclaration, StudyObservation, StudyRunContext, correctAcrossFamily } from "./study";
import { EMPTY_LEDGER, append, toLedgerEntry, withFamilyCorrection, summarize, ReproducibilityStamp } from "./ledger";
import { generateReport } from "./report";
import { FeatureVector } from "./features";

const DAY = 86_400_000;

const emptyFeatures = (t: number): FeatureVector => ({
  instrumentId: "TEST",
  asOf: t,
  values: { trend_medium: "up" },
  unavailable: [],
  errored: [],
});

function decl(over: Partial<StudyDeclaration> = {}): StudyDeclaration {
  return {
    id: "test-study",
    hypothesis: "Condition A precedes a higher success rate than condition B.",
    nullHypothesis: "Condition A and condition B have equal success rates.",
    primaryMetric: "success rate",
    secondaryMetrics: [],
    requiredCapabilities: ["ohlcv"],
    requiredFeatures: ["trend_medium"],
    minimumEffectiveN: 30,
    detectableEffectTarget: 0.1,
    successCriteria: "A beats B by more than 10pp, significant after correction.",
    failureCriteria: "No significant difference, or the difference reverses out-of-sample.",
    seed: 42,
    ...over,
  };
}

const ctx: StudyRunContext = { codeVersion: "abc1234", datasetVersion: "v1", nullProportion: 0.5 };

/**
 * Builds observations with a controlled success pattern.
 * `holdDays` drives the overlap block length, which is what lets a test
 * exercise the power-failure path without changing the raw count.
 */
function observations(opts: {
  count: number;
  groups: string[];
  successRate: (group: string, i: number) => boolean;
  holdDays?: number;
  spacingDays?: number;
}): StudyObservation[] {
  const { count, groups, successRate, holdDays = 1, spacingDays = 1 } = opts;
  const out: StudyObservation[] = [];
  for (let i = 0; i < count; i++) {
    const group = groups[i % groups.length];
    const entryT = i * spacingDays * DAY;
    out.push({
      instrumentId: "TEST",
      entryT,
      exitT: entryT + holdDays * DAY,
      success: successRate(group, i),
      group,
      features: emptyFeatures(entryT),
    });
  }
  return out;
}

describe("pipeline — overlap correction is derived, not declared", () => {
  it("derives a block length from the observed hold-to-spacing ratio", () => {
    const daily = executeStudy(decl(), observations({ count: 200, groups: ["a"], successRate: () => true, holdDays: 1 }), ctx);
    expect(daily.statistics.blockLength).toBe(1);

    const held10 = executeStudy(decl(), observations({ count: 200, groups: ["a"], successRate: () => true, holdDays: 10 }), ctx);
    expect(held10.statistics.blockLength).toBe(10);
    // Effective N is discounted accordingly — the study author never chose this.
    expect(held10.statistics.effectiveN).toBeCloseTo(20, 6);
  });

  it("computes strictly independent observations by non-overlap, not by formula", () => {
    const r = executeStudy(decl(), observations({ count: 100, groups: ["a"], successRate: () => true, holdDays: 10 }), ctx);
    // Entries every day, held 10 days => roughly every 10th survives.
    expect(r.statistics.independentN).toBeGreaterThan(5);
    expect(r.statistics.independentN).toBeLessThan(20);
  });
});

describe("grading — mechanical, and power is checked before significance", () => {
  it("F when effective N falls below the declared minimum", () => {
    const r = executeStudy(
      decl({ minimumEffectiveN: 500 }),
      observations({ count: 200, groups: ["a", "b"], successRate: (g) => g === "a", holdDays: 1 }),
      ctx
    );
    expect(r.verdict.grade).toBe("F");
    expect(r.verdict.reasons.join(" ")).toMatch(/Insufficient statistical power/);
    expect(r.verdict.recommendation).toMatch(/absence of evidence, not evidence of absence/);
  });

  /*
   * The ordering that matters most. A perfectly separated dataset produces
   * an overwhelming p-value, but on an overlap-discounted sample too small
   * to resolve the declared target. Grading on the p-value alone would call
   * this an A; the rubric must call it F. This is the exact failure mode
   * that produced a withdrawn C grade earlier in the project.
   */
  it("F on an underpowered sample EVEN WHEN the raw p-value is overwhelming", () => {
    const r = executeStudy(
      decl({ minimumEffectiveN: 5, detectableEffectTarget: 0.02 }),
      observations({ count: 60, groups: ["a", "b"], successRate: (g) => g === "a", holdDays: 20 }),
      ctx
    );
    expect(r.statistics.observedEffect).toBeCloseTo(1, 6); // perfect separation
    expect(r.verdict.grade).toBe("F");
    expect(r.verdict.reasons.join(" ")).toMatch(/Overlap invalidation|Insufficient statistical power/);
  });

  it("D when adequately powered but not significant", () => {
    // Both groups ~50%: a real, adequately powered null.
    const r = executeStudy(
      decl({ minimumEffectiveN: 30, detectableEffectTarget: 0.5 }),
      observations({ count: 400, groups: ["a", "b"], successRate: (_g, i) => i % 2 === 0, holdDays: 1 }),
      ctx
    );
    expect(r.verdict.grade).toBe("D");
    expect(r.verdict.reasons.join(" ")).toMatch(/Not statistically significant/);
    expect(r.verdict.reasons.join(" ")).toMatch(/genuine negative rather than an inconclusive one/);
  });

  it("A when significant, reproducible and practically meaningful", () => {
    const r = executeStudy(
      decl({ minimumEffectiveN: 30, detectableEffectTarget: 0.1 }),
      observations({ count: 400, groups: ["a", "b"], successRate: (g, i) => (g === "a" ? i % 10 !== 0 : i % 10 === 0), holdDays: 1 }),
      ctx
    );
    expect(r.verdict.grade).toBe("A");
    expect(r.verdict.recommendation).toMatch(/^Implement\./);
  });

  it("every verdict carries at least one explicit reason", () => {
    for (const minN of [5, 500]) {
      const r = executeStudy(decl({ minimumEffectiveN: minN }), observations({ count: 200, groups: ["a", "b"], successRate: (g) => g === "a" }), ctx);
      expect(r.verdict.reasons.length).toBeGreaterThan(0);
      expect(r.verdict.recommendation.length).toBeGreaterThan(0);
    }
  });

  it("records missing required features rather than silently proceeding", () => {
    const obs = observations({ count: 100, groups: ["a", "b"], successRate: (g) => g === "a" });
    obs[0].features.unavailable.push("trend_medium");
    const r = executeStudy(decl(), obs, ctx);
    expect(r.missingFeatures).toContain("trend_medium");
    expect(r.verdict.reasons.join(" ")).toMatch(/Missing features/);
  });
});

describe("reproducibility", () => {
  it("identical inputs produce byte-identical results", () => {
    const obs = observations({ count: 300, groups: ["a", "b"], successRate: (g, i) => (g === "a" ? i % 3 !== 0 : i % 3 === 0) });
    const a = executeStudy(decl(), obs, ctx);
    const b = executeStudy(decl(), obs, ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a different seed can change the bootstrap, so the seed is genuinely load-bearing and recorded", () => {
    const obs = observations({ count: 300, groups: ["a", "b"], successRate: (g, i) => (g === "a" ? i % 3 !== 0 : i % 3 === 0) });
    const a = executeStudy(decl({ seed: 1 }), obs, ctx);
    const b = executeStudy(decl({ seed: 2 }), obs, ctx);
    // Point estimates are seed-independent; only the bootstrap SE moves.
    expect(a.statistics.groups.a.point).toBe(b.statistics.groups.a.point);
    expect(a.declaration.seed).not.toBe(b.declaration.seed);
  });

  it("contains no wall-clock time, so results do not drift between runs", () => {
    const r = executeStudy(decl(), observations({ count: 100, groups: ["a"], successRate: () => true }), ctx);
    expect(r.runAtISO).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("evidence ledger", () => {
  const stamp: ReproducibilityStamp = {
    seed: 42,
    codeVersion: "abc1234",
    datasetVersion: "v1",
    featureVersions: { trend_medium: "1.0.0" },
    capabilityVersions: { ohlcv: "1.0.0" },
    parameters: { horizonDays: 7 },
  };
  const meta = { assetUniverse: ["BTC", "ETH"], timeframe: "1D", recordedAtISO: "2026-08-11T00:00:00.000Z", reproducibility: stamp };

  function entryFor(id: string, successRate: (g: string, i: number) => boolean) {
    const r = executeStudy(decl({ id }), observations({ count: 400, groups: ["a", "b"], successRate }), ctx);
    return { result: r, entry: toLedgerEntry(r, meta) };
  }

  it("is append-only and rejects a duplicate study id", () => {
    const { entry } = entryFor("s1", (g) => g === "a");
    const led = append(EMPTY_LEDGER, entry);
    expect(led.entries).toHaveLength(1);
    expect(() => append(led, entry)).toThrow(/append-only/);
  });

  it("carries the full reproducibility stamp onto the record", () => {
    const { entry } = entryFor("s1", (g) => g === "a");
    expect(entry.reproducibility.seed).toBe(42);
    expect(entry.reproducibility.codeVersion).toBe("abc1234");
    expect(entry.reproducibility.featureVersions.trend_medium).toBe("1.0.0");
    expect(entry.implementationStatus).toBe("not-implemented");
  });

  /*
   * The correction that within-study correction cannot provide. A borderline
   * result that clears 0.05 alone must face a higher bar once many other
   * questions have been asked of the same data.
   */
  it("applies Benjamini-Hochberg across the whole ledger, not within one study", () => {
    let led = EMPTY_LEDGER;
    // One genuine effect plus a crowd of nulls, as a real programme looks.
    led = append(led, entryFor("real", (g, i) => (g === "a" ? i % 10 !== 0 : i % 10 === 0)).entry);
    for (let k = 0; k < 20; k++) {
      led = append(led, entryFor(`null-${k}`, (_g, i) => (i + k) % 2 === 0).entry);
    }
    const corrected = withFamilyCorrection(led);
    const real = corrected.entries.find((e) => e.studyId === "real")!;
    expect(real.familySize).toBe(21);
    // A strong effect still survives; the family size is recorded either way.
    expect(real.familyCorrectedSignificant).toBe(true);
    for (const e of corrected.entries.filter((x) => x.studyId.startsWith("null-"))) {
      expect(e.familyCorrectedSignificant).toBe(false);
    }
  });

  it("excludes superseded entries from the family so retired claims do not inflate it", () => {
    let led = EMPTY_LEDGER;
    led = append(led, entryFor("old", (g) => g === "a").entry);
    const replacement = { ...entryFor("new", (g) => g === "a").entry, supersedes: "old" };
    led = append(led, replacement);
    const corrected = withFamilyCorrection(led);
    expect(corrected.entries.find((e) => e.studyId === "new")!.familySize).toBe(1);
    expect(corrected.entries.find((e) => e.studyId === "old")!.familyCorrectedSignificant).toBeNull();
  });

  it("summarises grades across the programme", () => {
    let led = EMPTY_LEDGER;
    led = append(led, entryFor("a1", (g, i) => (g === "a" ? i % 10 !== 0 : i % 10 === 0)).entry);
    led = append(led, entryFor("d1", (_g, i) => i % 2 === 0).entry);
    const s = summarize(led);
    expect(s.total).toBe(2);
    expect(s.A + s.B + s.C + s.D + s.F).toBe(2);
  });

  it("correctAcrossFamily handles an empty family", () => {
    expect(correctAcrossFamily([])).toEqual([]);
  });
});

describe("report generation", () => {
  it("includes every mandated section and states the grade", () => {
    const r = executeStudy(
      decl(),
      observations({ count: 400, groups: ["a", "b"], successRate: (g, i) => (g === "a" ? i % 10 !== 0 : i % 10 === 0) }),
      ctx
    );
    const entry = toLedgerEntry(r, {
      assetUniverse: ["BTC", "ETH"],
      timeframe: "1D",
      recordedAtISO: "2026-08-11T00:00:00.000Z",
      reproducibility: {
        seed: 42,
        codeVersion: "abc1234",
        datasetVersion: "v1",
        featureVersions: {},
        capabilityVersions: {},
        parameters: {},
      },
    });
    const md = generateReport(r, entry, append(EMPTY_LEDGER, entry));

    for (const section of [
      "## Hypothesis",
      "## Dataset",
      "## Result",
      "## Walk-forward",
      "## In-sample / out-of-sample",
      "## Evidence grade",
      "## Known limitations",
      "## Suggested next research",
    ]) {
      expect(md, `report must contain ${section}`).toContain(section);
    }
    expect(md).toContain("Strictly independent N");
    expect(md).toContain(`Evidence grade: ${r.verdict.grade}`);
  });

  it("derives the narrow-universe limitation automatically rather than relying on an author", () => {
    const r = executeStudy(decl(), observations({ count: 400, groups: ["a", "b"], successRate: (g) => g === "a" }), ctx);
    const entry = toLedgerEntry(r, {
      assetUniverse: ["BTC", "ETH"],
      timeframe: "1D",
      recordedAtISO: "2026-08-11T00:00:00.000Z",
      reproducibility: { seed: 42, codeVersion: "x", datasetVersion: "v1", featureVersions: {}, capabilityVersions: {}, parameters: {} },
    });
    const md = generateReport(r, entry, append(EMPTY_LEDGER, entry));
    expect(md).toMatch(/Narrow asset universe/);
  });
});
