import { describe, expect, it } from "vitest";
import {
  EQUITY_PANEL,
  EXCLUDED_FUNDS,
  EXCLUDED_NON_EQUITY,
  isClassified,
  isPanelMember,
  unclassified,
} from "./equityPanel";

/**
 * The panel is a CLAIM, so it gets tests like any other claim.
 *
 * These do not check that the classifications are correct — no test can know
 * that TLT is a bond fund. They check the properties that would let a wrong
 * classification go unnoticed: overlap between the lists, duplicates within
 * one, and above all a new ingest silently joining or silently vanishing.
 */

describe("the declared equity panel", () => {
  it("has no duplicates in any list", () => {
    for (const [name, list] of [
      ["panel", EQUITY_PANEL],
      ["funds", EXCLUDED_FUNDS],
      ["non-equity", EXCLUDED_NON_EQUITY],
    ] as const) {
      expect(new Set(list).size, `${name} contains a duplicate`).toBe(list.length);
    }
  });

  it("keeps the three lists disjoint", () => {
    const panel = new Set(EQUITY_PANEL);
    for (const s of [...EXCLUDED_FUNDS, ...EXCLUDED_NON_EQUITY]) {
      expect(panel.has(s), `${s} is both a member and excluded`).toBe(false);
    }
    const funds = new Set(EXCLUDED_FUNDS);
    for (const s of EXCLUDED_NON_EQUITY) {
      expect(funds.has(s), `${s} is classified twice`).toBe(false);
    }
  });

  /*
   * The specific instruments whose presence produced the defect this file
   * exists to fix. Pinned individually so a well-meaning edit that "restores
   * the full universe" fails with a name attached rather than a count.
   */
  it("excludes the instruments that contaminated the original ranking", () => {
    for (const s of ["SPY", "QQQ", "TLT", "HYG", "GLD", "USO", "SMH", "WGMI", "XLK"]) {
      expect(isPanelMember(s), `${s} must not be a panel member`).toBe(false);
      expect(isClassified(s), `${s} must still be classified`).toBe(true);
    }
    for (const s of ["BTC-USD", "SOL-USD", "BNB-USD", "XRP-USD"]) {
      expect(isPanelMember(s), `${s} must not be a panel member`).toBe(false);
    }
  });

  it("includes operating companies, including US-listed foreign issuers", () => {
    for (const s of ["NVDA", "MU", "ASML", "TSM", "GOLD", "AU", "MARA", "HUT"]) {
      expect(isPanelMember(s), `${s} should be a panel member`).toBe(true);
    }
  });

  /*
   * THE LOAD-BEARING ONE. A symbol added to the daily refresh and classified
   * by nobody must be reported, because both defaults are wrong in ways that
   * hide — see the module header.
   */
  it("reports unclassified symbols rather than assuming a side", () => {
    expect(unclassified(["NVDA", "SPY", "BTC-USD"])).toEqual([]);
    expect(unclassified(["NVDA", "NEWCO", "AAA"])).toEqual(["AAA", "NEWCO"]);
  });

  it("is large enough for a decile to mean anything", () => {
    // A decile of fewer than 40 ranked names is not a decile.
    expect(EQUITY_PANEL.length).toBeGreaterThanOrEqual(60);
  });
});
