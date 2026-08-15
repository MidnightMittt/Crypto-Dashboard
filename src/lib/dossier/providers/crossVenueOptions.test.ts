import { describe, expect, it } from "vitest";
import { ParsedContract } from "./cboeOptions";
import { crossConfirm } from "./crossVenueOptions";
import { toParsedContract } from "./tradierOptions";

/**
 * A chain built to hand-set the cross-venue checks. Two ATM calls and two ATM
 * puts on one expiry, spot 100 — enough for summariseParsed to compute ATM IV
 * (needs ≥2 in-band nonzero-IV contracts), put/call OI, and a gamma sign.
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

/*
 * The fixtures below expire 2026-08-14. Pinned to a fixed as-of date two
 * weeks earlier, because summariseParsed now excludes expiring-today chains
 * — without this the whole suite silently changes meaning on that date.
 */
const AS_OF = Date.UTC(2026, 6, 31);

describe("crossConfirm", () => {
  it("counts only the INDEPENDENT checks — the shared-source put/call ratio is not a vote", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ iv: 0.3, callOi: 200, putOi: 100 }) },
      { spot: 100, contracts: chain({ iv: 0.305, callOi: 200, putOi: 100 }) },
      "2026-08-14",
      AS_OF
    )!;
    // Two independent checks (IV, gamma sign) — NOT three.
    expect(r.comparisons).toBe(2);
    expect(r.agreements).toBe(2);
    expect(r.openInterestIdentical).toBe(true);
    expect(r.line).toContain("data-integrity check rather than a second opinion");
  });

  it("reports the implied-vol gap in points, not just a verdict", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ iv: 0.3 }) },
      { spot: 100, contracts: chain({ iv: 0.313 }) },
      "2026-08-14",
      AS_OF
    )!;
    expect(r.ivGapPoints).toBeCloseTo(1.3, 5);
    expect(r.line).toContain("1.3 implied-vol points");
  });

  /*
   * THE REGRESSION THIS FILE EXISTS FOR. Measured live: AAPL priced 32.1% at
   * CBOE against 38.3% at Tradier — a 6.1-point gap that the original
   * 5-point/20%-relative tolerance passed as "agrees on all 3". A materially
   * different option price must not read as corroboration.
   */
  it("calls AAPL's real 6.1-point venue gap a DISAGREEMENT, not agreement", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ iv: 0.3211 }) },
      { spot: 100, contracts: chain({ iv: 0.3825 }) },
      "2026-08-14",
      AS_OF
    )!;
    expect(r.ivGapPoints).toBeCloseTo(6.14, 2);
    expect(r.ivAgree).toBe(false);
    expect(r.line).toContain("6.1 implied-vol points away");
    expect(r.line).toContain("disagree materially");
    expect(r.line).not.toContain("same place");
  });

  it("still tolerates a few points on a high-vol name, where they are noise", () => {
    // IREN-like: ~104% IV. A 3-point gap there is under 5% relative.
    const r = crossConfirm(
      { spot: 100, contracts: chain({ iv: 1.04 }) },
      { spot: 100, contracts: chain({ iv: 1.07 }) },
      "2026-08-14",
      AS_OF
    )!;
    expect(r.ivAgree).toBe(true);
  });

  it("catches opposite dealer-gamma signs across venues", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ callGamma: 0.001, putGamma: 0.05 }) },
      { spot: 100, contracts: chain({ callGamma: 0.05, putGamma: 0.001 }) },
      "2026-08-14",
      AS_OF
    )!;
    expect(r.gexSignPrimary).toBe(-1);
    expect(r.gexSignSecondary).toBe(1);
    expect(r.gexAgree).toBe(false);
    expect(r.line).toContain("OPPOSITE sides");
  });

  it("flags mismatched open interest as a stale feed, since OCC data cannot legitimately differ", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ callOi: 200, putOi: 100 }) },
      { spot: 100, contracts: chain({ callOi: 200, putOi: 180 }) },
      "2026-08-14",
      AS_OF
    )!;
    expect(r.openInterestIdentical).toBe(false);
    expect(r.line).toContain("stale or partial");
  });

  it("returns null when the venues share no contracts on the requested expiry", () => {
    const r = crossConfirm(
      { spot: 100, contracts: chain({ expiry: "2026-08-14" }) },
      { spot: 100, contracts: chain({ expiry: "2026-09-18" }) },
      "2026-08-14",
      AS_OF
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
