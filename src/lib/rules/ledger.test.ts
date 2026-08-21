import { describe, expect, it } from "vitest";
import { Bar } from "@/lib/research/types";
import { RULE_REGISTER, measureFloorRule } from "./ledger";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** A calm series: every width survives, so every floor picks the narrowest. */
const calm = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    t: T0 + i * DAY,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1_000_000,
  }));

describe("measureFloorRule", () => {
  /*
   * THE COMMON CASE, AND THE ONE MOST EASILY MISREPORTED. When every candidate
   * floor selects the same stop, there is no difference to measure — the
   * setting is INERT, not "measured at zero difference". Reporting it as a
   * zero-difference finding would imply two different stops performed alike.
   */
  it("reports an inert floor rather than a zero-difference measurement", () => {
    const r = measureFloorRule("CALM", calm(200), 20, 70, [50, 60, 70, 80, 90]);
    expect(r.comparisons).toHaveLength(0);
    expect(r.action).toBe("untestable");
    expect(r.sentence).toContain("changes nothing here");
    expect(r.selectedWidthPct).not.toBeNull();
  });

  /*
   * REGRESSION. DEFAULT_HORIZONS is [1, 5, 10, 21] and does not contain 20.
   * narrowestViable filters cells by EXACT horizon, so a grid built at the
   * defaults returned null for a 20-session hold — which reads identically to
   * "no width survives", the opposite conclusion. /api/exit/design defaulted to
   * hold_sessions: 20 and refused every symbol on that artefact. The grid is
   * now built at the horizon asked for.
   */
  it("finds a viable stop at a hold the default grid never measures", () => {
    const r = measureFloorRule("CALM", calm(200), 20, 70, [70]);
    expect(r.selectedWidthPct).not.toBeNull();
    expect(r.sentence).not.toContain("No stop width survives");
  });

  /*
   * A floor no width can satisfy is a reason not to trade the name, and the
   * ledger must say that rather than reporting the rule as broken.
   */
  it("distinguishes an unsatisfiable floor from a failed rule", () => {
    // Every session drops 50% intraday, so the widest width on the grid is
    // taken out every time and no floor above zero can be satisfied.
    const violent = calm(200).map((b) => ({ ...b, low: 50 }));
    const r = measureFloorRule("WILD", violent, 20, 70, [50, 70]);
    expect(r.selectedWidthPct).toBeNull();
    expect(r.sentence).toContain("not a defect in the rule");
  });

  it("refuses a symbol with too little history instead of guessing", () => {
    const r = measureFloorRule("SHORT", calm(20), 20, 70, [50, 70]);
    expect(r.action).toBe("untestable");
    expect(r.comparisons).toHaveLength(0);
  });
});

describe("RULE_REGISTER", () => {
  /*
   * THE POINT OF THE REGISTER. Three of four rules cannot be tested today, and
   * each must name the missing input. A ledger listing only its measurable
   * rule would read as an audit of the plan while auditing a quarter of it.
   */
  it("lists unmeasurable rules and names what blocks each", () => {
    const blocked = RULE_REGISTER.filter((r) => !r.measurable);
    expect(blocked).toHaveLength(3);
    for (const r of blocked) {
      expect(r.blockedBy).toBeTruthy();
      expect(r.blockedBy!.length).toBeGreaterThan(80);
    }
  });

  it("keeps every rule's current value inside its own candidate set", () => {
    for (const r of RULE_REGISTER) {
      expect(r.candidates).toContain(r.current);
    }
  });
});
