import { describe, expect, it } from "vitest";
import { parseHeldPositions } from "./parseHeldPositions";

const NOW = Date.UTC(2026, 7, 22);

/**
 * The production failure this guards: /api/portfolio takes `quantity`, this
 * route took `shares`, and a book sent under the sibling's key was silently
 * coerced to zero shares — the exposure check compared against an empty
 * book while appearing to have been given one. Two independent audit
 * reports called the check "missing" before the coercion was found.
 */
describe("parseHeldPositions", () => {
  it("accepts the shares key", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: 600, price: 15.93 }], NOW);
    expect(r).toEqual({ ok: true, positions: [{ kind: "equity", symbol: "CIFR", shares: 600, price: 15.93 }] });
  });

  it("accepts the quantity key — the /api/portfolio convention — identically", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", quantity: 600, price: 15.93 }], NOW);
    expect(r).toEqual({ ok: true, positions: [{ kind: "equity", symbol: "CIFR", shares: 600, price: 15.93 }] });
  });

  it("errors when both keys are present and disagree, naming both values", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: 600, quantity: 6, price: 15.93 }], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("disagree");
      expect(r.error).toContain("600");
      expect(r.error).toContain("6");
    }
  });

  it("accepts both keys when they agree", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: 6, quantity: 6, price: 15.93 }], NOW);
    expect(r.ok).toBe(true);
  });

  it("never zero-coerces: a position without a size is an error naming the row", () => {
    const r = parseHeldPositions([
      { symbol: "RIOT", shares: 4, price: 21.39 },
      { symbol: "CIFR", price: 15.93 },
    ], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("existing_positions[1] (CIFR)");
  });

  it("refuses a missing or non-positive price rather than pricing the book at zero", () => {
    const missing = parseHeldPositions([{ symbol: "CIFR", shares: 6 }], NOW);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("price");

    const zero = parseHeldPositions([{ symbol: "CIFR", shares: 6, price: 0 }], NOW);
    expect(zero.ok).toBe(false);
  });

  it("refuses zero and non-finite share counts", () => {
    expect(parseHeldPositions([{ symbol: "CIFR", shares: 0, price: 15.93 }], NOW).ok).toBe(false);
    expect(parseHeldPositions([{ symbol: "CIFR", shares: "abc", price: 15.93 }], NOW).ok).toBe(false);
  });

  it("keeps a short position signed — a short genuinely offsets book exposure", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: -6, price: 15.93 }], NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.positions[0]).toMatchObject({ shares: -6 });
  });

  it("requires a symbol and names the row that lacks one", () => {
    const r = parseHeldPositions([{ shares: 6, price: 15.93 }], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("existing_positions[0]");
  });

  it("treats an absent field as an empty book and a non-array as an error", () => {
    expect(parseHeldPositions(undefined, NOW)).toEqual({ ok: true, positions: [] });
    expect(parseHeldPositions(null, NOW)).toEqual({ ok: true, positions: [] });
    expect(parseHeldPositions("CIFR", NOW).ok).toBe(false);
  });

  it("upper-cases and trims symbols so the beta lookup matches", () => {
    const r = parseHeldPositions([{ symbol: " cifr ", shares: 6, price: 15.93 }], NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.positions[0].symbol).toBe("CIFR");
  });
});

/**
 * Held OPTION legs — the real book this account carries. Validation is the
 * same function /api/portfolio uses, so one contract cannot be a valid leg
 * to one endpoint and an invalid one to the other.
 */
describe("parseHeldPositions — option legs", () => {
  const BTDR_CALL = {
    symbol: "BTDR",
    quantity: 1,
    price: 1.25,
    strike: 10.5,
    expiry: "2026-08-28",
    right: "call",
    delta: 0.724,
  };

  it("parses the real held BTDR call with the default multiplier", () => {
    const r = parseHeldPositions([BTDR_CALL], NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.positions[0]).toMatchObject({
        kind: "option",
        symbol: "BTDR",
        contracts: 1,
        premium: 1.25,
        underlyingPrice: null,
      });
      expect(r.positions[0]).toMatchObject({ leg: { multiplier: 100, right: "call", delta: 0.724 } });
    }
  });

  it("carries a caller-supplied underlying price", () => {
    const r = parseHeldPositions([{ ...BTDR_CALL, underlying_price: 11.37 }], NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.positions[0]).toMatchObject({ underlyingPrice: 11.37 });
  });

  it("refuses a leg missing delta, naming the row and the contract", () => {
    const { delta: _omitted, ...noDelta } = BTDR_CALL;
    const r = parseHeldPositions([noDelta], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("existing_positions[0] (BTDR)");
      expect(r.error).toContain("delta");
    }
  });

  it("refuses an expired held contract — it has no forward exposure to count", () => {
    const r = parseHeldPositions([{ ...BTDR_CALL, expiry: "2026-08-14" }], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("option_expired");
  });

  it("treats a lone option field as declaring a leg, never as noise", () => {
    const r = parseHeldPositions([{ symbol: "BTDR", quantity: 1, price: 1.25, multiplier: 100 }], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("option_leg_missing_or_invalid");
  });
});
