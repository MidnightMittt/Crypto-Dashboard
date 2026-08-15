import { ModuleGrade } from "@/lib/research/edgeGate";

/**
 * HOW MUCH OF THIS VERDICT IS BACKED BY A VALIDATED SIGNAL?
 *
 * The composite already reports a score, an agreement level and a confidence
 * level. None of them answers the question a reader actually needs before
 * sizing a position: of the evidence that produced this call, how much has
 * ever been shown to predict anything?
 *
 * Measured 2026-08-15, the answer for crypto was 11% — one module of nine
 * earns its vote, and the two largest weights are a coin flip and a signal
 * that reads below its own null. For equities it is 0%: every equity module
 * is State, so the composite there describes conditions rather than
 * forecasting them. Both facts were true and invisible.
 *
 * ── What this is NOT ──────────────────────────────────────────────────
 *
 * Not a second score. It never moves a verdict, never re-ranks anything, and
 * is deliberately not blended into `confidence` — confidence measures INPUT
 * QUALITY (are the feeds fresh and complete), this measures WHETHER THE
 * SIGNAL WORKS. A stale reading from a validated module and a pristine
 * reading from a coin flip are different problems, and averaging them into
 * one number would hide both.
 *
 * ── Why weight rather than a count ────────────────────────────────────
 *
 * "1 of 9 modules" understates the problem when the failing eight carry 89%
 * of the weight, and would overstate it if they carried 5%. The composite is
 * a weighted sum, so the honest denominator is weight.
 */

export type EvidenceGradeLabel = "validated" | "mixed" | "unvalidated" | "descriptive";

export interface EvidenceGrade {
  label: EvidenceGradeLabel;
  /** Share of contributing weight from modules that earned their vote, 0-100. */
  validatedWeightPct: number;
  validatedCount: number;
  contributingCount: number;
  /** Named so a reader can go look at them, best-supported first. */
  validatedModules: string[];
  /** One sentence a reader can act on. Never a bare number. */
  sentence: string;
}

/**
 * Above this share of validated weight, the composite is mostly standing on
 * signals that have cleared the gate. Deliberately high: a verdict resting
 * half on coin flips is not "moderately reliable", it is a coin flip with
 * extra steps.
 */
const VALIDATED_FLOOR_PCT = 60;
/** Below this, the honest word is "unvalidated" rather than "mixed". */
const MIXED_FLOOR_PCT = 20;

export interface GradeInputs {
  /** Modules that actually contributed weight to this verdict. */
  contributing: Array<{ id: string; label: string; weight: number }>;
  /** Committed grades, keyed by metric id. Missing = never measured. */
  grades: Record<string, ModuleGrade>;
  /**
   * True when the composite is a State read (every equity today). A State
   * basis is not a failed forecast — it never claimed to be one — so it gets
   * its own label rather than scoring 0% against a bar it was not entered
   * for.
   */
  isStateBasis: boolean;
}

export function gradeEvidence(inputs: GradeInputs): EvidenceGrade {
  const { contributing, grades, isStateBasis } = inputs;

  const totalWeight = contributing.reduce((s, m) => s + Math.max(0, m.weight), 0);
  const validated = contributing.filter((m) => {
    const g = grades[m.id];
    return g !== undefined && g.verdict === "edge" && g.survivesFdr;
  });
  const validatedWeight = validated.reduce((s, m) => s + Math.max(0, m.weight), 0);
  const pct = totalWeight > 0 ? (validatedWeight / totalWeight) * 100 : 0;

  const validatedModules = validated
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((m) => m.label);

  if (isStateBasis) {
    return {
      label: "descriptive",
      validatedWeightPct: pct,
      validatedCount: validated.length,
      contributingCount: contributing.length,
      validatedModules,
      sentence:
        "This read describes current conditions rather than forecasting them. " +
        "No module contributing to it has a validated forward record, so treat " +
        "the direction as context for a decision you make on other grounds — " +
        "not as a prediction with a track record behind it.",
    };
  }

  if (contributing.length === 0 || totalWeight === 0) {
    return {
      label: "unvalidated",
      validatedWeightPct: 0,
      validatedCount: 0,
      contributingCount: 0,
      validatedModules: [],
      sentence: "No module contributed measurable weight to this read.",
    };
  }

  const rounded = Math.round(pct);
  const named =
    validatedModules.length === 0
      ? ""
      : ` The validated portion comes from ${listOf(validatedModules)}.`;

  if (pct >= VALIDATED_FLOOR_PCT) {
    return {
      label: "validated",
      validatedWeightPct: pct,
      validatedCount: validated.length,
      contributingCount: contributing.length,
      validatedModules,
      sentence:
        `${rounded}% of the evidence weight behind this call comes from signals that ` +
        `beat their own baseline out of sample and survived correction for multiple ` +
        `testing.${named}`,
    };
  }

  if (pct >= MIXED_FLOOR_PCT) {
    return {
      label: "mixed",
      validatedWeightPct: pct,
      validatedCount: validated.length,
      contributingCount: contributing.length,
      validatedModules,
      sentence:
        `Only ${rounded}% of the evidence weight behind this call comes from signals with ` +
        `a proven forward record; the rest are measured coin flips.${named} Size for a ` +
        `read that is mostly unproven.`,
    };
  }

  return {
    label: "unvalidated",
    validatedWeightPct: pct,
    validatedCount: validated.length,
    contributingCount: contributing.length,
    validatedModules,
    sentence:
      `${rounded}% of the evidence weight behind this call comes from a signal with a proven ` +
      `forward record. The rest have been measured and cannot be distinguished from chance, ` +
      `so the direction above is a hypothesis rather than an edge.${named}`,
  };
}

function listOf(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Grades a composite directly.
 *
 * ONE helper, so the dossier and the dashboard cannot drift into two answers
 * about the same composite. The weight function is the same one the score
 * itself used, so the denominator is literally the weight that produced the
 * number rather than a second opinion about what should have counted.
 *
 * Grades are passed IN rather than imported here on purpose: this module is
 * reachable from client components, and the committed artifact is ~39KB that
 * has no business in a browser bundle. Server callers supply it; anything
 * that cannot gets an honest "unmeasured" rather than a wrong number.
 */
export function gradeForComposite(
  bias: {
    basis: "edge" | "state";
    metrics: Array<{ id: string; label: string }>;
  },
  weightOf: (id: string) => number,
  grades: Record<string, ModuleGrade>
): EvidenceGrade {
  return gradeEvidence({
    contributing: bias.metrics
      .map((m) => ({ id: m.id, label: m.label, weight: weightOf(m.id) }))
      .filter((m) => m.weight > 0),
    grades,
    isStateBasis: bias.basis === "state",
  });
}
