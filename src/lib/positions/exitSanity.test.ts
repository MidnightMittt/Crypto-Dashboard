import { describe, expect, it } from "vitest";
import { evaluateExitSanity } from "./exitSanity";

describe("evaluateExitSanity — the $72 feature", () => {
  /* The exact trade that cost the money, replayed as the fixture. */
  it("flags the SMR raise: 0.92 → 1.22 against a 0.95 lifetime high", () => {
    const v = evaluateExitSanity({
      contract: "SMR option",
      targetPrice: 1.22,
      lifetimeHigh: 0.95,
      highAsOf: "2026-10-02",
      priorTarget: 0.92,
    });
    expect(v.verdict).toBe("RAISE_UNREACHABLE");
    expect(v.isRaise).toBe(true);
    expect(v.targetVsHigh).toBeCloseTo(1.284, 3);
    expect(v.summary).toContain("raising a working exit is a new trade");
    expect(v.summary).toContain("lifetime high of 0.95");
  });

  it("the original 0.92 target was fine — below the high, reachable", () => {
    const v = evaluateExitSanity({
      contract: "SMR option",
      targetPrice: 0.92,
      lifetimeHigh: 0.95,
      highAsOf: "2026-10-02",
    });
    expect(v.verdict).toBe("REACHABLE");
    expect(v.isRaise).toBe(false);
  });

  it("flags a fresh order above all history even when it is not a raise", () => {
    const v = evaluateExitSanity({
      contract: "X 2026-12-18 10C",
      targetPrice: 2.0,
      lifetimeHigh: 1.5,
      highAsOf: "2026-10-02",
    });
    expect(v.verdict).toBe("UNREACHABLE");
    expect(v.isRaise).toBe(false);
  });

  it("a LOWER edit is not a raise and is judged only on reachability", () => {
    const v = evaluateExitSanity({
      contract: "X",
      targetPrice: 0.8,
      lifetimeHigh: 0.95,
      highAsOf: "2026-10-02",
      priorTarget: 0.92,
    });
    expect(v.verdict).toBe("REACHABLE");
    expect(v.isRaise).toBe(false);
  });

  it("reachable does not mean likely, and the wording says so", () => {
    const v = evaluateExitSanity({ contract: "X", targetPrice: 0.9, lifetimeHigh: 0.95, highAsOf: "t" });
    expect(v.summary).toContain("nothing about likelihood");
  });

  it("carries the posted stamp — the high is broker data, not chain data", () => {
    const v = evaluateExitSanity({ contract: "X", targetPrice: 1, lifetimeHigh: 0.95, highAsOf: "2026-10-02T14:00Z" });
    expect(v.stamps.lifetime_high.source).toBe("posted (broker historicals)");
    expect(v.stamps.lifetime_high.as_of).toBe("2026-10-02T14:00Z");
  });

  it("never says buy, sell or should", () => {
    const v = evaluateExitSanity({ contract: "X", targetPrice: 2, lifetimeHigh: 0.95, highAsOf: "t", priorTarget: 1 });
    expect(v.summary.toLowerCase()).not.toMatch(/\b(buy|sell|should)\b/);
  });
});
