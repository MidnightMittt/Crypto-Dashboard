import { describe, expect, it } from "vitest";
import deskTriggersJson from "../../data/deskTriggers.json";
import { DeclaredTrigger, evaluateTrigger } from "./triggers";
import { decodeTickWord, ponsUsdAtTick } from "./poolReader";

const NOW = Date.parse("2026-09-14T12:00:00Z");

function trigger(overrides: Partial<DeclaredTrigger> = {}): DeclaredTrigger {
  return {
    id: "t",
    subject: "TEST",
    kind: "price_floor",
    level: 10,
    unit: "USD",
    breach_when: "at_or_below",
    declared_by: "test",
    declared_on: "2026-09-14",
    on_breach: "test",
    source_required: "a test source.",
    ...overrides,
  };
}

const reading = (value: number, observed_at = "2026-09-14T11:59:00Z") => ({
  value,
  source: "s",
  observed_at,
});

describe("evaluateTrigger — orientation is declared, and negative always means crossed", () => {
  it("at_or_below: value under the level goes negative", () => {
    const above = evaluateTrigger(trigger(), reading(11), NOW);
    const below = evaluateTrigger(trigger(), reading(9), NOW);
    expect(above.distance).toBe(10);
    expect(above.breached).toBe(false);
    expect(below.distance).toBe(-10);
    expect(below.breached).toBe(true);
  });

  it("at_or_above: value over the level goes negative", () => {
    const t = trigger({ breach_when: "at_or_above" });
    expect(evaluateTrigger(t, reading(9), NOW).breached).toBe(false);
    expect(evaluateTrigger(t, reading(11), NOW).distance).toBe(-10);
    expect(evaluateTrigger(t, reading(11), NOW).breached).toBe(true);
  });

  it("exactly at the level counts as crossed on both orientations", () => {
    expect(evaluateTrigger(trigger(), reading(10), NOW).breached).toBe(true);
    expect(evaluateTrigger(trigger({ breach_when: "at_or_above" }), reading(10), NOW).breached).toBe(true);
  });

  it("pool_tick triggers measure distance in ticks, not percent", () => {
    const t = trigger({ kind: "pool_tick", level: 87000, breach_when: "at_or_above", unit: "tick" });
    const r = evaluateTrigger(t, reading(84655), NOW);
    expect(r.distance_unit).toBe("ticks");
    expect(r.distance).toBe(2345);
    expect(r.breached).toBe(false);
    expect(evaluateTrigger(t, reading(87100), NOW).distance).toBe(-100);
  });

  it("carries the reading's age in seconds, never a bare value", () => {
    const r = evaluateTrigger(trigger(), reading(11, "2026-09-14T11:00:00Z"), NOW);
    expect(r.reading!.age_seconds).toBe(3600);
    expect(r.reading!.source).toBe("s");
  });

  it("refuses without a reading, naming the missing source rather than summarising", () => {
    const t = trigger({ source_required: "pool address plus DESK_RPC_URL." });
    const r = evaluateTrigger(t, null, NOW);
    expect(r.distance).toBeNull();
    expect(r.breached).toBeNull();
    expect(r.refusal).toContain("pool address plus DESK_RPC_URL");
  });
});

describe("poolReader — the decode and the conversion, pinned to the declarer's own table", () => {
  it("decodes a positive int24 from its sign-extended word", () => {
    // The word observed live on 2026-09-14: tick 84655.
    expect(decodeTickWord("0000000000000000000000000000000000000000000000000000000000014aaf")).toBe(84655);
  });

  it("decodes a negative tick via two's complement", () => {
    // int24 -50 sign-extended fills the word with ff.
    expect(decodeTickWord("f".repeat(62) + "ce")).toBe(-50);
  });

  it("reproduces all six cells of the trading session's own USD conversion table", () => {
    // Their table, verbatim from the declaration message:
    //   ETH $2,000 -> floor $0.333, ceiling $0.850
    //   ETH $2,480 -> floor $0.413, ceiling $1.054
    //   ETH $3,000 -> floor $0.500, ceiling $1.275
    // Agreement here is what licenses every USD convenience figure the
    // desk renders — and it also pins the decimals assumption (both
    // tokens 18), since the table only reconciles if that holds.
    expect(ponsUsdAtTick(87000, 2000)).toBeCloseTo(0.3333, 3);
    expect(ponsUsdAtTick(77640, 2000)).toBeCloseTo(0.8498, 3);
    expect(ponsUsdAtTick(87000, 2480)).toBeCloseTo(0.4133, 3);
    expect(ponsUsdAtTick(77640, 2480)).toBeCloseTo(1.0538, 3);
    expect(ponsUsdAtTick(87000, 3000)).toBeCloseTo(0.5, 3);
    expect(ponsUsdAtTick(77640, 3000)).toBeCloseTo(1.2748, 3);
  });
});

describe("the declared store", () => {
  const store = deskTriggersJson as unknown as {
    triggers: DeclaredTrigger[];
    declared_events: { id: string; date: string; date_precision: string; source: string }[];
  };

  it("holds the three declared triggers with full provenance and orientation", () => {
    expect(store.triggers.map((t) => t.id).sort()).toEqual([
      "lp-fee-yield-falsifier",
      "pons-floor",
      "pons-review",
    ]);
    for (const t of store.triggers) {
      expect(t.declared_by.length).toBeGreaterThan(0);
      expect(t.declared_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.source_required.length).toBeGreaterThan(0);
      expect(["at_or_above", "at_or_below"]).toContain(t.breach_when);
    }
  });

  it("pins the LP price triggers in ticks — the single-sourced form", () => {
    const byId = new Map(store.triggers.map((t) => [t.id, t]));
    const floor = byId.get("pons-floor")!;
    expect(floor.kind).toBe("pool_tick");
    expect(floor.level).toBe(87000);
    expect(floor.breach_when).toBe("at_or_above"); // rising tick = falling PONS
    const review = byId.get("pons-review")!;
    expect(review.kind).toBe("pool_tick");
    expect(review.level).toBe(86039);
    // The review sits BEFORE the floor on the tick axis, as a warning must.
    expect(review.level).toBeLessThan(floor.level);
    expect(review.derivation).toContain("2,480");
    const f = byId.get("lp-fee-yield-falsifier")!;
    expect(f.level).toBe(0.25);
    expect(f.consecutive_readings).toBe(3);
    expect(f.breach_when).toBe("at_or_below");
  });

  it("carries the declared events dated, sourced and precision-stamped", () => {
    expect(store.declared_events.map((e) => e.id).sort()).toEqual([
      "frmi-annual-meeting",
      "frmi-proxy-statement",
      "robinhood-chain-gas-waiver-lapse",
    ]);
    for (const e of store.declared_events) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.date_precision.length).toBeGreaterThan(0);
      expect(e.source.length).toBeGreaterThan(0);
    }
    // The waiver date is approximate and must say so, loudly enough to grep.
    const waiver = store.declared_events.find((e) => e.id === "robinhood-chain-gas-waiver-lapse")!;
    expect(waiver.date_precision).toContain("approximate");
    expect(waiver.source).toContain("press");
  });
});
