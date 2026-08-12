import { CapabilityKey } from "./types";
import { FeatureVector } from "./features";
import { detectableDifferenceFromSe, nonOverlappingByTime } from "./overlap";
import { panelBootstrapProportion, panelDifference, PanelAdjustedProportion, PanelObservation } from "./panelBootstrap";
import { benjaminiHochberg } from "./multipleTesting";

/**
 * THE RESEARCH FRAMEWORK — the only approved path for quantitative study.
 *
 * Three phases of this project produced conclusions that later had to be
 * withdrawn: a weekly-regime effect that vanished under overlap correction,
 * a harmonic result graded C on a p-value computed under an independence
 * assumption the data did not satisfy, and a regime effect that survived
 * only while the label was too unstable to use. None of those were careless
 * — each followed a hand-built pipeline that omitted one step.
 *
 * The response is architectural rather than procedural. A study here cannot
 * omit a step, because it does not own the pipeline: it declares what it is
 * testing and supplies observations, and the framework does the rest. There
 * is deliberately no API through which a study can compute its own p-value,
 * assign its own grade, or skip validation.
 *
 * ── Mandatory-by-construction ───────────────────────────────────────────
 *
 * Every field of `StudyDeclaration` is required and non-optional, so a
 * study missing its null hypothesis, its minimum sample size or its failure
 * criteria will not typecheck. That is the strongest enforcement available
 * without a runtime registry, and it happens before the study can run once.
 */

// ── Declaration ─────────────────────────────────────────────────────────

/**
 * Everything that must be fixed BEFORE a study executes. Every field is
 * required; there are no optionals and no defaults, because a default would
 * let an author skip the thinking the field exists to force.
 */
export interface StudyDeclaration {
  id: string;
  /** Written in full. "Does X work?" is not a hypothesis; "X improves win rate relative to Y" is. */
  hypothesis: string;
  /** What must be true for the hypothesis to be wrong. Stating it prevents post-hoc reinterpretation of a null. */
  nullHypothesis: string;
  primaryMetric: string;
  secondaryMetrics: string[];
  requiredCapabilities: CapabilityKey[];
  requiredFeatures: string[];
  /**
   * The smallest EFFECTIVE (overlap-corrected) sample the author will accept
   * as informative, declared before seeing the data. Falling short is an
   * automatic F — not a caveat in a footnote.
   */
  minimumEffectiveN: number;
  /** The smallest effect worth acting on, as a proportion difference (0.05 = 5pp). Grading compares the achievable resolution against this. */
  detectableEffectTarget: number;
  successCriteria: string;
  failureCriteria: string;
  /** Fixed seed. Reproducibility is not optional, so neither is this. */
  seed: number;
}

// ── Observations ────────────────────────────────────────────────────────

/**
 * One unit of evidence. The study produces these; the framework analyses
 * them and the study never sees a statistic it could have influenced.
 *
 * `entryT`/`exitT` are what make overlap correction possible. A study that
 * cannot say when its observation window closed cannot be corrected, which
 * is why `exitT` is required rather than inferred.
 */
export interface StudyObservation {
  instrumentId: string;
  entryT: number;
  exitT: number;
  /** The binary outcome the primary metric is a rate of. */
  success: boolean;
  /** Which arm this observation belongs to. Two distinct groups triggers a comparison; one group tests against `nullProportion`. */
  group: string;
  features: FeatureVector;
}

export interface StudyRunContext {
  /** Identifies the exact code that produced the result. Recorded, never inspected. */
  codeVersion: string;
  datasetVersion: string;
  /** Null proportion for a single-group study. Ignored when two groups exist. */
  nullProportion: number;
}

// ── Results ─────────────────────────────────────────────────────────────

export interface WalkForwardFold {
  index: number;
  n: number;
  successRate: number;
}

export interface StudyStatistics {
  n: number;
  effectiveN: number;
  /** Independent observations after greedy non-overlap selection — the honest count, computed not assumed. */
  independentN: number;
  blockLength: number;
  groups: Record<string, PanelAdjustedProportion>;
  /** Distinct time periods, and mean units observed per period. A width above 1.0 means cross-sectional correction was doing work. */
  periods: number;
  meanUnitsPerPeriod: number;
  /** Present only for a two-group study. */
  difference: { value: number; se: number; pValue: number; lower: number; upper: number } | null;
  /** The primary p-value: the difference for a two-group study, else the single group against the null. */
  primaryPValue: number;
  detectableEffect: number;
  observedEffect: number;
  walkForward: WalkForwardFold[];
  /** Sign-consistency of the folds. A study whose effect changes direction across folds is not reproducible. */
  walkForwardConsistent: boolean;
  inSample: { n: number; successRate: number } | null;
  outOfSample: { n: number; successRate: number } | null;
  /** Do IS and OOS agree in direction relative to the null? */
  outOfSampleConsistent: boolean | null;
}

export type EvidenceGrade = "A" | "B" | "C" | "D" | "F";

export interface StudyVerdict {
  grade: EvidenceGrade;
  /** Every reason the grade is what it is. Never empty. */
  reasons: string[];
  recommendation: string;
}

export interface StudyResult {
  declaration: StudyDeclaration;
  context: StudyRunContext;
  statistics: StudyStatistics;
  verdict: StudyVerdict;
  /** Capabilities/features the observations lacked. Non-empty means the study ran degraded, and grading knows it. */
  missingCapabilities: CapabilityKey[];
  missingFeatures: string[];
  runAtISO: string;
}

// ── Pipeline ────────────────────────────────────────────────────────────

const WALK_FORWARD_FOLDS = 4;
const IS_FRACTION = 0.7;

/**
 * Block length in PERIODS, derived from the data rather than declared.
 *
 * Counting periods rather than observations is what prevents
 * double-discounting. Cross-sectional dependence is handled entirely by the
 * panel estimator keeping each period's observations together; inflating the
 * block length for a wider universe as well would charge for the same
 * dependence twice. Earlier hand-written scripts did exactly that (block =
 * 2 x horizon for two assets) and this replaces it.
 *
 * Derived as median hold divided by median spacing BETWEEN DISTINCT PERIODS,
 * so an author cannot choose a flattering value.
 */
function deriveBlockLength(observations: StudyObservation[]): number {
  if (observations.length < 3) return 1;
  const sorted = [...observations].sort((a, b) => a.entryT - b.entryT);
  const periodTimes = [...new Set(sorted.map((o) => o.entryT))].sort((a, b) => a - b);
  const spacings: number[] = [];
  for (let i = 1; i < periodTimes.length; i++) spacings.push(periodTimes[i] - periodTimes[i - 1]);
  if (spacings.length === 0) return 1;
  const holds = sorted.map((o) => Math.max(0, o.exitT - o.entryT));
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const spacing = median(spacings);
  const hold = median(holds);
  if (spacing <= 0) return 1;
  return Math.max(1, Math.min(periodTimes.length, Math.round(hold / spacing) || 1));
}

function rate(obs: StudyObservation[]): number {
  return obs.length === 0 ? 0 : obs.filter((o) => o.success).length / obs.length;
}

/**
 * Executes the full mandated pipeline. A study cannot call any part of this
 * selectively — that is the point.
 */
export function executeStudy(
  declaration: StudyDeclaration,
  observations: StudyObservation[],
  context: StudyRunContext
): StudyResult {
  const chronological = [...observations].sort((a, b) => a.entryT - b.entryT);

  // 3. Capability + feature validation, from what the observations actually carried.
  const missingCapabilities: CapabilityKey[] = [];
  const missingFeatures = new Set<string>();
  for (const obs of chronological) {
    for (const f of declaration.requiredFeatures) {
      if (obs.features.unavailable.includes(f) || !(f in obs.features.values)) missingFeatures.add(f);
    }
  }

  // 5-6. Effective sample size and overlap correction.
  const blockLength = deriveBlockLength(chronological);
  const independent = nonOverlappingByTime(chronological, (o) => o.entryT, (o) => o.exitT);

  const groupNames = [...new Set(chronological.map((o) => o.group))].sort();
  /*
   * `entryT` doubles as the period key. Observations from different
   * instruments sampled at the same close share a timestamp, so grouping by
   * it is exactly the cross-sectional clustering the panel estimator needs —
   * no extra field, and no way for a caller to forget to populate one.
   */
  const asPanel = (obs: StudyObservation[]): PanelObservation[] =>
    obs.map((o) => ({ period: o.entryT, unitId: o.instrumentId, value: o.success ? 1 : 0 }));

  const groups: Record<string, PanelAdjustedProportion> = {};
  for (const g of groupNames) {
    const res = panelBootstrapProportion(
      asPanel(chronological.filter((o) => o.group === g)),
      blockLength,
      context.nullProportion,
      2000,
      declaration.seed
    );
    if (res) groups[g] = res;
  }
  const wholePanel = panelBootstrapProportion(asPanel(chronological), blockLength, context.nullProportion, 1, declaration.seed);

  // 8. Confidence intervals arrive with the bootstrap above; the difference
  // is computed here for the two-group case.
  let difference: StudyStatistics["difference"] = null;
  let primaryPValue = 1;
  let observedEffect = 0;
  let detectableEffect = 1;

  if (groupNames.length >= 2 && groups[groupNames[0]] && groups[groupNames[1]]) {
    const a = groups[groupNames[0]];
    const b = groups[groupNames[1]];
    const d = panelDifference(a, b);
    difference = { value: d.difference, se: d.se, pValue: d.pValue, lower: d.lower, upper: d.upper };
    primaryPValue = d.pValue;
    observedEffect = Math.abs(d.difference);
    detectableEffect = detectableDifferenceFromSe(d.se);
  } else if (groupNames.length === 1 && groups[groupNames[0]]) {
    const only = groups[groupNames[0]];
    primaryPValue = only.pValue;
    observedEffect = Math.abs(only.point - context.nullProportion);
    detectableEffect = detectableDifferenceFromSe(only.bootstrapSe);
  }

  // 9. Walk-forward: sequential folds over the independent subsample, so a
  // fold cannot borrow information from its neighbours.
  const walkForward: WalkForwardFold[] = [];
  if (independent.length >= WALK_FORWARD_FOLDS * 5) {
    const size = Math.floor(independent.length / WALK_FORWARD_FOLDS);
    for (let i = 0; i < WALK_FORWARD_FOLDS; i++) {
      const slice = independent.slice(i * size, i === WALK_FORWARD_FOLDS - 1 ? independent.length : (i + 1) * size);
      walkForward.push({ index: i + 1, n: slice.length, successRate: rate(slice) });
    }
  }
  const walkForwardConsistent =
    walkForward.length > 0 &&
    (walkForward.every((f) => f.successRate >= context.nullProportion) ||
      walkForward.every((f) => f.successRate <= context.nullProportion));

  // 10. Chronological IS/OOS split of the independent subsample.
  let inSample: StudyStatistics["inSample"] = null;
  let outOfSample: StudyStatistics["outOfSample"] = null;
  let outOfSampleConsistent: boolean | null = null;
  if (independent.length >= 20) {
    const cut = Math.floor(independent.length * IS_FRACTION);
    const isPart = independent.slice(0, cut);
    const oosPart = independent.slice(cut);
    inSample = { n: isPart.length, successRate: rate(isPart) };
    outOfSample = { n: oosPart.length, successRate: rate(oosPart) };
    outOfSampleConsistent =
      Math.sign(inSample.successRate - context.nullProportion) ===
      Math.sign(outOfSample.successRate - context.nullProportion);
  }

  const statistics: StudyStatistics = {
    n: chronological.length,
    /*
     * Derived from the realised bootstrap variance rather than composed from
     * separate temporal and cross-sectional factors — composition is exactly
     * where a double discount would hide. Falls back to the raw count only
     * when the panel is degenerate and carries no variance to invert.
     */
    effectiveN: Object.values(groups).reduce((a, g) => a + g.effectiveN, 0) || chronological.length,
    periods: wholePanel?.periods ?? 0,
    meanUnitsPerPeriod: wholePanel?.panel.meanUnitsPerPeriod ?? 0,
    independentN: independent.length,
    blockLength,
    groups,
    difference,
    primaryPValue,
    detectableEffect,
    observedEffect,
    walkForward,
    walkForwardConsistent,
    inSample,
    outOfSample,
    outOfSampleConsistent,
  };

  return {
    declaration,
    context,
    statistics,
    verdict: gradeEvidence(declaration, statistics, missingCapabilities, [...missingFeatures]),
    missingCapabilities,
    missingFeatures: [...missingFeatures],
    runAtISO: new Date(0).toISOString(), // set by the ledger at record time; fixed here so results stay byte-identical across runs
  };
}

// ── Mechanical grading ──────────────────────────────────────────────────

/**
 * Grades are computed, never chosen. The rubric is ordered so that the most
 * disqualifying condition wins, which is why power is checked before
 * significance: a significant result on an underpowered sample is more
 * likely to be noise than signal, and grading it on its p-value alone is
 * exactly the mistake this framework exists to prevent.
 *
 * Rubric:
 *   F  effective sample below the declared minimum, or the study could not
 *      resolve its own declared target effect
 *   D  not significant after correction
 *   C  significant, but walk-forward or out-of-sample is inconsistent
 *   B  significant, consistent, but the effect is below the declared
 *      practical threshold
 *   A  significant, consistent in both, and practically meaningful
 */
export function gradeEvidence(
  declaration: StudyDeclaration,
  stats: StudyStatistics,
  missingCapabilities: CapabilityKey[],
  missingFeatures: string[]
): StudyVerdict {
  const reasons: string[] = [];

  if (missingCapabilities.length > 0) reasons.push(`Missing capabilities: ${missingCapabilities.join(", ")}.`);
  if (missingFeatures.length > 0) reasons.push(`Missing features: ${missingFeatures.join(", ")}.`);

  // --- F: power failures, checked first and independently of any p-value.
  if (stats.effectiveN < declaration.minimumEffectiveN) {
    reasons.push(
      `Insufficient statistical power: effective N ${stats.effectiveN.toFixed(1)} is below the declared minimum of ${declaration.minimumEffectiveN}. ` +
        `Raw N was ${stats.n}, discounted by an overlap block length of ${stats.blockLength}.`
    );
    return {
      grade: "F",
      reasons,
      recommendation:
        "Do not implement. This is an absence of evidence, not evidence of absence — the sample cannot resolve the question either way. Collect more independent observations before retesting.",
    };
  }

  if (stats.detectableEffect > declaration.detectableEffectTarget) {
    reasons.push(
      `Overlap invalidation: the smallest effect this sample could detect is ${(100 * stats.detectableEffect).toFixed(1)}pp, ` +
        `larger than the ${(100 * declaration.detectableEffectTarget).toFixed(1)}pp target declared before running. Any null result here is uninformative.`
    );
    return {
      grade: "F",
      reasons,
      recommendation:
        "Do not implement. The study was not capable of answering its own question at the resolution it declared. Widen the sample or raise the effect threshold, and be explicit about which.",
    };
  }

  // --- D: fails significance.
  if (stats.primaryPValue >= 0.05) {
    reasons.push(
      `Not statistically significant: overlap-corrected p = ${stats.primaryPValue.toFixed(4)} against a 0.05 threshold, ` +
        `on ${stats.independentN} independent observations.`
    );
    reasons.push(
      `The study WAS adequately powered (detectable ${(100 * stats.detectableEffect).toFixed(1)}pp vs observed ${(100 * stats.observedEffect).toFixed(1)}pp), so this is a genuine negative rather than an inconclusive one.`
    );
    return {
      grade: "D",
      reasons,
      recommendation: "Do not implement. The hypothesis was adequately tested and not supported.",
    };
  }

  reasons.push(`Statistically significant after overlap correction: p = ${stats.primaryPValue.toFixed(4)}.`);
  reasons.push(`Observed effect ${(100 * stats.observedEffect).toFixed(1)}pp against a detectable floor of ${(100 * stats.detectableEffect).toFixed(1)}pp.`);

  // --- C: significant but not reproducible across time.
  const wfProblem = stats.walkForward.length > 0 && !stats.walkForwardConsistent;
  const oosProblem = stats.outOfSampleConsistent === false;
  if (wfProblem || oosProblem) {
    if (wfProblem) {
      reasons.push(
        `Unstable walk-forward: fold success rates ${stats.walkForward.map((f) => (100 * f.successRate).toFixed(0) + "%").join(" / ")} do not agree in direction.`
      );
    }
    if (oosProblem) {
      reasons.push(
        `Inconsistent out-of-sample: in-sample ${(100 * (stats.inSample?.successRate ?? 0)).toFixed(1)}% versus out-of-sample ${(100 * (stats.outOfSample?.successRate ?? 0)).toFixed(1)}%, on opposite sides of the null.`
      );
    }
    return {
      grade: "C",
      reasons,
      recommendation:
        "Do not implement yet. The effect is real in aggregate but does not reproduce consistently across time, which is the property that distinguishes an edge from a period artefact.",
    };
  }

  if (stats.walkForward.length === 0) {
    reasons.push("Walk-forward not evaluated: too few independent observations to split into folds.");
  } else {
    reasons.push("Reproducible: walk-forward folds agree in direction.");
  }
  if (stats.outOfSampleConsistent === true) reasons.push("Out-of-sample agrees with in-sample in direction.");

  // --- B vs A: practical magnitude.
  if (stats.observedEffect < declaration.detectableEffectTarget) {
    reasons.push(
      `Effect is statistically real but below the declared practical threshold: ${(100 * stats.observedEffect).toFixed(1)}pp against a ${(100 * declaration.detectableEffectTarget).toFixed(1)}pp target.`
    );
    return {
      grade: "B",
      reasons,
      recommendation:
        "Implement only if the cost of doing so is near zero. The effect is credible but too small to justify added complexity on its own.",
    };
  }

  reasons.push("Practically meaningful: the observed effect exceeds the declared threshold for action.");
  return {
    grade: "A",
    reasons,
    recommendation: "Implement. The effect is significant after correction, reproducible across time, and large enough to matter.",
  };
}

// ── Ledger-wide multiple-testing correction ─────────────────────────────

export interface FamilyMember {
  studyId: string;
  pValue: number;
}

export interface FamilyCorrection {
  studyId: string;
  pValue: number;
  significantAfterFamilyCorrection: boolean;
  /** Position in the BH ranking, for auditability. */
  rank: number;
  familySize: number;
}

/**
 * Benjamini-Hochberg across EVERY study ever run, not merely within one.
 *
 * Correcting inside a single study does not address the problem correction
 * exists for. Twenty studies each corrected internally at q=0.05 still carry
 * roughly a 64% chance of at least one false positive across the programme,
 * and the three withdrawn results on this project were separate studies —
 * within-study correction would have caught none of them.
 *
 * The evidence ledger makes the honest version possible: the family is the
 * entire research history, and a new study is judged against every test that
 * preceded it. This is intentionally harsh, and it gets harsher as the
 * ledger grows, which is the correct incentive — it prices the cost of
 * having looked in many places.
 */
export function correctAcrossFamily(members: FamilyMember[], q = 0.05): FamilyCorrection[] {
  if (members.length === 0) return [];
  const fdr = benjaminiHochberg(members.map((m) => m.pValue), q);
  const ranked = [...members]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.pValue - b.m.pValue);
  const rankById = new Map<number, number>();
  ranked.forEach((entry, idx) => rankById.set(entry.i, idx + 1));

  return members.map((m, i) => ({
    studyId: m.studyId,
    pValue: m.pValue,
    significantAfterFamilyCorrection: fdr[i].significant,
    rank: rankById.get(i) ?? i + 1,
    familySize: members.length,
  }));
}
