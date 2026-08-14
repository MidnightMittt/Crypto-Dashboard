import { describe, expect, it } from "vitest";
import { CboeContract, parseContractSymbol, summariseChain } from "./cboeOptions";

describe("parseContractSymbol", () => {
  it("parses the OCC form from the right, so variable-length roots survive", () => {
    expect(parseContractSymbol("AAPL260814C00215000")).toEqual({
      expiry: "2026-08-14",
      kind: "call",
      strike: 215,
    });
    // Five-character root plus a fractional strike.
    expect(parseContractSymbol("GOOGL261218P00187500")).toEqual({
      expiry: "2026-12-18",
      kind: "put",
      strike: 187.5,
    });
  });

  it("rejects garbage rather than guessing", () => {
    expect(parseContractSymbol("AAPL")).toBeNull();
    expect(parseContractSymbol("AAPL260814X00215000")).toBeNull();
    expect(parseContractSymbol("AAPL260814C00000000")).toBeNull();
  });
});

const contract = (
  option: string,
  over: Partial<CboeContract> = {}
): CboeContract => ({ option, iv: 0.3, gamma: 0.01, delta: 0.5, open_interest: 100, volume: 10, ...over });

describe("summariseChain", () => {
  it("computes put/call ratios from open interest and volume separately", () => {
    /*
     * Hand-set: calls 300 OI / 30 vol, puts 150 OI / 60 vol.
     * P/C OI = 0.5; P/C volume = 2.0 — deliberately different, because OI is
     * the standing position and volume is today's activity, and conflating
     * them is a classic retail mistake.
     */
    const s = summariseChain(
      [
        contract("AAPL260814C00100000", { open_interest: 300, volume: 30 }),
        contract("AAPL260814P00100000", { open_interest: 150, volume: 60 }),
      ],
      100
    )!;
    expect(s.putCallOiRatio).toBeCloseTo(0.5, 10);
    expect(s.putCallVolumeRatio).toBeCloseTo(2.0, 10);
  });

  it("computes net gamma exposure with the stated sign convention, hand-verified", () => {
    /*
     * One call, one put, identical gamma 0.02 and OI 100 at spot 100:
     *   per contract = 0.02 × 100 × 100 shares × $100 × $1 (1% of 100) = 20,000
     * Call adds +20,000; put subtracts 20,000 → net 0.
     * Then doubling the call OI must give exactly +20,000.
     */
    const balanced = summariseChain(
      [
        contract("XX260814C00100000", { gamma: 0.02, open_interest: 100 }),
        contract("XX260814P00100000", { gamma: 0.02, open_interest: 100 }),
      ],
      100
    )!;
    expect(balanced.netGexUsdPer1Pct).toBeCloseTo(0, 6);

    const callHeavy = summariseChain(
      [
        contract("XX260814C00100000", { gamma: 0.02, open_interest: 200 }),
        contract("XX260814P00100000", { gamma: 0.02, open_interest: 100 }),
      ],
      100
    )!;
    expect(callHeavy.netGexUsdPer1Pct).toBeCloseTo(20_000, 6);
  });

  it("reads ATM IV from the nearest expiry only, normalising CBOE's decimal form to percent", () => {
    const s = summariseChain(
      [
        contract("XX260814C00100000", { iv: 0.28 }),
        contract("XX260814P00100000", { iv: 0.32 }),
        // Far expiry with wild IV must not contaminate the ATM read.
        contract("XX270115C00100000", { iv: 0.9 }),
        // Far-from-money strike on the near expiry must be excluded too.
        contract("XX260814C00150000", { iv: 0.8 }),
      ],
      100
    )!;
    expect(s.nearestExpiry).toBe("2026-08-14");
    expect(s.atmIvPct).toBeCloseTo(30, 6); // mean(0.28, 0.32) → 30%
  });

  it("returns null ATM IV rather than a one-contract guess", () => {
    const s = summariseChain([contract("XX260814C00100000", { iv: 0.28 })], 100)!;
    expect(s.atmIvPct).toBeNull();
  });

  it("returns null GEX when the feed carries no greeks, never zero", () => {
    // Zero would read as "perfectly balanced dealers", which is a claim.
    const s = summariseChain([contract("XX260814C00100000", { gamma: 0 })], 100)!;
    expect(s.netGexUsdPer1Pct).toBeNull();
  });

  it("surfaces the largest open-interest strikes as concrete levels", () => {
    const s = summariseChain(
      [
        contract("XX260814C00110000", { open_interest: 5000 }),
        contract("XX260814P00090000", { open_interest: 9000 }),
        contract("XX260814C00100000", { open_interest: 100 }),
      ],
      100
    )!;
    expect(s.largestOiStrikes[0]).toMatchObject({ strike: 90, kind: "put", openInterest: 9000 });
    expect(s.largestOiStrikes[1]).toMatchObject({ strike: 110, kind: "call", openInterest: 5000 });
  });

  it("carries the dealer-convention caveat in the data itself", () => {
    const s = summariseChain([contract("XX260814C00100000")], 100)!;
    expect(s.gexCaveat).toContain("assumption, not an observation");
  });
});
