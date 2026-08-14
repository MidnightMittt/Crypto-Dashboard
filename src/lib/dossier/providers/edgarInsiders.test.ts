import { describe, expect, it } from "vitest";
import { aggregateInsiderActivity, parseForm4 } from "./edgarInsiders";

/** A minimal but structurally faithful ownershipDocument fragment. */
const form4 = (transactions: string) => `<?xml version="1.0"?>
<ownershipDocument>
  <nonDerivativeTable>${transactions}</nonDerivativeTable>
</ownershipDocument>`;

const txn = (code: string, shares: number, price: number | null, ad: "A" | "D" = code === "P" ? "A" : "D") => `
  <nonDerivativeTransaction>
    <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>${shares}</value></transactionShares>
      ${price !== null ? `<transactionPricePerShare><value>${price}</value></transactionPricePerShare>` : "<transactionPricePerShare></transactionPricePerShare>"}
      <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>
    </transactionAmounts>
  </nonDerivativeTransaction>`;

describe("parseForm4", () => {
  it("extracts code, shares, price and direction from each transaction block", () => {
    const parsed = parseForm4(form4(txn("P", 1000, 52.5) + txn("S", 400, 55)));
    expect(parsed).toEqual([
      { code: "P", shares: 1000, pricePerShare: 52.5, acquiredDisposed: "A" },
      { code: "S", shares: 400, pricePerShare: 55, acquiredDisposed: "D" },
    ]);
  });

  it("never bleeds values between transactions — each block is isolated first", () => {
    // The second transaction omits its price; a greedy scan across block
    // boundaries would steal the first transaction's price for it.
    const parsed = parseForm4(form4(txn("P", 100, 10) + txn("P", 200, null)));
    expect(parsed[0].pricePerShare).toBe(10);
    expect(parsed[1].pricePerShare).toBeNull();
  });

  it("keeps compensation codes in the raw parse — filtering is aggregation's job", () => {
    const parsed = parseForm4(form4(txn("M", 5000, 1.0, "A") + txn("F", 1200, 50, "D")));
    expect(parsed.map((t) => t.code)).toEqual(["M", "F"]);
  });

  it("drops malformed blocks rather than inventing numbers", () => {
    const broken = form4(`<nonDerivativeTransaction><transactionCode>P</transactionCode></nonDerivativeTransaction>`);
    expect(parseForm4(broken)).toEqual([]);
  });
});

describe("aggregateInsiderActivity", () => {
  const filing = (...t: Array<{ code: string; shares: number; pricePerShare: number | null }>) => ({
    transactions: t.map((x) => ({ ...x, acquiredDisposed: null })),
  });

  it("counts only open-market P and S — grants, exercises and withholding are mechanics", () => {
    const s = aggregateInsiderActivity(
      [
        filing(
          { code: "P", shares: 1000, pricePerShare: 50 },
          { code: "M", shares: 90_000, pricePerShare: 1 }, // option exercise: huge and meaningless
          { code: "F", shares: 4000, pricePerShare: 50 }, // tax withholding
          { code: "A", shares: 20_000, pricePerShare: null } // grant
        ),
      ],
      "2026-08-10"
    );
    expect(s.buys).toEqual({ transactions: 1, shares: 1000, valueUsd: 50_000 });
    expect(s.sells.transactions).toBe(0);
  });

  it("hand-verifies dollar totals across filings", () => {
    const s = aggregateInsiderActivity(
      [filing({ code: "P", shares: 1000, pricePerShare: 50 }), filing({ code: "P", shares: 500, pricePerShare: 60 })],
      "2026-08-01"
    );
    // 1000×50 + 500×60 = 80,000
    expect(s.buys.valueUsd).toBe(80_000);
    expect(s.buys.shares).toBe(1500);
  });

  it("refuses to quote a dollar figure when any counted transaction lacks a price", () => {
    // A partial sum would silently understate; null says "not fully priced".
    const s = aggregateInsiderActivity(
      [filing({ code: "S", shares: 100, pricePerShare: 50 }, { code: "S", shares: 100, pricePerShare: null })],
      null
    );
    expect(s.sells.transactions).toBe(2);
    expect(s.sells.valueUsd).toBeNull();
  });

  it("an empty window is a finding, not an error", () => {
    const s = aggregateInsiderActivity([], null);
    expect(s.buys.transactions).toBe(0);
    expect(s.sells.transactions).toBe(0);
    expect(s.filingsExamined).toBe(0);
  });

  it("carries the buy/sell asymmetry note in the data itself", () => {
    expect(aggregateInsiderActivity([], null).asymmetryNote).toContain("essentially one explanation");
  });
});
