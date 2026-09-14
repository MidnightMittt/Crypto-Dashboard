import { describe, expect, it } from "vitest";
import deskTriggersJson from "../../data/deskTriggers.json";
import { DeclaredTrigger, evaluateTrigger } from "./triggers";

const NOW = Date.parse("2026-09-14T12:00:00Z");

function trigger(overrides: Partial<DeclaredTrigger> = {}): DeclaredTrigger {
  return {
    id: "t",
    subject: "TEST",
    kind: "price_floor",
    level: 10,
    unit: "USD",
    declared_by: "test",
    declared_on: "2026-09-14",
    on_breach: "test",
    source_required: "a test source.",
    ...overrides,
  };
}

describe("evaluateTrigger — the sign always points at danger", () => {
  it("a floor is breached from above: price under the level goes negative", () => {
    const above = evaluateTrigger(trigger(), { value: 11, source: "s", observed_at: "2026-09-14T11:59:00Z" }, NOW);
    const below = evaluateTrigger(trigger(), { value: 9, source: "s", observed_at: "2026-09-14T11:59:00Z" }, NOW);
    expect(above.distance_pct).toBe(10);
    expect(above.breached).toBe(false);
    expect(below.distance_pct).toBe(-10);
    expect(below.breached).toBe(true);
  });

  it("a review level flips the orientation: price above it is the crossing", () => {
    const t = trigger({ kind: "price_review" });
    const below = evaluateTrigger(t, { value: 9, source: "s", observed_at: "2026-09-14T11:59:00Z" }, NOW);
    const above = evaluateTrigger(t, { value: 11, source: "s", observed_at: "2026-09-14T11:59:00Z" }, NOW);
    // Below the review level: not yet interesting, positive distance.
    expect(below.distance_pct).toBe(10);
    expect(below.breached).toBe(false);
    // Above it: the alert side, negative by the one-column convention.
    expect(above.distance_pct).toBe(-10);
    expect(above.breached).toBe(true);
  });

  it("a rate falsifier breaches downward, like a floor", () => {
    const t = trigger({ kind: "rate_falsifier", level: 0.25 });
    const under = evaluateTrigger(t, { value: 0.2, source: "s", observed_at: "2026-09-14T11:00:00Z" }, NOW);
    expect(under.breached).toBe(true);
  });

  it("carries the reading's age in seconds, never a bare value", () => {
    const r = evaluateTrigger(trigger(), { value: 11, source: "chain", observed_at: "2026-09-14T11:00:00Z" }, NOW);
    expect(r.reading!.age_seconds).toBe(3600);
    expect(r.reading!.source).toBe("chain");
  });

  it("refuses without a reading, naming the missing source rather than summarising", () => {
    const t = trigger({ source_required: "pool address plus DESK_RPC_URL." });
    const r = evaluateTrigger(t, null, NOW);
    expect(r.distance_pct).toBeNull();
    expect(r.breached).toBeNull();
    expect(r.refusal).toContain("pool address plus DESK_RPC_URL");
  });
});

describe("the declared store", () => {
  const triggers = (deskTriggersJson as { triggers: DeclaredTrigger[] }).triggers;

  it("holds the three declared triggers with full provenance", () => {
    expect(triggers.map((t) => t.id).sort()).toEqual([
      "lp-fee-yield-falsifier",
      "pons-floor",
      "pons-review",
    ]);
    for (const t of triggers) {
      expect(t.declared_by.length).toBeGreaterThan(0);
      expect(t.declared_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.source_required.length).toBeGreaterThan(0);
    }
  });

  it("pins the declared levels verbatim — editing one is a declaration event", () => {
    const byId = new Map(triggers.map((t) => [t.id, t]));
    expect(byId.get("pons-floor")!.level).toBe(0.408);
    expect(byId.get("pons-review")!.level).toBe(0.455);
    const f = byId.get("lp-fee-yield-falsifier")!;
    expect(f.level).toBe(0.25);
    expect(f.consecutive_readings).toBe(3);
  });
});
