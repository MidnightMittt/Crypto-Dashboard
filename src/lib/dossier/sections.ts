/**
 * THE SECTION MANIFEST — the page's shape, fixed in one place.
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
 * `phase` documents the reading order's intent: decide first, then
 * understand, then verify, then audit. A new section must say which question
 * it serves before it earns a slot.
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
  | "reasons"
  | "invalidation"
  | "analogs"
  | "macro"
  | "business"
  | "street"
  | "options"
  | "ownership"
  | "attention"
  | "levels"
  | "evidence"
  | "gaps";

export const DOSSIER_SECTIONS: readonly SectionDef[] = [
  { id: "verdict", phase: "decide" },
  { id: "tldr", phase: "decide" },
  { id: "plan", phase: "decide" },
  { id: "reasons", phase: "understand" },
  { id: "invalidation", phase: "understand" },
  { id: "analogs", phase: "verify" },
  { id: "macro", phase: "verify" },
  /*
   * The provider-backed trio, added when their data sources landed
   * (CBOE options, EDGAR Form 4 + FINRA short volume, Yahoo news +
   * StockTwits). Placed in the verify phase: they corroborate or contest a
   * decision already presented, they do not make it — none of them votes in
   * the score, and a page that led with options flow would be implying an
   * integration the engine has not measured.
   */
  /*
   * Added with the SEC-fundamentals and Nasdaq-consensus providers: what the
   * stock is a claim on, and what professional opinion says — both verify-
   * phase corroboration, neither votes.
   */
  { id: "business", phase: "verify" },
  { id: "street", phase: "verify" },
  { id: "options", phase: "verify" },
  { id: "ownership", phase: "verify" },
  { id: "attention", phase: "verify" },
  { id: "levels", phase: "verify" },
  { id: "evidence", phase: "verify" },
  { id: "gaps", phase: "audit" },
] as const;
