import { StudyResult, StudyDeclaration, correctAcrossFamily, FamilyCorrection, EvidenceGrade } from "./study";

/**
 * THE EVIDENCE LEDGER — permanent, append-only record of every study.
 *
 * Two jobs, and the second is the one that makes it load-bearing rather
 * than administrative.
 *
 * 1. Institutional memory. A future study can ask what has already been
 *    tested instead of rediscovering it. Three phases of this project each
 *    hit the same sample-size wall independently; a ledger would have shown
 *    the second and third that the first had already found it.
 *
 * 2. The multiple-testing family. Correcting within a study does not
 *    address what correction is for. Twenty internally-corrected studies
 *    still carry ~64% probability of a false positive somewhere, and the
 *    three withdrawn results here were separate studies. The ledger defines
 *    the true family: every test ever run. A new study is corrected against
 *    the whole history, and the bar rises as the history grows — which is
 *    the correct price for having looked in many places.
 *
 * Append-only by contract. Entries are never edited or deleted, because a
 * ledger that can be revised after seeing results is not evidence, it is
 * decoration. Superseding a conclusion means appending a new entry that
 * references the old one.
 */

/** Everything needed to re-run a study and get byte-identical output. */
export interface ReproducibilityStamp {
  seed: number;
  /** Git commit of the code that produced the result. */
  codeVersion: string;
  datasetVersion: string;
  /** Version of each feature used, so a later feature change cannot silently invalidate an old conclusion. */
  featureVersions: Record<string, string>;
  /** Version of each capability provider used. */
  capabilityVersions: Record<string, string>;
  /** Every parameter the study was run with, serialised. */
  parameters: Record<string, string | number | boolean>;
}

export interface LedgerEntry {
  studyId: string;
  recordedAtISO: string;
  hypothesis: string;
  nullHypothesis: string;
  assetUniverse: string[];
  timeframe: string;
  n: number;
  effectiveN: number;
  independentN: number;
  blockLength: number;
  primaryPValue: number;
  /** Null until the family correction runs; populated by `withFamilyCorrection`. */
  familyCorrectedSignificant: boolean | null;
  familySize: number | null;
  confidenceInterval: { lower: number; upper: number } | null;
  observedEffect: number;
  detectableEffect: number;
  walkForwardConsistent: boolean;
  outOfSampleConsistent: boolean | null;
  grade: EvidenceGrade;
  reasons: string[];
  recommendation: string;
  /** Set by a human afterwards. The one mutable field, and it records action taken rather than evidence. */
  implementationStatus: "not-implemented" | "implemented" | "superseded";
  /** When this entry supersedes an earlier conclusion, the id it replaces. */
  supersedes: string | null;
  reproducibility: ReproducibilityStamp;
}

export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}

export const EMPTY_LEDGER: Ledger = { version: 1, entries: [] };

/**
 * Converts a completed study into a ledger entry.
 *
 * `recordedAtISO` is supplied rather than read from the clock so a test can
 * pin it; `executeStudy` deliberately leaves its own timestamp fixed for the
 * same reason. Wall-clock time inside a result would break the guarantee
 * that identical inputs produce identical outputs.
 */
export function toLedgerEntry(
  result: StudyResult,
  meta: {
    assetUniverse: string[];
    timeframe: string;
    recordedAtISO: string;
    reproducibility: ReproducibilityStamp;
    supersedes?: string | null;
  }
): LedgerEntry {
  const groupNames = Object.keys(result.statistics.groups).sort();
  const ci =
    result.statistics.difference !== null
      ? { lower: result.statistics.difference.lower, upper: result.statistics.difference.upper }
      : groupNames.length === 1
        ? {
            lower: result.statistics.groups[groupNames[0]].lower,
            upper: result.statistics.groups[groupNames[0]].upper,
          }
        : null;

  return {
    studyId: result.declaration.id,
    recordedAtISO: meta.recordedAtISO,
    hypothesis: result.declaration.hypothesis,
    nullHypothesis: result.declaration.nullHypothesis,
    assetUniverse: meta.assetUniverse,
    timeframe: meta.timeframe,
    n: result.statistics.n,
    effectiveN: result.statistics.effectiveN,
    independentN: result.statistics.independentN,
    blockLength: result.statistics.blockLength,
    primaryPValue: result.statistics.primaryPValue,
    familyCorrectedSignificant: null,
    familySize: null,
    confidenceInterval: ci,
    observedEffect: result.statistics.observedEffect,
    detectableEffect: result.statistics.detectableEffect,
    walkForwardConsistent: result.statistics.walkForwardConsistent,
    outOfSampleConsistent: result.statistics.outOfSampleConsistent,
    grade: result.verdict.grade,
    reasons: result.verdict.reasons,
    recommendation: result.verdict.recommendation,
    implementationStatus: "not-implemented",
    supersedes: meta.supersedes ?? null,
    reproducibility: meta.reproducibility,
  };
}

/** Appends an entry. Rejects a duplicate id rather than overwriting — an append-only log that silently overwrites is neither. */
export function append(ledger: Ledger, entry: LedgerEntry): Ledger {
  if (ledger.entries.some((e) => e.studyId === entry.studyId)) {
    throw new Error(
      `[ledger] studyId "${entry.studyId}" already recorded. The ledger is append-only; to revise a conclusion, append a new entry with a distinct id and set \`supersedes\`.`
    );
  }
  return { ...ledger, entries: [...ledger.entries, entry] };
}

/**
 * Recomputes family-wide correction across the whole ledger and returns a
 * new ledger with every entry's family verdict refreshed.
 *
 * Deliberately recomputed over ALL entries each time rather than assigned
 * once at insertion: adding a study changes the family, and therefore
 * changes whether earlier studies still clear the bar. A conclusion that
 * only held when it was the only test on the books should stop holding, and
 * this is what makes that visible instead of leaving stale verdicts behind.
 */
export function withFamilyCorrection(ledger: Ledger, q = 0.05): Ledger {
  const superseded = new Set(ledger.entries.map((e) => e.supersedes).filter((x): x is string => x !== null));
  // A superseded entry is history, not a live claim, and including it would
  // inflate the family with tests that no longer assert anything.
  const live = ledger.entries.filter((e) => !superseded.has(e.studyId));
  const corrections = correctAcrossFamily(
    live.map((e) => ({ studyId: e.studyId, pValue: e.primaryPValue })),
    q
  );
  const byId = new Map<string, FamilyCorrection>(corrections.map((c) => [c.studyId, c]));

  return {
    ...ledger,
    entries: ledger.entries.map((e) => {
      const c = byId.get(e.studyId);
      return c
        ? { ...e, familyCorrectedSignificant: c.significantAfterFamilyCorrection, familySize: c.familySize }
        : { ...e, familyCorrectedSignificant: null, familySize: null };
    }),
  };
}

/** Prior work on the same question, so a new study can cite rather than repeat. Matched on declared hypothesis text, deliberately crude — a fuzzy matcher that missed a prior result would be worse than one an author has to read. */
export function findRelated(ledger: Ledger, declaration: StudyDeclaration): LedgerEntry[] {
  const terms = declaration.hypothesis
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 4);
  return ledger.entries.filter((e) => {
    const text = `${e.hypothesis} ${e.nullHypothesis}`.toLowerCase();
    return terms.filter((t) => text.includes(t)).length >= Math.max(2, Math.floor(terms.length * 0.3));
  });
}

/** Counts by grade, for the programme-level view. */
export function summarize(ledger: Ledger): Record<EvidenceGrade | "total", number> {
  const out: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, total: ledger.entries.length };
  for (const e of ledger.entries) out[e.grade] = (out[e.grade] ?? 0) + 1;
  return out as Record<EvidenceGrade | "total", number>;
}
