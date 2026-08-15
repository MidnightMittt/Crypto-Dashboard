import { describe, expect, it } from "vitest";
import { DOSSIER_SECTIONS } from "./sections";

describe("the section manifest", () => {
  it("pins the reading order — reordering must be a deliberate edit to this test", () => {
    /*
     * This is the layout-stability guarantee in executable form. If a data
     * source landing ever reorders the page, this fails, and the fix is a
     * conscious decision rather than an accident.
     */
    expect(DOSSIER_SECTIONS.map((s) => s.id)).toEqual([
      "verdict",
      "tldr",
      "plan",
      // Deliberate addition, 2026-08-14: the forward-looking conditional
      // entries, placed with the decision rather than the explanation.
      "nextEntry",
      // Deliberate addition, 2026-08-14: the setup checklist closes DECIDE.
      "checklist",
      // Deliberate addition, 2026-08-15: the cross-sectional momentum read —
      // the first equity signal with a validated forward record. Opens
      // UNDERSTAND rather than joining DECIDE; see the manifest for why.
      "validatedSignal",
      "reasons",
      // Deliberate addition, 2026-08-14: the category bars.
      "engineBars",
      "invalidation",
      // Reasons to stand aside, after reasons to exit.
      "passRules",
      // Deliberate change, 2026-08-14: VERIFY was ten sections and is now
      // two. Only analogs and options intelligence contest the decision with
      // independent evidence; the rest corroborate it and moved to AUDIT,
      // where they fold. See the manifest for the argument.
      "analogs",
      "optionsIntel",
      "macro",
      "business",
      "street",
      "options",
      "ownership",
      "attention",
      "levels",
      "evidence",
      "gaps",
    ]);
  });

  /*
   * HIERARCHY IS A PROPERTY OF THE MANIFEST, and the page renders it. A
   * change that quietly moved most sections back into the visible phases
   * would restore the flat wall of equal-weight cards this structure exists
   * to prevent — so the shape is pinned, not just the order.
   */
  it("keeps the deciding phases small enough to actually be a hierarchy", () => {
    const count = (phase: string) => DOSSIER_SECTIONS.filter((s) => s.phase === phase).length;
    expect(count("decide")).toBeLessThanOrEqual(5);
    expect(count("understand")).toBeLessThanOrEqual(5);
    expect(count("verify")).toBeLessThanOrEqual(4);
    // The workings are the bulk, and they fold.
    expect(count("audit")).toBeGreaterThan(count("decide"));
  });

  it("keeps ids unique", () => {
    const ids = DOSSIER_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads in decide -> understand -> verify -> audit order, never backwards", () => {
    const rank = { decide: 0, understand: 1, verify: 2, audit: 3 };
    const phases = DOSSIER_SECTIONS.map((s) => rank[s.phase]);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i], `${DOSSIER_SECTIONS[i].id} is out of phase order`).toBeGreaterThanOrEqual(phases[i - 1]);
    }
  });
});
