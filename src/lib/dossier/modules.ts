/**
 * THE MODULE REGISTRY — what the dossier contains, and where each thing lands.
 *
 * Two levels, and the split is the whole architecture (see
 * docs/DOSSIER_ARCHITECTURE.md).
 *
 *   SECTION  one of the fourteen named slots below. The public contract.
 *            Changes roughly never — a trader who learns where the plan lives
 *            finds it there next year.
 *
 *   MODULE   an independent unit of intelligence, assigned to exactly one
 *            section. This is where the platform grows.
 *
 * A capability is added by registering a module. It CANNOT create a page,
 * because no mechanism exists for it to. That is the property this file
 * exists to enforce, and it was written after measuring the alternative: the
 * EDGAR catalyst feed shipped into /api/pretrade and rendered on zero pages,
 * `moneyFlow` sat on the dossier read only by the gaps report, and crypto
 * intelligence was reachable only from /crypto. None of those modules was
 * weak. They had nowhere to land.
 *
 * ── Phase decides prominence, and the argument is won here ────────────
 *
 * The page reads `decide` loudest and folds `audit` away. A section that
 * cannot justify `decide` does not get the first screen. Choosing a phase is
 * choosing how loud something is, and this file is where that is argued.
 */

/**
 * The five phases, in render order, answering the six questions the page
 * exists to answer:
 *
 *   decide    1. What should I do?   2. Why?
 *   risk      3. What could invalidate this?
 *   verify    4. How has this type of setup performed historically?
 *   evidence  5. What evidence supports it?
 *   audit     6. How deep do I want to go?
 *
 * Q2 does not get its own phase. Every module carries `reasoning` in its
 * evidence, so the why belongs inside the Verdict rather than in six cards
 * between the plan and the risks — which is exactly what lets Risk Factors
 * sit directly under the Trading Plan, where a trader needs it.
 *
 * Q6 is not a phase either. It is the `depth` ladder, which already exists.
 */
export type Phase = "decide" | "risk" | "verify" | "evidence" | "audit";

export const PHASE_ORDER: readonly Phase[] = ["decide", "risk", "verify", "evidence", "audit"];

export type SectionId =
  | "tldr"
  | "verdict"
  | "plan"
  | "riskFactors"
  | "analogs"
  | "validation"
  | "moneyFlow"
  | "options"
  | "institutional"
  | "news"
  | "technical"
  | "macro"
  | "fullEvidence"
  | "audit";

export interface SectionDef {
  id: SectionId;
  phase: Phase;
  /** The reader's name for it. Rendered as the heading outside `decide`. */
  title: string;
}

/**
 * THE FOURTEEN. Order is the reading order, pinned by test.
 *
 * Risk Factors sits at #4 rather than late in the list because the page
 * answers the six questions IN ORDER, and "what could invalidate this" is
 * question three. A trader learns what kills the idea before learning how the
 * setup has performed historically.
 */
export const SECTIONS: readonly SectionDef[] = [
  { id: "tldr", phase: "decide", title: "TL;DR" },
  { id: "verdict", phase: "decide", title: "Verdict" },
  { id: "plan", phase: "decide", title: "Trading Plan" },
  { id: "riskFactors", phase: "risk", title: "Risk Factors" },
  { id: "analogs", phase: "verify", title: "Historical Analogs" },
  { id: "validation", phase: "verify", title: "Validation Record" },
  { id: "moneyFlow", phase: "evidence", title: "Money Flow" },
  { id: "options", phase: "evidence", title: "Options Intelligence" },
  { id: "institutional", phase: "evidence", title: "Institutional Activity" },
  { id: "news", phase: "evidence", title: "News & Catalysts" },
  { id: "technical", phase: "evidence", title: "Technical Structure" },
  { id: "macro", phase: "evidence", title: "Macro & Industry" },
  { id: "fullEvidence", phase: "audit", title: "Full Evidence" },
  { id: "audit", phase: "audit", title: "Audit" },
] as const;

/**
 * WHAT A MODULE IMPROVES. Non-empty by construction — see ModuleDef.
 *
 * The product rule this encodes: if a module does not materially improve
 * decision quality, confidence, risk management or execution, it does not get
 * built. Making it a type rather than a paragraph in a doc means a module
 * that cannot name its contribution DOES NOT COMPILE. "Interesting" is not a
 * reason, and a statistic with no consequence for what a trader does next
 * belongs in docs/, not in a section.
 */
export type Serves = "decision" | "confidence" | "risk" | "execution";

export type ModuleId =
  | "tldr"
  | "verdict"
  | "reasons"
  | "engineBars"
  | "plan"
  | "nextEntry"
  | "checklist"
  | "invalidation"
  | "stopGrid"
  | "passRules"
  | "analogs"
  | "validatedSignal"
  | "moneyFlow"
  | "optionsIntel"
  | "optionsFlow"
  | "ownership"
  | "news"
  | "catalysts"
  | "levels"
  | "macro"
  | "business"
  | "street"
  | "fullEvidence"
  | "gaps"
  | "liveness";

export interface ModuleDef {
  id: ModuleId;
  section: SectionId;
  /**
   * Non-empty by construction. A module that cannot name what it improves is
   * a type error, not a code-review conversation.
   */
  serves: readonly [Serves, ...Serves[]];
}

export const MODULES: readonly ModuleDef[] = [
  // ── DECIDE ──────────────────────────────────────────────────────────
  { id: "tldr", section: "tldr", serves: ["decision"] },
  { id: "verdict", section: "verdict", serves: ["decision", "confidence"] },
  /*
   * The two cases and the category rollups live INSIDE the verdict rather
   * than as peer cards. They are the answer to "why", and under this
   * architecture every module carries reasoning — so the why belongs with the
   * claim it explains, not in its own tier of the page.
   */
  { id: "reasons", section: "verdict", serves: ["decision", "confidence"] },
  { id: "engineBars", section: "verdict", serves: ["confidence"] },
  { id: "plan", section: "plan", serves: ["decision", "execution", "risk"] },
  /*
   * Since the EV gate landed most days have no trade, and on those days THIS
   * is the decision: the level to wait for. It stays in `decide` so the only
   * actionable content on a page that just said no is not buried.
   */
  { id: "nextEntry", section: "plan", serves: ["decision", "execution"] },
  { id: "checklist", section: "plan", serves: ["decision", "confidence"] },

  // ── RISK ────────────────────────────────────────────────────────────
  { id: "invalidation", section: "riskFactors", serves: ["risk", "execution"] },
  /*
   * How much room the stop needs, measured rather than chosen. Sits beside
   * invalidation because they answer adjacent questions: invalidation is WHERE
   * the thesis breaks, this is whether a stop there survives ordinary noise.
   */
  { id: "stopGrid", section: "riskFactors", serves: ["risk", "execution"] },
  /* Reasons to stand aside, as distinct from reasons to exit. */
  { id: "passRules", section: "riskFactors", serves: ["risk", "decision"] },

  // ── VERIFY ──────────────────────────────────────────────────────────
  { id: "analogs", section: "analogs", serves: ["confidence", "decision"] },
  { id: "validatedSignal", section: "validation", serves: ["decision", "confidence"] },

  // ── EVIDENCE ────────────────────────────────────────────────────────
  { id: "moneyFlow", section: "moneyFlow", serves: ["decision", "confidence"] },
  { id: "optionsIntel", section: "options", serves: ["decision", "risk"] },
  { id: "optionsFlow", section: "options", serves: ["confidence"] },
  { id: "ownership", section: "institutional", serves: ["decision", "confidence"] },
  { id: "news", section: "news", serves: ["risk", "decision"] },
  /*
   * A filing accepted after the close is precisely the event an overnight
   * position cannot react to — the stop is a statement about continuous tape
   * and the tape is closed. It serves risk first.
   */
  { id: "catalysts", section: "news", serves: ["risk", "decision"] },
  { id: "levels", section: "technical", serves: ["execution", "risk"] },
  { id: "macro", section: "macro", serves: ["risk", "confidence"] },

  // ── AUDIT ───────────────────────────────────────────────────────────
  { id: "fullEvidence", section: "fullEvidence", serves: ["confidence"] },
  /*
   * Fundamentals and the analyst view sit under Full Evidence rather than in
   * the evidence tier: neither changes a multi-day swing decision on its own.
   * Solvency is a real overnight risk, which is what earns `business` a slot
   * at all.
   */
  { id: "business", section: "fullEvidence", serves: ["risk", "confidence"] },
  /*
   * THE WEAKEST JUSTIFICATION ON THIS BOARD, and it is recorded as such. A
   * consensus price target is reported opinion, not a measurement, and it has
   * no forward record here. It survives on the argument that knowing the
   * street sits far above spot is context a reader would otherwise seek
   * elsewhere. It is the standing deletion candidate under the four-way test.
   */
  { id: "street", section: "fullEvidence", serves: ["confidence"] },
  { id: "gaps", section: "audit", serves: ["confidence"] },
  /*
   * Whether the pipeline behind every number above actually ran. A terminal
   * that looks live when it is not discredits everything else on it, so this
   * serves confidence in the most literal sense available.
   */
  { id: "liveness", section: "audit", serves: ["confidence"] },
] as const;

/** Modules belonging to a section, in registry order. */
export function modulesOf(section: SectionId): readonly ModuleDef[] {
  return MODULES.filter((m) => m.section === section);
}

/** Sections belonging to a phase, in manifest order. */
export function sectionsOf(phase: Phase): readonly SectionDef[] {
  return SECTIONS.filter((s) => s.phase === phase);
}
