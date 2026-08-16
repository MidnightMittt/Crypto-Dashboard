import { describe, expect, it } from "vitest";
import {
  MODULES,
  PHASE_ORDER,
  Phase,
  SECTIONS,
  SectionId,
  modulesOf,
  sectionsOf,
} from "./modules";

/**
 * The manifest is a contract, so it is pinned rather than trusted. These
 * tests are not about correctness of code — they are about a layout change
 * never happening by accident. Reordering is allowed; it just has to be
 * deliberate enough to update a test.
 */

describe("the fourteen sections", () => {
  it("is exactly the agreed list, in the agreed order", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      "tldr",
      "verdict",
      "plan",
      "riskFactors",
      "analogs",
      "validation",
      "moneyFlow",
      "options",
      "institutional",
      "news",
      "technical",
      "macro",
      "fullEvidence",
      "audit",
    ]);
  });

  /*
   * The page answers six questions IN ORDER, and "what could invalidate this"
   * is question three. Risk Factors therefore sits directly under the Trading
   * Plan rather than behind six evidence cards — the single deliberate
   * departure from the section list's original ordering.
   */
  it("puts Risk Factors immediately after the Trading Plan", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(ids.indexOf("riskFactors")).toBe(ids.indexOf("plan") + 1);
    expect(ids.indexOf("riskFactors")).toBeLessThan(ids.indexOf("analogs"));
  });

  it("never runs its phases backwards", () => {
    const rank = (p: Phase) => PHASE_ORDER.indexOf(p);
    const ranks = SECTIONS.map((s) => rank(s.phase));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("gives every section a reader-facing title", () => {
    for (const s of SECTIONS) expect(s.title.length).toBeGreaterThan(0);
  });

  /*
   * A section with no modules would render as an empty slot with a heading —
   * a promise the page cannot keep. Sections are added WITH their first
   * module, never before it.
   */
  it("has at least one module in every section", () => {
    for (const s of SECTIONS) {
      expect(modulesOf(s.id).length, `section ${s.id} is empty`).toBeGreaterThan(0);
    }
  });
});

describe("the module registry", () => {
  /*
   * THE FOUR-WAY GATE. If a module cannot name whether it improves decision
   * quality, confidence, risk management or execution, it does not belong on
   * the page. The type already forbids an empty tuple; this proves it at
   * runtime too, because a cast could get around the type and this cannot.
   */
  it("requires every module to declare what it improves", () => {
    for (const m of MODULES) {
      expect(m.serves.length, `module ${m.id} serves nothing`).toBeGreaterThan(0);
      for (const s of m.serves) {
        expect(["decision", "confidence", "risk", "execution"]).toContain(s);
      }
    }
  });

  it("assigns every module to a section that exists", () => {
    const ids = new Set<SectionId>(SECTIONS.map((s) => s.id));
    for (const m of MODULES) {
      expect(ids.has(m.section), `module ${m.id} -> unknown section ${m.section}`).toBe(true);
    }
  });

  it("registers each module exactly once", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /*
   * The orphans this architecture was built to prevent. Each of these was
   * built, tested and shipped, and reached nobody because there was no slot
   * for it. If one is ever dropped from the registry, that is the same defect
   * returning and it should fail here.
   */
  it("keeps the recovered orphans registered", () => {
    const ids = MODULES.map((m) => m.id);
    expect(ids).toContain("catalysts");
    expect(ids).toContain("liveness");
    expect(ids).toContain("moneyFlow");
  });

  it("groups modules under their phases without gaps", () => {
    const covered = PHASE_ORDER.flatMap((p) => sectionsOf(p).map((s) => s.id));
    expect(covered.sort()).toEqual(SECTIONS.map((s) => s.id).sort());
  });
});
