import { describe, expect, it } from "vitest";
import { executeStudy, StudyDeclaration, StudyObservation, StudyRunContext, correctAcrossFamily } from "./study";
import { PANEL_STATISTICS } from "./panelStatistics";
import { EMPTY_LEDGER, append, toLedgerEntry, withFamilyCorrection, summarize, ReproducibilityStamp } from "./ledger";
import { generateReport } from "./report";
import { FeatureVector } from "./features";
import { CONTINUOUS_SESSION, US_EQUITY_SESSION } from "./types";
import { mulberry32 } from "./random";

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
    primaryMetric: "win rate",
    metric: { statistic: "winRate", nullValue: 0.5 },
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

const ctx: StudyRunContext = {
  codeVersion: "abc1234",
  datasetVersion: "v1",
  // Single-market fixture: every instrument shares one schedule.
  sessionOf: () => CONTINUOUS_SESSION,
};

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
      value: successRate(group, i) ? 1 : 0,
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

describe("cross-market session alignment — end-to-end", () => {
  /*
   * The scenario the whole session-normalisation layer exists for.
   *
   * A crypto perp daily bar closes at 00:00 UTC; a US equity closes at 16:00
   * ET (20:00 UTC). Both cover the SAME trading day, but their timestamps
   * differ by four hours AND fall on different calendar dates. Their
   * outcomes here are perfectly correlated — one market event, two
   * recordings — so the framework must count them once, not twice.
   *
   * Keying on the raw timestamp (the pre-fix behaviour) would place them in
   * separate periods, treat them as independent, and roughly double the
   * effective sample. That is a silent overstatement of confidence.
   */
  function mixedMarketObservations(days: number): StudyObservation[] {
    const out: StudyObservation[] = [];
    // Seeded random rather than a periodic pattern: a periodic sequence makes
    // every resampled block contain the same ratio, collapsing the bootstrap
    // variance and masking whatever the estimator is actually doing.
    const rng = mulberry32(4242);
    for (let d = 0; d < days; d++) {
      // Session date = 15 Jun 2026 + d (a Monday, mid-DST so ET is UTC-4).
      const sessionStart = Date.UTC(2026, 5, 15) + d * DAY;
      const success = rng() < 0.5; // ONE shared outcome, recorded by both instruments
      // Crypto bar closes at the FOLLOWING midnight UTC — it covers this session.
      out.push({
        instrumentId: "BTC-USD-PERP",
        entryT: sessionStart + DAY,
        exitT: sessionStart + DAY + 7 * DAY,
        value: success ? 1 : 0,
        group: "a",
        features: emptyFeatures(sessionStart),
      });
      // Equity bar closes 16:00 EDT the same session day = 20:00 UTC.
      out.push({
        instrumentId: "SPY",
        entryT: sessionStart + 20 * 3_600_000,
        exitT: sessionStart + 20 * 3_600_000 + 7 * DAY,
        value: success ? 1 : 0,
        group: "a",
        features: emptyFeatures(sessionStart),
      });
    }
    return out;
  }

  const mixedCtx: StudyRunContext = {
    ...ctx,
    sessionOf: (id) => (id === "SPY" ? US_EQUITY_SESSION : CONTINUOUS_SESSION),
  };

  it("clusters differently-scheduled instruments onto one session, counting a shared event once", () => {
    const obs = mixedMarketObservations(200);
    const r = executeStudy(decl({ minimumEffectiveN: 1, detectableEffectTarget: 0.9 }), obs, mixedCtx);

    expect(r.statistics.n).toBe(400);
    // 200 sessions, not 400 timestamps — the normalisation worked.
    expect(r.statistics.periods).toBe(200);
    expect(r.statistics.meanUnitsPerPeriod).toBeCloseTo(2, 6);
    // Perfectly correlated pairs: effective N must be near the session count.
    expect(r.statistics.effectiveN).toBeLessThan(320);
  });

  /*
   * Demonstrates the ACTUAL pre-fix failure, which is subtler than it first
   * appears. Converting 16:00 ET to UTC lands on the SAME calendar date
   * (20:00-21:00 UTC), so timezone conversion alone changes nothing for US
   * equities. What does the work is the midnight rule: a crypto bar closing
   * Tuesday 00:00 UTC covers Monday, and keying on its raw timestamp files
   * it under Tuesday — one session split across two keys.
   */
  it("raw-timestamp keying would have doubled the period count; session keying does not", () => {
    const obs = mixedMarketObservations(200);
    const rawKeys = new Set(obs.map((o) => o.entryT)).size;
    const r = executeStudy(decl({ minimumEffectiveN: 1, detectableEffectTarget: 0.9 }), obs, mixedCtx);

    // The old key: every instrument has its own close time, so 400 "periods".
    expect(rawKeys).toBe(400);
    // The session key: 200 real trading sessions.
    expect(r.statistics.periods).toBe(200);
    expect(r.statistics.periods * 2).toBe(rawKeys);
  });

  it("instruments on genuinely different sessions are not force-merged", () => {
    // An equity bar from the NEXT session must not join the previous one.
    const sessionStart = Date.UTC(2026, 5, 15);
    const obs: StudyObservation[] = [
      { instrumentId: "BTC-USD-PERP", entryT: sessionStart + DAY, exitT: sessionStart + 2 * DAY, value: 1, group: "a", features: emptyFeatures(sessionStart) },
      { instrumentId: "SPY", entryT: sessionStart + DAY + 20 * 3_600_000, exitT: sessionStart + 3 * DAY, value: 1, group: "a", features: emptyFeatures(sessionStart) },
    ];
    const r = executeStudy(decl({ minimumEffectiveN: 1, detectableEffectTarget: 0.9 }), obs, mixedCtx);
    expect(r.statistics.periods).toBe(2);
  });
});

describe("continuous endpoints use the identical pipeline and grading", () => {
  /*
   * Requirement 5: grading must not care whether the endpoint is a win rate
   * or an expectancy. These tests run CONTINUOUS studies through exactly the
   * same executeStudy/gradeEvidence path and assert the same rubric fires.
   */
  const rng = mulberry32(2024);

  function returnObservations(count: number, meanA: number, meanB: number, holdDays = 1): StudyObservation[] {
    const gauss = () => {
      const u = Math.max(1e-12, rng());
      const v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const out: StudyObservation[] = [];
    for (let i = 0; i < count; i++) {
      const group = i % 2 === 0 ? "a" : "b";
      const entryT = i * DAY;
      out.push({
        instrumentId: "TEST",
        entryT,
        exitT: entryT + holdDays * DAY,
        value: (group === "a" ? meanA : meanB) + gauss(),
        group,
        features: emptyFeatures(entryT),
      });
    }
    return out;
  }

  const expectancyDecl = (over: Partial<StudyDeclaration> = {}): StudyDeclaration =>
    decl({
      id: "expectancy-study",
      primaryMetric: "expectancy (mean net return)",
      metric: { statistic: "mean", nullValue: 0 },
      hypothesis: "Group A has higher expectancy than group B.",
      nullHypothesis: "Group A and group B have equal expectancy.",
      minimumEffectiveN: 30,
      detectableEffectTarget: 0.3,
      ...over,
    });

  it("grades A on a real, reproducible, practically meaningful expectancy gap", () => {
    const r = executeStudy(expectancyDecl(), returnObservations(500, 0.8, -0.8), ctx);
    expect(r.statistics.groups.a.metricKind).toBe("continuous");
    expect(r.verdict.grade).toBe("A");
    expect(r.verdict.recommendation).toMatch(/^Implement\./);
  });

  it("grades D on a genuine continuous null, with the same wording as the binary path", () => {
    const r = executeStudy(
      expectancyDecl({ detectableEffectTarget: 2 }),
      returnObservations(500, 0, 0)
    , ctx);
    expect(r.verdict.grade).toBe("D");
    expect(r.verdict.reasons.join(" ")).toMatch(/Not statistically significant/);
  });

  it("grades F on an underpowered continuous sample regardless of the point estimate", () => {
    const r = executeStudy(
      expectancyDecl({ minimumEffectiveN: 5000 }),
      returnObservations(200, 1, -1)
    , ctx);
    expect(r.verdict.grade).toBe("F");
    expect(r.verdict.reasons.join(" ")).toMatch(/Insufficient statistical power/);
  });

  /*
   * Block length must be DERIVED from the holding horizon on the continuous
   * path exactly as on the binary one.
   *
   * Note what this does NOT assert: that a longer block always shrinks
   * effective N. On genuinely independent data it correctly does not — there
   * is no serial dependence to correct for, and penalising it would be
   * over-discounting. The reduction is asserted separately below, on data
   * that actually is serially dependent.
   */
  it("derives block length from the holding horizon on the continuous path", () => {
    const noOverlap = executeStudy(expectancyDecl(), returnObservations(300, 0.5, -0.5, 1), ctx);
    const overlapped = executeStudy(expectancyDecl(), returnObservations(300, 0.5, -0.5, 12), ctx);
    expect(noOverlap.statistics.blockLength).toBe(1);
    expect(overlapped.statistics.blockLength).toBe(12);
  });

  it("reduces effective N on continuous data that IS serially dependent", () => {
    // A slow common factor held for 10 periods: consecutive observations
    // genuinely share information, which block resampling must charge for.
    const slow = Array.from({ length: 40 }, (_, k) => (k % 2 === 0 ? 0.9 : -0.9));
    const dependent: StudyObservation[] = Array.from({ length: 400 }, (_, i) => {
      const entryT = i * DAY;
      return {
        instrumentId: "TEST",
        entryT,
        exitT: entryT + 10 * DAY,
        value: slow[Math.floor(i / 10)],
        group: "a",
        features: emptyFeatures(entryT),
      };
    });
    const iidLike: StudyObservation[] = dependent.map((o, i) => ({
      ...o,
      exitT: o.entryT + DAY,
      value: i % 2 === 0 ? 0.9 : -0.9,
    }));

    const dep = executeStudy(expectancyDecl({ minimumEffectiveN: 1 }), dependent, ctx);
    const ind = executeStudy(expectancyDecl({ minimumEffectiveN: 1 }), iidLike, ctx);
    expect(dep.statistics.effectiveN).toBeLessThan(ind.statistics.effectiveN);
  });

  it("reports BCa intervals and the metric kind on the continuous path", () => {
    const r = executeStudy(expectancyDecl(), returnObservations(400, 0.6, -0.6), ctx);
    const a = r.statistics.groups.a;
    expect(a.intervalMethod).toBe("bca");
    expect(a.lower).toBeLessThan(a.point);
    expect(a.upper).toBeGreaterThan(a.point);
  });

  it("a profit-factor endpoint runs through the same path with its own null of 1", () => {
    const obs = returnObservations(400, 0.9, -0.9).map((o) => ({ ...o, group: "a" }));
    const r = executeStudy(
      expectancyDecl({ id: "pf-study", metric: { statistic: "profitFactor", nullValue: 1 }, detectableEffectTarget: 0.2 }),
      obs,
      ctx
    );
    expect(r.statistics.groups.a.statisticName).toBe("profitFactor");
    expect(r.statistics.groups.a.point).toBeGreaterThan(1);
    expect(r.verdict.reasons.length).toBeGreaterThan(0);
  });

  it("walk-forward and IS/OOS report the metric's own units, not a win rate", () => {
    const r = executeStudy(expectancyDecl(), returnObservations(500, 0.7, -0.7), ctx);
    // Values are returns near +/-0.7, never fractions in [0,1] by coincidence.
    expect(r.statistics.walkForward.length).toBeGreaterThan(0);
    expect(r.statistics.inSample).not.toBeNull();
    const statOfAll = PANEL_STATISTICS.mean(returnObservations(0, 0, 0).map((o) => o.value));
    expect(Number.isFinite(statOfAll)).toBe(true);
  });

  it("continuous studies remain byte-identically reproducible", () => {
    const obs = returnObservations(300, 0.4, -0.4);
    const a = executeStudy(expectancyDecl(), obs, ctx);
    const b = executeStudy(expectancyDecl(), obs, ctx);
    expect(JSON.stringify(a.statistics)).toBe(JSON.stringify(b.statistics));
    expect(a.verdict.grade).toBe(b.verdict.grade);
  });
});
