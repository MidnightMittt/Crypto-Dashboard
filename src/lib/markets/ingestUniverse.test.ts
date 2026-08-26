import { describe, expect, it } from "vitest";
import { barFileName, panelSymbolOfFile, refreshPanelSymbols, refreshUniverse } from "./ingestUniverse";
import { EQUITY_PANEL, isClassified, unclassified } from "./equityPanel";

/**
 * THE CHECK THE CRON USED TO BE THE ONLY PLACE FOR.
 *
 * `loadEquityPanel` throws on an unclassified instrument, and that throw is
 * right: both defaults are wrong in ways that hide. But it ran in exactly one
 * place — inside the nightly job, at 22:15 UTC — so the feedback loop between
 * "add an instrument to the refresh" and "learn you had to classify it" was a
 * failed workflow run, hours later, that nobody was watching.
 *
 * IBIT was added on 2026-08-21 and cost three consecutive sessions of
 * `daily-intelligence` (2026-08-24, 08-25, 08-26). The job died at step 10 of
 * 15, before "Register and score forward predictions" — so the loss was not a
 * stale snapshot, which the next run repairs, but three sessions of forward
 * predictions that were never registered and cannot be backfilled.
 *
 * These tests run the identical check against the DECLARED universe rather
 * than a directory listing, which means they hold on a machine that has never
 * run the ingest — including CI.
 */

describe("the daily refresh universe", () => {
  /*
   * THE LOAD-BEARING ONE. If this fails, the nightly job is already broken on
   * the next scheduled run, and the fix is to classify the named instrument in
   * equityPanel.ts — not to relax this assertion.
   */
  it("presents no unclassified instrument to the panel loader", () => {
    const unknown = unclassified(refreshPanelSymbols({ onlyUs: true }));
    expect(
      unknown,
      `${unknown.join(", ")} would throw in loadEquityPanel and fail daily-intelligence ` +
        `at "Rebuild equity cross-section panel". Classify each in equityPanel.ts.`
    ).toEqual([]);
  });

  /*
   * The full run is what research work uses, and it refuses on the FX pairs by
   * design — but classification is orthogonal to validation, so an unclassified
   * name here is the same defect arriving through a different door.
   */
  it("presents no unclassified instrument in the full-run scope either", () => {
    expect(unclassified(refreshPanelSymbols({ onlyUs: false }))).toEqual([]);
  });

  /*
   * The daily scope is a SUBSET of the full run, and the panel must survive the
   * narrowing. A declared panel member that only the full run fetches would
   * leave the cross-section silently short a name every weekday — the
   * shrinking-panel failure loadPanel's `missing` list exists to surface,
   * arriving before the loader can see it.
   */
  it("keeps every declared panel member inside the daily scope", () => {
    const daily = new Set(refreshPanelSymbols({ onlyUs: true }));
    const absent = EQUITY_PANEL.filter((s) => !daily.has(s));
    expect(absent, `${absent.join(", ")} are declared panel members the daily job never fetches`).toEqual([]);
  });

  it("round-trips an instrument id through its bar file name", () => {
    for (const id of ["NVDA.US", "BTC-USD.SPOT", "IBIT.US"]) {
      expect(barFileName(id)).toBe(`${id}.json`);
    }
    // The venue suffix is dropped and the hyphenated pair survives, because
    // the classification lists are keyed on the bare symbol.
    expect(panelSymbolOfFile("NVDA.US.json")).toBe("NVDA");
    expect(panelSymbolOfFile("BTC-USD.SPOT.json")).toBe("BTC-USD");
  });

  it("narrows rather than grows when scoped to the daily job", () => {
    const daily = refreshUniverse({ onlyUs: true }).configs.length;
    const full = refreshUniverse({ onlyUs: false }).configs.length;
    expect(daily).toBeGreaterThan(0);
    expect(daily).toBeLessThanOrEqual(full);
  });

  it("honours a targeted re-fetch without changing what the names classify as", () => {
    const { configs } = refreshUniverse({ onlyUs: true, wanted: new Set(["NVDA"]) });
    expect(configs.map((c) => c.meta.displaySymbol ?? c.meta.id)).toEqual(["NVDA"]);
  });

  /*
   * IBIT by name. The general assertion above would catch its removal from the
   * classification lists, but not a "cleanup" that drops it from the refresh
   * entirely — which would take the unlevered benchmark off the site while
   * every test still passed.
   */
  it("still fetches IBIT, the unlevered benchmark, and classifies it as a fund", () => {
    expect(refreshPanelSymbols({ onlyUs: true })).toContain("IBIT");
    expect(isClassified("IBIT")).toBe(true);
    expect(EQUITY_PANEL).not.toContain("IBIT");
  });
});
