import { describe, expect, it } from "vitest";
import { parseHeldPositions } from "./parseHeldPositions";

/**
 * The production failure this guards: /api/portfolio takes `quantity`, this
 * route took `shares`, and a book sent under the sibling's key was silently
 * coerced to zero shares — the exposure check compared against an empty
 * book while appearing to have been given one. Two independent audit
 * reports called the check "missing" before the coercion was found.
 */
describe("parseHeldPositions", () => {
  it("accepts the shares key", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: 600, price: 15.93 }]);
    expect(r).toEqual({ ok: true, positions: [{ symbol: "CIFR", shares: 600, price: 15.93 }] });
  });

  it("accepts the quantity key — the /api/portfolio convention — identically", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", quantity: 600, price: 15.93 }]);
    expect(r).toEqual({ ok: true, positions: [{ symbol: "CIFR", shares: 600, price: 15.93 }] });
  });

  it("errors when both keys are present and disagree, naming both values", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: 600, quantity: 6, price: 15.93 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("disagree");
      expect(r.error).toContain("600");
      expect(r.error).toContain("6");
    }
  });

  it("accepts both keys when they agree", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: 6, quantity: 6, price: 15.93 }]);
    expect(r.ok).toBe(true);
  });

  it("never zero-coerces: a position without a size is an error naming the row", () => {
    const r = parseHeldPositions([
      { symbol: "RIOT", shares: 4, price: 21.39 },
      { symbol: "CIFR", price: 15.93 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("existing_positions[1] (CIFR)");
  });

  it("refuses a missing or non-positive price rather than pricing the book at zero", () => {
    const missing = parseHeldPositions([{ symbol: "CIFR", shares: 6 }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("price");

    const zero = parseHeldPositions([{ symbol: "CIFR", shares: 6, price: 0 }]);
    expect(zero.ok).toBe(false);
  });

  it("refuses zero and non-finite share counts", () => {
    expect(parseHeldPositions([{ symbol: "CIFR", shares: 0, price: 15.93 }]).ok).toBe(false);
    expect(parseHeldPositions([{ symbol: "CIFR", shares: "abc", price: 15.93 }]).ok).toBe(false);
  });

  it("keeps a short position signed — a short genuinely offsets book exposure", () => {
    const r = parseHeldPositions([{ symbol: "CIFR", shares: -6, price: 15.93 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.positions[0].shares).toBe(-6);
  });

  it("requires a symbol and names the row that lacks one", () => {
    const r = parseHeldPositions([{ shares: 6, price: 15.93 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("existing_positions[0]");
  });

  it("treats an absent field as an empty book and a non-array as an error", () => {
    expect(parseHeldPositions(undefined)).toEqual({ ok: true, positions: [] });
    expect(parseHeldPositions(null)).toEqual({ ok: true, positions: [] });
    expect(parseHeldPositions("CIFR").ok).toBe(false);
  });

  it("upper-cases and trims symbols so the beta lookup matches", () => {
    const r = parseHeldPositions([{ symbol: " cifr ", shares: 6, price: 15.93 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.positions[0].symbol).toBe("CIFR");
  });
});
