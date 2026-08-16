import { EvidenceGradeLabel } from "./evidenceGrade";
import { AgreementLevel, EvidenceLevel, agreementLevel, evidenceLevel } from "./plainLanguage";

/**
 * HOW MUCH CONVICTION SHOULD I HAVE? — capped by the weakest link.
 *
 * This exists instead of a "Trade Quality 9.2 / 10". The question behind that
 * request is real and is one this platform must answer, but a decimal on a
 * ten-point scale claims resolution of plus or minus a tenth, and the
 * measurements do not support a tenth of anything:
 *
 *   - No module contributing to an equity verdict has a validated forward
 *     record. One of nine Edge voters clears its own gate.
 *   - Regressed on overnight SPY, 0 of 76 alphas across the scanned cohort
 *     clear FDR — the premium that looked cohort-specific is beta 3.98.
 *   - The 250-session basket needed 51.5bp to reach t=3 and measured 32.2bp,
 *     so it could not have detected the effect it found.
 *
 * A number implying tenth-of-a-point precision on top of that would convert
 * the one thing that distinguishes this platform — refusing to fake
 * precision — into the thing every other dashboard already does.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 *
 * Conviction is computed from what varies per ticker (input quality and
 * whether the signals agree), then CAPPED by what is true of the engine as a
 * whole, and the cap is always stated. A ceiling that binds is not a footnote
 * — it is the most important thing on the line, because it says the number
 * above cannot be earned by this ticker looking better.
 *
 * The cap lifts by itself as signals earn forward records. That is the point:
 * the number rises when the evidence does, and never before.
 */

export type ConvictionLevel = "high" | "moderate" | "low";

const ORDER: Record<ConvictionLevel, number> = { low: 0, moderate: 1, high: 2 };
const BY_RANK: ConvictionLevel[] = ["low", "moderate", "high"];

/** A constraint that limits conviction, and what would release it. */
export interface Ceiling {
  level: ConvictionLevel;
  /** Why it binds, in the reader's words. */
  because: string;
  /** What would lift it. Always something observable, never "more data". */
  liftedWhen: string;
}

export interface Conviction {
  level: ConvictionLevel;
  /** What the level rests on, before any cap. */
  because: string;
  /**
   * The validation ceiling, when it binds. When present this is the headline:
   * the ticker cannot earn a higher number by looking better.
   */
  cappedBy: Ceiling | null;
}

export interface ConvictionInputs {
  /** 0-100 evidence quality of the composite — are the feeds fresh and complete. */
  confidencePct: number;
  /** 0-100 how much the separate signals concur with each other. */
  agreementPct: number;
  /** Whether the contributing modules have forward records. */
  grade: EvidenceGradeLabel;
  /** Share of contributing weight from modules that earned their vote. */
  validatedWeightPct: number;
}

/**
 * The read before any cap: input quality crossed with agreement.
 *
 * Both must be good for high. Strong evidence that disagrees with itself is a
 * compromise between opposing signals rather than a consensus, and a
 * unanimous read on thin data looks like certainty and is not — the two
 * failure modes `describeConviction` already names.
 */
function rawLevel(evidence: EvidenceLevel, agree: AgreementLevel): {
  level: ConvictionLevel;
  because: string;
} {
  const agrees = agree === "unanimous" || agree === "mostly-agree";
  if (evidence === "strong" && agree === "unanimous") {
    return { level: "high", because: "Strong evidence and every signal agrees." };
  }
  if (evidence === "strong" && agrees) {
    return { level: "high", because: "Strong evidence and most signals agree." };
  }
  if (evidence === "thin") {
    return { level: "low", because: "The evidence behind this is thin." };
  }
  if (!agrees) {
    /*
     * Split and conflicting are different states and the words must not be
     * swapped. Caught by reading live output: APLD's line said "the signals
     * contradict each other" one clause before the agreement stat said "the
     * signals are split", which is the page arguing with itself in the space
     * of a sentence.
     */
    return {
      level: "low",
      because:
        agree === "conflicting"
          ? "The signals contradict each other."
          : "The signals are split, so any single read is a compromise.",
    };
  }
  /*
   * Named off the ACTUAL agreement level rather than a single fallback
   * phrase: saying "mostly agree" when every signal points the same way is a
   * small lie, and small lies about the evidence are the ones that erode
   * trust in the numbers beside them.
   */
  return {
    level: "moderate",
    because:
      agree === "unanimous"
        ? "Every signal agrees, but on evidence that is only partial."
        : "Reasonable evidence, and most signals agree.",
  };
}

/**
 * THE VALIDATION CEILING — the only constraint that is not already priced in.
 *
 * The first version of this module also carried ceilings for thin evidence
 * and for contradicting signals. Both were dead logic, and the tests found
 * it: those same two conditions already drive `rawLevel` to low, so their
 * ceilings could never bind on anything. Listing them would have told a
 * reader three constraints were active when only one can ever fire.
 *
 * What makes validation different is that it is invisible to the raw read.
 * A ticker can have pristine feeds and unanimous agreement and still be
 * resting entirely on modules that have never predicted anything — the raw
 * read says "high" and is wrong in a way no per-ticker measurement can see.
 * That is the gap this ceiling exists to close.
 *
 * Returns null when the weight behind the read is validated, meaning nothing
 * caps it.
 */
export function validationCeiling(input: ConvictionInputs): Ceiling | null {
  /*
   * Only "validated" — a clear majority of contributing weight having cleared
   * its own gate — leaves conviction uncapped. The other three grades differ
   * in wording, not in ceiling: 0% validated and 15% validated are both
   * "mostly unproven", and letting 15% buy a higher ceiling than 0% would
   * claim a precision the grade boundaries do not carry.
   */
  if (input.grade === "validated") return null;
  return {
    level: "moderate",
    because:
      input.grade === "descriptive"
        ? "No signal behind this read has a forward record yet."
        : `Only ${Math.round(input.validatedWeightPct)}% of the weight here has a forward record.`,
    liftedWhen:
      "validated modules carry most of the weight behind this read rather than a minority of it",
  };
}

export function assessConviction(input: ConvictionInputs): Conviction {
  const raw = rawLevel(evidenceLevel(input.confidencePct), agreementLevel(input.agreementPct));
  const ceiling = validationCeiling(input);

  /*
   * A ceiling only counts as a cap when it actually LOWERS something. A read
   * that was already low on its own merits had nothing taken from it, and
   * reporting a cap there would overstate what the constraint did.
   */
  const capped = ceiling !== null && ORDER[ceiling.level] < ORDER[raw.level];
  return {
    level: capped ? ceiling.level : raw.level,
    because: raw.because,
    cappedBy: capped ? ceiling : null,
  };
}

/**
 * One line for the card. The cap leads when it binds, because "Moderate"
 * alone invites the reader to assume the ticker simply looked average — when
 * the truth is that no ticker can currently read higher.
 */
export function describeConvictionLevel(c: Conviction): string {
  const word = c.level.charAt(0).toUpperCase() + c.level.slice(1);
  if (!c.cappedBy) return `${word}. ${c.because}`;
  return `${word}, capped. ${c.cappedBy.because} Lifts when ${c.cappedBy.liftedWhen}.`;
}

/** Exposed for the tests and for anything that needs the ordering. */
export const CONVICTION_ORDER = BY_RANK;
