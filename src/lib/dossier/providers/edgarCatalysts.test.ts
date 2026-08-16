import { describe, expect, it } from "vitest";
import {
  CatalystFiling,
  RecentFilings,
  filterCatalysts,
  isRelevantFiling,
  parseItems,
  priorCloseEt,
} from "./edgarCatalysts";

/**
 * Instants are hand-checked against a calendar. 2026-08-14 is a Friday in
 * EDT (16:00 ET = 20:00 UTC); 2026-01-14 is a Wednesday in EST (16:00 ET =
 * 21:00 UTC). The DST split is the entire reason these tests exist — a
 * hardcoded 20:00 UTC would be silently wrong for four months a year.
 */
describe("priorCloseEt", () => {
  it("returns Friday's close on a weekend", () => {
    // Sunday 2026-08-16 03:00 UTC -> Friday 2026-08-14 20:00 UTC.
    const sunday = Date.UTC(2026, 7, 16, 3);
    expect(priorCloseEt(sunday)).toBe(Date.UTC(2026, 7, 14, 20));
  });

  it("returns yesterday's close during a session", () => {
    // Friday 15:50 ET = 19:50 UTC -> Thursday 2026-08-13 20:00 UTC.
    const midSession = Date.UTC(2026, 7, 14, 19, 50);
    expect(priorCloseEt(midSession)).toBe(Date.UTC(2026, 7, 13, 20));
  });

  it("rolls to today's close the moment it has happened", () => {
    // Friday 16:30 ET = 20:30 UTC -> Friday's own 20:00 UTC close.
    const afterHours = Date.UTC(2026, 7, 14, 20, 30);
    expect(priorCloseEt(afterHours)).toBe(Date.UTC(2026, 7, 14, 20));
  });

  it("uses 21:00 UTC under standard time", () => {
    // Wednesday 2026-01-14 17:00 EST = 22:00 UTC -> same day 21:00 UTC.
    const winter = Date.UTC(2026, 0, 14, 22);
    expect(priorCloseEt(winter)).toBe(Date.UTC(2026, 0, 14, 21));
  });

  it("is strictly BEFORE now, never equal", () => {
    // Exactly at the close, the prior close is the previous session's.
    const atClose = Date.UTC(2026, 7, 14, 20);
    expect(priorCloseEt(atClose)).toBe(Date.UTC(2026, 7, 13, 20));
  });
});

describe("parseItems", () => {
  it("splits EDGAR's comma-separated items and trims", () => {
    expect(parseItems("2.02,9.01")).toEqual(["2.02", "9.01"]);
    expect(parseItems(" 1.01 , 8.01 ")).toEqual(["1.01", "8.01"]);
  });

  it("returns empty for the blank string non-8-K forms carry", () => {
    expect(parseItems("")).toEqual([]);
  });
});

describe("isRelevantFiling — a declared, closed list", () => {
  it("accepts an 8-K only when it carries a declared item", () => {
    expect(isRelevantFiling("8-K", ["2.02", "9.01"])).toBe(true);
    expect(isRelevantFiling("8-K", ["1.01"])).toBe(true);
    // A bare 9.01 is exhibits — packaging, not news.
    expect(isRelevantFiling("8-K", ["9.01"])).toBe(false);
    expect(isRelevantFiling("8-K", [])).toBe(false);
  });

  it("treats every 424B suffix as the same event: dilution landing", () => {
    for (const f of ["424B2", "424B3", "424B5"]) expect(isRelevantFiling(f, [])).toBe(true);
  });

  it("accepts S-3ASR and amendments to 8-Ks", () => {
    expect(isRelevantFiling("S-3ASR", [])).toBe(true);
    expect(isRelevantFiling("8-K/A", ["2.02"])).toBe(true);
  });

  /*
   * The closed list IS the design. Form 4s, 10-Qs and S-8s move nothing
   * after hours on this cohort, and an open-ended "looks important" filter
   * would be a sentiment model wearing a compliance costume.
   */
  it("rejects everything not declared", () => {
    for (const f of ["4", "10-Q", "10-K", "S-8", "SC 13G", "144"]) {
      expect(isRelevantFiling(f, [])).toBe(false);
    }
  });
});

describe("filterCatalysts", () => {
  const NOW = Date.UTC(2026, 7, 16, 3); // Sunday morning UTC
  const WINDOW = Date.UTC(2026, 7, 14, 20); // Friday's close

  const feed = (rows: Array<[string, string, string, string]>): RecentFilings => ({
    accessionNumber: rows.map((r) => r[0]),
    form: rows.map((r) => r[1]),
    acceptanceDateTime: rows.map((r) => r[2]),
    items: rows.map((r) => r[3]),
  });

  it("keeps only relevant filings accepted inside the window", () => {
    const out = filterCatalysts(
      feed([
        // After Friday's close: the 8-K counts, the Form 4 never does.
        ["acc-1", "8-K", "2026-08-14T21:05:00.000Z", "2.02,9.01"],
        ["acc-2", "4", "2026-08-14T21:10:00.000Z", ""],
        // Before the close: out of window even though relevant.
        ["acc-3", "424B5", "2026-08-14T14:00:00.000Z", ""],
      ]),
      WINDOW,
      NOW
    );
    expect(out.map((f: CatalystFiling) => f.accession)).toEqual(["acc-1"]);
    expect(out[0].items).toEqual(["2.02", "9.01"]);
    expect(out[0].filed_at).toBe("2026-08-14T21:05:00.000Z");
  });

  it("excludes an instant exactly AT the close — the close print is tape, not news after it", () => {
    const out = filterCatalysts(
      feed([["acc-1", "8-K", new Date(WINDOW).toISOString(), "2.02"]]),
      WINDOW,
      NOW
    );
    expect(out).toHaveLength(0);
  });

  it("ignores rows dated in the future or unparseable", () => {
    const out = filterCatalysts(
      feed([
        ["acc-1", "8-K", "2026-08-16T09:00:00.000Z", "2.02"], // after NOW
        ["acc-2", "8-K", "not-a-date", "2.02"],
      ]),
      WINDOW,
      NOW
    );
    expect(out).toHaveLength(0);
  });

  it("returns newest first", () => {
    const out = filterCatalysts(
      feed([
        ["old", "424B5", "2026-08-14T21:00:00.000Z", ""],
        ["new", "8-K", "2026-08-15T01:00:00.000Z", "8.01"],
      ]),
      WINDOW,
      NOW
    );
    expect(out.map((f) => f.accession)).toEqual(["new", "old"]);
  });

  it("survives ragged parallel arrays rather than reading past an end", () => {
    const ragged: RecentFilings = {
      accessionNumber: ["a", "b"],
      form: ["8-K"],
      acceptanceDateTime: ["2026-08-14T21:00:00.000Z"],
      items: ["2.02"],
    };
    expect(filterCatalysts(ragged, WINDOW, NOW)).toHaveLength(1);
  });
});
