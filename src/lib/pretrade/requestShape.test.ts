import { describe, expect, it } from "vitest";
import { REQUEST_SHAPE, collectShapeDefects } from "./requestShape";

/**
 * The contract under test is ROUND TRIPS, not validity: a caller discovering
 * this endpoint cold used to need four calls to a first successful audit,
 * one revealed field per 400. Every test here is of the form "a body with N
 * problems produces one list naming all N".
 */

const NOW = Date.UTC(2026, 8, 13, 14, 30, 0);

describe("collectShapeDefects", () => {
  /* The cold start. All three requirements in one response, not one per call. */
  it("names symbol, account_value and the equity-or-option requirement at once on an empty body", () => {
    const defects = collectShapeDefects({}, NOW);
    expect(defects.some((d) => d.includes("symbol"))).toBe(true);
    expect(defects.some((d) => d.includes("account_value"))).toBe(true);
    expect(defects.some((d) => d.includes("option_order"))).toBe(true);
    expect(defects).toHaveLength(3);
  });

  it("names only the missing members of the equity trio, not the whole trio", () => {
    const defects = collectShapeDefects(
      { symbol: "CLSK", account_value: 4200, shares: 40, entry: 12.4 },
      NOW
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain("stop");
    expect(defects[0]).not.toContain("shares,");
  });

  /*
   * The measured worst case: an option body with several problems used to
   * reveal them one 400 at a time. Premium, contracts and every leg field
   * now arrive together.
   */
  it("names premium, contracts and all leg defects in one pass", () => {
    const defects = collectShapeDefects(
      {
        symbol: "FRMI",
        account_value: 4200,
        option_order: { contracts: 0.5, right: "call" },
      },
      NOW
    );
    expect(defects.some((d) => d.includes("contracts"))).toBe(true);
    expect(defects.some((d) => d.includes("PER-CONTRACT premium"))).toBe(true);
    // parseOptionLeg aggregates its own missing fields into one reason.
    const leg = defects.find((d) => d.includes("option_leg_missing_or_invalid"));
    expect(leg).toBeDefined();
    expect(leg).toContain("strike");
    expect(leg).toContain("expiry");
    expect(leg).toContain("delta");
  });

  it("folds a partial live_price into the same pass as everything else", () => {
    const defects = collectShapeDefects(
      { symbol: "CLSK", live_price: { value: 15.75 } },
      NOW
    );
    expect(defects.some((d) => d.includes("account_value"))).toBe(true);
    expect(defects.some((d) => d.includes("live_price is incomplete"))).toBe(true);
    expect(defects.some((d) => d.includes("as_of"))).toBe(true);
    expect(defects.some((d) => d.includes("source"))).toBe(true);
  });

  it("rejects a hold_sessions that would silently disable the stop grid", () => {
    const defects = collectShapeDefects(
      { symbol: "CLSK", account_value: 4200, shares: 40, entry: 12.4, stop: 11.15, hold_sessions: "soon" },
      NOW
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain("hold_sessions");
  });

  /*
   * The documented examples MUST validate — a worked example that 400s is
   * worse than no example, and this is the assertion that keeps the document
   * and the enforcement from drifting apart.
   */
  it("accepts both of REQUEST_SHAPE's own worked examples", () => {
    expect(collectShapeDefects({ ...REQUEST_SHAPE.examples.equity }, NOW)).toEqual([]);
    expect(collectShapeDefects({ ...REQUEST_SHAPE.examples.option }, NOW)).toEqual([]);
  });

  it("accepts a complete live_price without comment", () => {
    const defects = collectShapeDefects(
      {
        ...REQUEST_SHAPE.examples.equity,
        live_price: { value: 12.55, as_of: "2026-09-13T14:29:40Z", source: "broker_mid" },
      },
      NOW
    );
    expect(defects).toEqual([]);
  });
});

describe("REQUEST_SHAPE", () => {
  /*
   * The second measured failure: two checks returned unknown purely because
   * the caller did not know the unlocking fields existed. The document has
   * to say what each optional field BUYS, not just that it may be sent.
   */
  it("says what every optional field unlocks", () => {
    const opt = REQUEST_SHAPE.optional;
    expect(opt.edge_bp).toContain("UNLOCKS");
    expect(opt.hard_floor_usd).toContain("UNLOCKS");
    expect(opt.min_breakeven_reach_pct).toContain("UNLOCKS");
    expect(opt.buying_power).toContain("UNLOCKS");
    expect(opt.live_price._).toContain("UNLOCKS");
    expect(opt.existing_positions).toContain("UNLOCKS");
  });

  it("carries the per-contract premium convention where a caller will see it", () => {
    expect(REQUEST_SHAPE.required.one_of.option.option_order.premium).toContain("0.86, not 86");
  });

  it("states the partial-coverage contract rather than implying universal coverage", () => {
    expect(REQUEST_SHAPE.coverage).toContain("PARTIAL");
    expect(REQUEST_SHAPE.coverage).toContain("scannerUniverse.ts");
  });
});
