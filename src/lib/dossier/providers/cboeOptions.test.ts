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

/*
 * Fixed as-of date, two weeks before the 2026-08-14 expiry these fixtures
 * use. Without it the suite reads the wall clock, so the day the clock
 * reaches that expiry every ATM-IV case silently becomes a 0DTE chain and
 * gets excluded — which is precisely what happened when the 0DTE rule
 * landed. A dated fixture must carry its own date.
 */
const AS_OF = Date.UTC(2026, 6, 31);

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
      100,
      AS_OF
    )!;
    expect(s.nearestExpiry).toBe("2026-08-14");
    expect(s.atmIvPct).toBeCloseTo(30, 6); // mean(0.28, 0.32) → 30%
  });

  it("returns null ATM IV rather than a one-contract guess", () => {
    const s = summariseChain([contract("XX260814C00100000", { iv: 0.28 })], 100, AS_OF)!;
    expect(s.atmIvPct).toBeNull();
  });

  /*
   * THE CLIFF, found live rather than in a test. This used to read
   * `mean < 3 ? mean * 100 : mean`, inferring whether the figure had already
   * been scaled. Every source feeding ParsedContract delivers a decimal, so
   * the guess bought nothing — and above 300% it silently divided by a
   * hundred. HUT's nearest-expiry ATM IV was 3.345 on the day this was
   * found: the page reported "3%" for a stock implying 335%, in the one
   * direction that makes options look free.
   */
  it("reports vol above 300% at full size instead of collapsing it", () => {
    const s = summariseChain(
      [contract("XX260814C00100000", { iv: 3.3 }), contract("XX260814P00100000", { iv: 3.39 })],
      100,
      AS_OF
    )!;
    expect(s.atmIvPct).toBeCloseTo(334.5, 6);
  });

  /*
   * 0DTE CONTAMINATION, found on the live site by the cross-validation
   * script rather than here. Annualising a contract with hours left divides
   * by a near-zero sqrt(T) and the quotient pins high whatever the market
   * thinks. On 2026-08-14 every equity checked sat on an expiring-today
   * chain and reported 216-300% against realised vol nearer 90-120%:
   * CIFR 300, HUT 299, IREN 272, WULF 216. Four names clustering that
   * tightly is the annualisation talking, not four views on risk.
   *
   * optionsIntelligence.ts already excluded 0DTE. This module is the one
   * that actually renders on the equity dossier, so the rule was only half
   * enforced — which is exactly how it survived.
   */
  it("skips an expiring-today chain and reads the next real tenor", () => {
    const now = Date.UTC(2026, 7, 14, 15, 0); // 2026-08-14, mid-session
    const s = summariseChain(
      [
        // Expiring today, wildly annualised — must not be the ATM read.
        contract("XX260814C00100000", { iv: 3.0 }),
        contract("XX260814P00100000", { iv: 3.0 }),
        // The next real expiry, three weeks out.
        contract("XX260904C00100000", { iv: 0.62 }),
        contract("XX260904P00100000", { iv: 0.58 }),
      ],
      100,
      now
    )!;
    expect(s.nearestExpiry).toBe("2026-09-04");
    expect(s.atmIvPct).toBeCloseTo(60, 6);
    // 15:00 on the 14th to midnight on the 4th is 20.4 days, which rounds to 20.
    expect(s.atmIvDaysToExpiry).toBe(20);
  });

  it("reports no ATM vol at all when the whole chain expires today", () => {
    // No number beats a number that is only an artefact of the clock.
    const now = Date.UTC(2026, 7, 14, 15, 0);
    const s = summariseChain(
      [contract("XX260814C00100000", { iv: 3.0 }), contract("XX260814P00100000", { iv: 3.0 })],
      100,
      now
    )!;
    expect(s.atmIvPct).toBeNull();
    expect(s.nearestExpiry).toBeNull();
  });

  /*
   * An annualised vol without its tenor is not a usable number — the same
   * figure means different things on a three-day and a monthly expiry, and
   * this page shows both.
   */
  it("carries the tenor alongside the figure", () => {
    const s = summariseChain(
      [contract("XX260814C00100000", { iv: 0.28 }), contract("XX260814P00100000", { iv: 0.32 })],
      100,
      AS_OF
    )!;
    expect(s.nearestExpiry).toBe("2026-08-14");
    expect(s.atmIvDaysToExpiry).not.toBeNull();
    expect(s.atmIvDaysToExpiry).toBeGreaterThanOrEqual(0);
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
