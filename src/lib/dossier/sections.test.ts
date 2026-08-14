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
      "reasons",
      "invalidation",
      "analogs",
      "macro",
      // Deliberate addition, 2026-08-13: the provider-backed trio landed
      // (CBOE options, EDGAR + FINRA ownership, news + social attention).
      // Deliberate addition, 2026-08-13 (second wave): fundamentals and
      // analyst consensus landed.
      "business",
      "street",
      // Deliberate addition, 2026-08-14: options INTELLIGENCE (what the chain
      // prices) ahead of options FLOW (what it traded) — interpretation
      // before the activity that supports it.
      "optionsIntel",
      "options",
      "ownership",
      "attention",
      "levels",
      "evidence",
      "gaps",
    ]);
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
