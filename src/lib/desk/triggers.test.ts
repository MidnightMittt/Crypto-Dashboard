import { describe, expect, it } from "vitest";
import deskTriggersJson from "../../data/deskTriggers.json";
import registerJson from "../../data/researchRegister.json";
import { FilingHitInput, classifyFiling } from "./filingAlerts";
import { DeclaredTrigger, evaluateTrigger } from "./triggers";
import {
  decodeSwapData,
  decodeTickWord,
  lpFeeShareFromSlot0,
  ponsUsdAtTick,
  valuePerLiquidityWeth,
} from "./poolReader";

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
    // 85% through the range toward the floor — the rule the trading
    // session's own monitor was actually firing on, declared 2026-09-14.
    expect(review.level).toBe(77640 + Math.round(0.85 * (87000 - 77640)));
    expect(review.level).toBe(85596);
    // The review sits BEFORE the floor on the tick axis, as a warning must.
    expect(review.level).toBeLessThan(floor.level);
    const f = byId.get("lp-fee-yield-falsifier")!;
    expect(f.level).toBe(0.25);
    expect(f.consecutive_readings).toBe(3);
    expect(f.breach_when).toBe("at_or_below");
  });

  it("keeps the review trigger's supersession visible — an amendment, not a silent edit", () => {
    /*
     * The old numbers appear in the shared channel and in Mitchell's
     * memory: $0.455 was quoted all week, and 86039 was this site's own
     * translation of it. A reader meeting either must be able to see
     * which form governs and why it changed. If a future edit drops the
     * superseded list, this test is the objection.
     */
    const review = (store.triggers as (DeclaredTrigger & {
      superseded?: { form: string; why_retired: string }[];
    })[]).find((t) => t.id === "pons-review")!;
    expect(review.superseded).toBeDefined();
    const forms = review.superseded!.map((s) => s.form);
    expect(forms).toContain("$0.455 USD");
    expect(forms).toContain("pool_tick 86039");
    for (const s of review.superseded!) {
      expect(s.why_retired.length).toBeGreaterThan(0);
    }
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

describe("swap-scan machinery", () => {
  it("decodes a swap's WETH leg and per-swap liquidity, negative amount0 included", () => {
    // amount0 = -3e18 (WETH out), amount1 arbitrary, sqrtPrice arbitrary,
    // liquidity = 5e22, tick = 84655.
    const word = (v: bigint) => (v < 0n ? BigInt.asUintN(256, v) : v).toString(16).padStart(64, "0");
    const data =
      "0x" + word(-3_000_000_000_000_000_000n) + word(1n) + word(1n) +
      word(50_000_000_000_000_000_000_000n) + word(84655n);
    const s = decodeSwapData(data);
    expect(s.absAmount0Wei).toBe(3_000_000_000_000_000_000n);
    expect(s.liquidity).toBe(50_000_000_000_000_000_000_000n);
  });

  it("values a unit of liquidity consistently across the range boundaries", () => {
    const [lo, hi] = [77640, 87000];
    const inRange = valuePerLiquidityWeth(84655, lo, hi);
    const below = valuePerLiquidityWeth(lo - 100, lo, hi);
    const above = valuePerLiquidityWeth(hi + 100, lo, hi);
    for (const v of [inRange, below, above]) expect(v).toBeGreaterThan(0);
    // Continuity at the boundaries: the piecewise formula must meet itself.
    expect(valuePerLiquidityWeth(lo, lo, hi)).toBeCloseTo(valuePerLiquidityWeth(lo - 1, lo, hi), 6);
    expect(valuePerLiquidityWeth(hi, lo, hi)).toBeCloseTo(valuePerLiquidityWeth(hi - 1, lo, hi), 6);
  });

  it("takes the WORSE protocol-fee nibble — a falsifier must not overstate yield", () => {
    const slot0With = (byte: number) =>
      "0x" + "0".repeat(64) + "0".repeat(64) + "0".repeat(64) + "0".repeat(64) + "0".repeat(64) +
      byte.toString(16).padStart(64, "0") + "1".padStart(64, "0");
    expect(lpFeeShareFromSlot0(slot0With(0x66))).toBeCloseTo(1 - 1 / 6, 10);
    expect(lpFeeShareFromSlot0(slot0With(0x00))).toBe(1);
    // Nibbles 4 and 6: the larger cut (1/4) governs.
    expect(lpFeeShareFromSlot0(slot0With(0x46))).toBeCloseTo(1 - 1 / 4, 10);
    expect(lpFeeShareFromSlot0(slot0With(0x64))).toBeCloseTo(1 - 1 / 4, 10);
  });
});

describe("filing classification — the amended declaration, no scores", () => {
  const BOOK = ["FRMI", "CLSK"];
  const hit = (over: Partial<FilingHitInput>): FilingHitInput => ({
    symbol: "MSFT",
    form: "8-K",
    filer: "MICROSOFT CORP",
    registrant: "MICROSOFT CORP",
    ...over,
  });

  it("(a) any species on a book-or-thesis name interrupts — the FRMI financing 8-K case", () => {
    /*
     * The site's own first proposal missed exactly this: a self-filed 8-K
     * on the thesis name, no third party, no proxy species. The amendment
     * exists because of it.
     */
    const c = classifyFiling(hit({ symbol: "FRMI", form: "8-K", filer: "Fermi Inc.", registrant: "Fermi Inc." }), BOOK);
    expect(c.level).toBe("interrupt");
    expect(c.rule).toContain("book-or-thesis");
  });

  it("(b) a filer who is not the registrant interrupts on any watched name", () => {
    const c = classifyFiling(hit({ form: "PX14A6G", filer: "NEUGEBAUER TOBY R" }), BOOK);
    expect(c.level).toBe("interrupt");
    expect(c.rule).toContain("not the registrant");
  });

  it("(c) proxy-family species interrupt regardless of filer", () => {
    const c = classifyFiling(hit({ form: "DEF 14A" }), BOOK);
    expect(c.level).toBe("interrupt");
    expect(c.rule).toContain("proxy-family");
  });

  it("rows the routine case, and a NULL filer does not fake an interrupt", () => {
    expect(classifyFiling(hit({ form: "424B5" }), BOOK).level).toBe("row");
    // Missing data is missing data — a failed header fetch must not page a human.
    expect(classifyFiling(hit({ form: "424B5", filer: null }), BOOK).level).toBe("row");
  });

  it("compares filers loosely on case and punctuation, so 'Fermi Inc.' matches 'FERMI INC'", () => {
    expect(classifyFiling(hit({ filer: "Microsoft Corp." }), BOOK).level).toBe("row");
  });
});

describe("the register store", () => {
  const reg = registerJson as unknown as {
    source: { pointInTime: boolean; file: string };
    entries: { id: string; status: string; evidence: string; reopen: string | null; addendum: string | null }[];
  };

  it("is a point-in-time snapshot with its source named", () => {
    expect(reg.source.pointInTime).toBe(true);
    expect(reg.source.file).toBe("REGISTER_SNAPSHOT_2026-09-14.md");
  });

  it("every entry carries a status and one-line evidence; ids are unique", () => {
    expect(reg.entries.length).toBeGreaterThanOrEqual(40);
    expect(new Set(reg.entries.map((e) => e.id)).size).toBe(reg.entries.length);
    for (const e of reg.entries) {
      expect(e.status.length).toBeGreaterThan(0);
      expect(e.evidence.length).toBeGreaterThan(20);
    }
  });

  it("preserves the compound statuses and addenda the source warned about flattening", () => {
    const wyckoff = reg.entries.find((e) => e.id === "wyckoff")!;
    expect(wyckoff.status).toContain("REJECTED <=21 SESSIONS");
    expect(wyckoff.status).toContain("UNTESTABLE MULTI-MONTH");
    expect(wyckoff.addendum).toContain("UNFALSIFIABILITY");
    expect(wyckoff.reopen).toContain("3,000 names");
  });

  it("carries the dated reopen conditions the calendar cares about", () => {
    const shortSale = reg.entries.find((e) => e.id === "short-sale-share")!;
    expect(shortSale.reopen).toContain("2028");
    const vrp = reg.entries.find((e) => e.id === "variance-risk-premium")!;
    expect(vrp.reopen).toContain("March 2027");
    expect(vrp.reopen).toContain("Do not peek");
  });
});
