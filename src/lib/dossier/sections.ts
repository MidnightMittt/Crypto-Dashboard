/**
 * THE SECTION MANIFEST — the page's shape and its hierarchy, in one place.
 *
 * The research page must stay stable while the intelligence behind it grows:
 * a user who learns where the plan lives should find it there next month,
 * after three new data sources have shipped. That only holds if the layout
 * is owned by a manifest rather than emerging from whatever data happened to
 * be available — the coupling this file exists to prevent.
 *
 * ── The contract ──────────────────────────────────────────────────────
 *
 *  - The page renders EXACTLY this list, in this order. It never branches
 *    on availability; each section's component renders its own unavailable,
 *    basic, advanced and institutional states internally.
 *  - Adding intelligence to a section changes that section's DEPTH, never
 *    the page. Adding a genuinely new section means adding one entry here —
 *    a deliberate, reviewed layout change rather than a side effect.
 *  - The order is pinned by a test. Reordering is allowed; it just cannot
 *    happen by accident.
 *
 * `phase` says which question a section serves: decide first, then
 * understand, then verify, then audit. A new section must answer that before
 * it earns a slot.
 *
 * ── Phase is load-bearing ─────────────────────────────────────────────
 *
 * It used to be documentation. The page rendered every section as an
 * identical card in one flat loop, which is precisely why a page with
 * sixteen well-built sections had no hierarchy: when everything looks
 * equally important, nothing is. Phase now drives VISUAL WEIGHT as well as
 * order — the page reads `decide` loudest and folds `audit` away by default
 * (see PHASE_PRESENTATION in the page).
 *
 * The consequence for anyone adding a section: choosing its phase is
 * choosing how loud it is. That is the intended coupling. A section that
 * cannot justify `decide` does not get the first screen, and the manifest is
 * where that argument has to be won.
 */

export type SectionPhase = "decide" | "understand" | "verify" | "audit";

export interface SectionDef {
  id: SectionId;
  phase: SectionPhase;
}

export type SectionId =
  | "verdict"
  | "tldr"
  | "plan"
  | "nextEntry"
  | "reasons"
  | "invalidation"
  | "analogs"
  | "macro"
  | "business"
  | "street"
  | "options"
  | "optionsIntel"
  | "ownership"
  | "attention"
  | "levels"
  | "evidence"
  | "gaps";

export const DOSSIER_SECTIONS: readonly SectionDef[] = [
  { id: "verdict", phase: "decide" },
  { id: "tldr", phase: "decide" },
  { id: "plan", phase: "decide" },
  /*
   * Deliberately in the DECIDE phase, immediately after the plan. Since the
   * EV gate landed, most days have no trade — and on those days this is the
   * decision: the level to wait for. Filing it under "understand" would bury
   * the only actionable content on a page that just said no.
   */
  { id: "nextEntry", phase: "decide" },
  { id: "reasons", phase: "understand" },
  { id: "invalidation", phase: "understand" },

  /*
   * VERIFY holds only the two sections that CONTEST the decision with
   * independent evidence: what happened in similar environments, and what
   * the options market is pricing against the plan's own target. Both can
   * change what a reader does, which is what earns them a visible slot.
   */
  { id: "analogs", phase: "verify" },
  { id: "optionsIntel", phase: "verify" },

  /*
   * ── AUDIT: the workings ────────────────────────────────────────────
   *
   * Everything below is corroboration and provenance — none of it votes in
   * the score, and none of it changes the decision on its own. It was
   * previously rendered at the same weight as the trade plan, which is what
   * made the page feel like a data dump rather than an answer.
   *
   * Folded, NOT removed: the fold is server-rendered `<details>`, so every
   * word stays in the document and find-in-page still reaches it. A reader
   * who wants thirty minutes of SEC filings, analyst targets, insider
   * activity and per-metric confidence intervals loses nothing; a reader who
   * wants the trade is no longer made to scroll past it.
   */
  { id: "macro", phase: "audit" },
  { id: "business", phase: "audit" },
  { id: "street", phase: "audit" },
  { id: "options", phase: "audit" },
  { id: "ownership", phase: "audit" },
  { id: "attention", phase: "audit" },
  { id: "levels", phase: "audit" },
  { id: "evidence", phase: "audit" },
  { id: "gaps", phase: "audit" },
] as const;
