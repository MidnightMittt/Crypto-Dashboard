import { describe, expect, it } from "vitest";
import {
  EQUITY_PANEL,
  EXCLUDED_FUNDS,
  EXCLUDED_NON_EQUITY,
  TRACKED_OUTSIDE_PANEL,
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
      ["tracked-outside-panel", TRACKED_OUTSIDE_PANEL],
    ] as const) {
      expect(new Set(list).size, `${name} contains a duplicate`).toBe(list.length);
    }
  });

  it("keeps the four lists disjoint", () => {
    const lists = [
      ["panel", EQUITY_PANEL],
      ["funds", EXCLUDED_FUNDS],
      ["non-equity", EXCLUDED_NON_EQUITY],
      ["tracked-outside-panel", TRACKED_OUTSIDE_PANEL],
    ] as const;
    for (let i = 0; i < lists.length; i++) {
      for (let j = i + 1; j < lists.length; j++) {
        const [aName, a] = lists[i];
        const [bName, b] = lists[j];
        const overlap = a.filter((s) => b.includes(s));
        expect(overlap, `${aName} and ${bName} both claim ${overlap.join(", ")}`).toEqual([]);
      }
    }
  });

  /*
   * The specific instruments whose presence produced the defect this file
   * exists to fix. Pinned individually so a well-meaning edit that "restores
   * the full universe" fails with a name attached rather than a count.
   */
  /*
   * These are the ONLY exclusions not justified by instrument kind — operating
   * companies held out to keep the panel's composition frozen while results
   * computed on it are published. That makes them the likeliest to be
   * "corrected" into the panel by someone reading the inclusion rule and
   * noticing they satisfy it. Doing so would move every decile boundary under
   * figures already on the site, so it must fail here first, by name.
   *
   * The list grew from 6 to 13 on 2026-08-21: the crypto-treasury cohort was
   * added because the book holds it and every dossier was blind to it. This
   * pin failing was the intended behaviour, not an obstacle — changing panel
   * composition is meant to be a deliberate act, and updating this assertion
   * is what makes it one.
   */
  it("keeps the tracked-outside-panel names classified but out of the ranking", () => {
    expect(TRACKED_OUTSIDE_PANEL.length).toBeGreaterThan(0);
    for (const s of TRACKED_OUTSIDE_PANEL) {
      expect(isPanelMember(s), `${s} must not rank inside the declared panel`).toBe(false);
      expect(isClassified(s), `${s} must be classified, or the nightly job fails`).toBe(true);
    }
    // The specific cohort, pinned by name rather than by count.
    expect([...TRACKED_OUTSIDE_PANEL].sort()).toEqual([
      // datacenter / mining
      "APLD", "CLSK", "CORZ", "IONQ", "OKLO", "RIOT",
      // crypto treasury / crypto financial
      "BMNR", "COIN", "GLXY", "HOOD", "MSTR", "PURR", "SBET",
    ].sort());
  });

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
