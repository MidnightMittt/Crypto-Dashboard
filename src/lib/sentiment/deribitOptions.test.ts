import { describe, it, expect } from "vitest";
import { parseInstrumentName, summarizeDeribitOptions } from "./deribitOptions";
import { DeribitOptionRow } from "../providers/deribitOptions";

describe("parseInstrumentName", () => {
  it("parses a two-digit-day call", () => {
    const result = parseInstrumentName("BTC-25DEC26-20000-C");
    expect(result).toEqual({ strike: 20000, type: "call", expiry: "2026-12-25", expiryMs: Date.UTC(2026, 11, 25) });
  });

  it("parses a single-digit day without zero-padding, as Deribit sends it", () => {
    const result = parseInstrumentName("BTC-2AUG26-72000-P");
    expect(result).toEqual({ strike: 72000, type: "put", expiry: "2026-08-02", expiryMs: Date.UTC(2026, 7, 2) });
  });

  it("returns null for the wrong number of segments", () => {
    expect(parseInstrumentName("BTC-25DEC26-20000")).toBeNull();
    expect(parseInstrumentName("BTC-25DEC26-20000-C-EXTRA")).toBeNull();
  });

  it("returns null for an unrecognized month abbreviation", () => {
    expect(parseInstrumentName("BTC-25XXX26-20000-C")).toBeNull();
  });

  it("returns null for a type character other than C or P", () => {
    expect(parseInstrumentName("BTC-25DEC26-20000-X")).toBeNull();
  });

  it("returns null for a non-numeric strike", () => {
    expect(parseInstrumentName("BTC-25DEC26-ABCDE-C")).toBeNull();
  });

  it("returns null for a malformed expiry segment", () => {
    expect(parseInstrumentName("BTC-2026DEC-20000-C")).toBeNull();
  });
});

const NOW = 1_700_000_000_000;

function row(overrides: Partial<DeribitOptionRow> & { instrumentName: string }): DeribitOptionRow {
  return {
    openInterest: 0,
    volume: 0,
    markIv: 0,
    underlyingPrice: 65_000,
    ...overrides,
  };
}

describe("summarizeDeribitOptions", () => {
  it("returns null for an empty row list", () => {
    expect(summarizeDeribitOptions("BTC", [], NOW)).toBeNull();
  });

  it("returns null when every instrument name fails to parse", () => {
    const rows = [row({ instrumentName: "garbage", openInterest: 100 })];
    expect(summarizeDeribitOptions("BTC", rows, NOW)).toBeNull();
  });

  it("returns null when no expiry clears the minimum open-interest bar", () => {
    const rows = [
      row({ instrumentName: "BTC-1AUG26-60000-C", openInterest: 5 }),
      row({ instrumentName: "BTC-1AUG26-60000-P", openInterest: 5 }),
    ];
    expect(summarizeDeribitOptions("BTC", rows, NOW)).toBeNull();
  });

  it("skips a nearer expiry with negligible OI in favor of the next one that clears the bar", () => {
    const rows = [
      // Nearest expiry: barely any interest — should be skipped as noise.
      row({ instrumentName: "BTC-1AUG26-60000-C", openInterest: 2 }),
      row({ instrumentName: "BTC-1AUG26-60000-P", openInterest: 2 }),
      // Further out, but with real interest.
      row({ instrumentName: "BTC-1SEP26-60000-C", openInterest: 100 }),
      row({ instrumentName: "BTC-1SEP26-60000-P", openInterest: 100 }),
    ];
    const result = summarizeDeribitOptions("BTC", rows, NOW)!;
    expect(result.expiry).toBe("2026-09-01");
  });

  describe("put/call ratio", () => {
    it("computes put OI over call OI for the picked expiry only", () => {
      const rows = [
        row({ instrumentName: "BTC-1SEP26-60000-C", openInterest: 100 }),
        row({ instrumentName: "BTC-1SEP26-60000-P", openInterest: 300 }),
      ];
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      expect(result.putCallRatio).toBeCloseTo(3, 6);
    });

    it("returns Infinity rather than dividing by zero when there's no call OI at all", () => {
      const rows = [row({ instrumentName: "BTC-1SEP26-60000-P", openInterest: 300 })];
      // Below the 50-contract bar on its own — pair with a throwaway high-OI
      // call at a different strike, same expiry, to clear the bar without
      // affecting the put/call ratio's call side.
      rows.push(row({ instrumentName: "BTC-1SEP26-70000-P", openInterest: 300 }));
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      expect(result.putCallRatio).toBe(Infinity);
    });
  });

  describe("max pain", () => {
    it("picks the strike where option writers collectively pay out the least (hand-verified)", () => {
      // Calls:  100->100, 110->50, 120->0
      // Puts:   100->0,   110->50, 120->100
      // (scaled 10x from the hand-worked 10/5/0 example so total OI clears
      // the 50-contract minimum — scaling every leg by the same constant
      // doesn't change which strike minimizes payout)
      // Payout at 100 = 2500, at 110 = 2000, at 120 = 2500 -> max pain 110.
      const rows = [
        row({ instrumentName: "BTC-1SEP26-100-C", openInterest: 100 }),
        row({ instrumentName: "BTC-1SEP26-110-C", openInterest: 50 }),
        row({ instrumentName: "BTC-1SEP26-120-C", openInterest: 0 }),
        row({ instrumentName: "BTC-1SEP26-100-P", openInterest: 0 }),
        row({ instrumentName: "BTC-1SEP26-110-P", openInterest: 50 }),
        row({ instrumentName: "BTC-1SEP26-120-P", openInterest: 100 }),
      ];
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      expect(result.maxPain).toBe(110);
    });
  });

  describe("ATM IV", () => {
    it("uses the mark IV of the strike closest to the underlying price", () => {
      const rows = [
        row({ instrumentName: "BTC-1SEP26-60000-C", openInterest: 60, underlyingPrice: 64_800, markIv: 55 }),
        row({ instrumentName: "BTC-1SEP26-65000-C", openInterest: 60, underlyingPrice: 64_800, markIv: 60 }),
        row({ instrumentName: "BTC-1SEP26-70000-C", openInterest: 60, underlyingPrice: 64_800, markIv: 65 }),
      ];
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      // 65000 is closest to the 64,800 underlying price.
      expect(result.atmIvPct).toBe(60);
    });

    it("is null when no row in the picked expiry has a positive mark IV", () => {
      const rows = [
        row({ instrumentName: "BTC-1SEP26-60000-C", openInterest: 60, markIv: 0 }),
        row({ instrumentName: "BTC-1SEP26-60000-P", openInterest: 60, markIv: 0 }),
      ];
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      expect(result.atmIvPct).toBeNull();
    });
  });

  describe("open interest totals", () => {
    it("sums open interest across EVERY expiry, not just the picked one", () => {
      const rows = [
        row({ instrumentName: "BTC-1SEP26-60000-C", openInterest: 100 }),
        row({ instrumentName: "BTC-1SEP26-60000-P", openInterest: 100 }),
        // A second, later expiry that also has real OI — should still count
        // toward the total even though max pain/ratio are only computed
        // for the nearest (picked) expiry.
        row({ instrumentName: "BTC-1OCT26-60000-C", openInterest: 50 }),
      ];
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      expect(result.totalOpenInterestContracts).toBe(250);
    });

    it("converts total contracts to USD using the picked expiry's underlying price", () => {
      const rows = [
        row({ instrumentName: "BTC-1SEP26-60000-C", openInterest: 100, underlyingPrice: 65_000 }),
        row({ instrumentName: "BTC-1SEP26-60000-P", openInterest: 100, underlyingPrice: 65_000 }),
      ];
      const result = summarizeDeribitOptions("BTC", rows, NOW)!;
      expect(result.totalOpenInterestUsd).toBe(200 * 65_000);
    });
  });

  it("passes through asset and updatedAt unchanged", () => {
    const rows = [
      row({ instrumentName: "ETH-1SEP26-3000-C", openInterest: 100 }),
      row({ instrumentName: "ETH-1SEP26-3000-P", openInterest: 100 }),
    ];
    const result = summarizeDeribitOptions("ETH", rows, NOW)!;
    expect(result.asset).toBe("ETH");
    expect(result.updatedAt).toBe(NOW);
  });
});
