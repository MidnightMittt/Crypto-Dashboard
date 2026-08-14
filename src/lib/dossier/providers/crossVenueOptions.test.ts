import { describe, expect, it } from "vitest";
import { ParsedContract } from "./cboeOptions";
import { crossConfirm } from "./crossVenueOptions";
import { toParsedContract } from "./tradierOptions";

/**
 * A chain built to hand-set the three cross-venue checks. Two ATM calls and
 * two ATM puts on one expiry, spot 100 — enough for summariseParsed to
 * compute ATM IV (needs ≥2 in-band nonzero-IV contracts), put/call OI, and a
 * gamma sign.
 */
function chain(o: {
  expiry?: string;
  iv?: number;
  callOi?: number;
  putOi?: number;
  callGamma?: number;
  putGamma?: number;
}): ParsedContract[] {
  const expiry = o.expiry ?? "2026-08-14";
  const iv = o.iv ?? 0.3;
  const callOi = o.callOi ?? 100;
  const putOi = o.putOi ?? 100;
  const callGamma = o.callGamma ?? 0.02;
  const putGamma = o.putGamma ?? 0.02;
  return [
    { expiry, kind: "call", strike: 99, iv, gamma: callGamma, openInterest: callOi, volume: 0 },
    { expiry, kind: "call", strike: 101, iv, gamma: callGamma, openInterest: callOi, volume: 0 },
    { expiry, kind: "put", strike: 99, iv, gamma: putGamma, openInterest: putOi, volume: 0 },
    { expiry, kind: "put", strike: 101, iv, gamma: putGamma, openInterest: putOi, volume: 0 },
  ];
}

describe("crossConfirm", () => {
  it("reports full agreement when both venues match on IV, positioning and gamma sign", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ iv: 0.3, callOi: 200, putOi: 100 }) },
      { spot: 100, contracts: chain({ iv: 0.31, callOi: 220, putOi: 90 }) },
      "2026-08-14"
    )!;
    expect(r.comparisons).toBe(3);
    expect(r.agreements).toBe(3);
    expect(r.ivAgree).toBe(true);
    expect(r.putCallAgree).toBe(true); // both call-heavy (P/C < 1)
    expect(r.gexAgree).toBe(true);
    expect(r.line).toContain("agrees on all 3");
  });

  it("flags an implied-vol disagreement loudly and names both numbers", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ iv: 0.3 }) },
      { spot: 100, contracts: chain({ iv: 0.9 }) }, // 30% vs 90% — far outside tolerance
      "2026-08-14"
    )!;
    expect(r.ivAgree).toBe(false);
    expect(r.line).toContain("30%");
    expect(r.line).toContain("90%");
  });

  it("catches opposite dealer-gamma signs across venues", () => {
    // Primary: puts dominate gamma (net negative). Secondary: calls dominate (net positive).
    const r = crossConfirm(
      { spot: 100, contracts: chain({ callGamma: 0.001, putGamma: 0.05 }) },
      { spot: 100, contracts: chain({ callGamma: 0.05, putGamma: 0.001 }) },
      "2026-08-14"
    )!;
    expect(r.gexSignPrimary).toBe(-1);
    expect(r.gexSignSecondary).toBe(1);
    expect(r.gexAgree).toBe(false);
    expect(r.line).toContain("sign of dealer gamma");
  });

  it("returns null when the venues share no contracts on the requested expiry", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ expiry: "2026-08-14" }) },
      { spot: 100, contracts: chain({ expiry: "2026-09-18" }) },
      "2026-08-14"
    );
    expect(r).toBeNull();
  });
});

describe("toParsedContract (Tradier row mapping)", () => {
  it("maps a full Tradier row onto the shared shape, pulling ORATS mid IV", () => {
    expect(
      toParsedContract({
        strike: 207.5,
        option_type: "put",
        expiration_date: "2026-08-14",
        open_interest: 9226,
        volume: 0,
        greeks: { gamma: 0.00061, mid_iv: 0.6673 },
      })
    ).toEqual({
      expiry: "2026-08-14",
      kind: "put",
      strike: 207.5,
      iv: 0.6673,
      gamma: 0.00061,
      openInterest: 9226,
      volume: 0,
    });
  });

  it("refuses a row missing its strike, type or expiry rather than inventing zeros", () => {
    expect(toParsedContract({ option_type: "call", expiration_date: "2026-08-14" })).toBeNull();
    expect(toParsedContract({ strike: 100, expiration_date: "2026-08-14" })).toBeNull();
    expect(toParsedContract({ strike: 100, option_type: "call" })).toBeNull();
  });

  it("defaults absent greeks and interest to zero, so a thin row is usable but empty", () => {
    expect(toParsedContract({ strike: 100, option_type: "call", expiration_date: "2026-08-14" })).toEqual({
      expiry: "2026-08-14",
      kind: "call",
      strike: 100,
      iv: 0,
      gamma: 0,
      openInterest: 0,
      volume: 0,
    });
  });
});
