import { describe, expect, it } from "vitest";
import { appendEntry, currentRun, episodesOf, emptyLedger, Ledger, LedgerEntry, guardEntry, diffEntries, latestDiff } from "./historyLedger";

/**
 * The ledger is the substrate for every future "risk-off for N days, Kth
 * episode" claim, so the duration arithmetic is pinned to hand-countable
 * cases. A double-counted re-run or an off-by-one here becomes a wrong
 * number a trader sizes with.
 */

function entry(date: string, regime: string | null): LedgerEntry {
  return {
    date,
    regime: regime ? { regime, agreeing: 2, total: 3 } : null,
    rotation: [],
    dispersionPct: null,
    industries: [],
    equity: [],
  };
}

function ledgerOf(...pairs: Array<[string, string | null]>): Ledger {
  return pairs.reduce((l, [d, r]) => appendEntry(l, entry(d, r)), emptyLedger());
}

const readRegime = (e: LedgerEntry) => e.regime?.regime ?? null;

describe("appendEntry", () => {
  it("replaces a same-date entry rather than duplicating — re-runs must converge", () => {
    let l = ledgerOf(["2026-08-13", "risk-on"]);
    l = appendEntry(l, entry("2026-08-13", "risk-off"));
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0].regime?.regime).toBe("risk-off");
  });

  it("keeps entries sorted by date regardless of append order", () => {
    const l = ledgerOf(["2026-08-13", "risk-on"], ["2026-08-11", "risk-on"], ["2026-08-12", "risk-off"]);
    expect(l.entries.map((e) => e.date)).toEqual(["2026-08-11", "2026-08-12", "2026-08-13"]);
  });
});

describe("currentRun", () => {
  it("counts the trailing run and names the date it started", () => {
    const l = ledgerOf(
      ["2026-08-08", "risk-on"],
      ["2026-08-11", "risk-off"],
      ["2026-08-12", "risk-off"],
      ["2026-08-13", "risk-off"]
    );
    expect(currentRun(l, readRegime)).toEqual({ value: "risk-off", days: 3, since: "2026-08-11" });
  });

  it("a run of one is one day, since today", () => {
    const l = ledgerOf(["2026-08-12", "risk-on"], ["2026-08-13", "risk-off"]);
    expect(currentRun(l, readRegime)).toEqual({ value: "risk-off", days: 1, since: "2026-08-13" });
  });

  it("returns null for an empty ledger or a null latest value — unknown is not zero days", () => {
    expect(currentRun(emptyLedger(), readRegime)).toBeNull();
    expect(currentRun(ledgerOf(["2026-08-13", null]), readRegime)).toBeNull();
  });
});

describe("episodesOf", () => {
  it("segments history into runs, skipping null readings without breaking a run", () => {
    const l = ledgerOf(
      ["2026-08-06", "risk-on"],
      ["2026-08-07", "risk-on"],
      ["2026-08-08", null], // outage day: no reading, not a regime change
      ["2026-08-11", "risk-on"],
      ["2026-08-12", "risk-off"],
      ["2026-08-13", "risk-off"]
    );
    expect(episodesOf(l, readRegime)).toEqual([
      { value: "risk-on", start: "2026-08-06", end: "2026-08-11", days: 3 },
      { value: "risk-off", start: "2026-08-12", end: "2026-08-13", days: 2 },
    ]);
  });
});

describe("guardEntry — the pipeline noticing that it stopped", () => {
  const DAY = 86_400_000;
  const at = (d: string) => Date.parse(`${d}T21:00:00Z`);

  const entry = (date: string): LedgerEntry => ({
    date,
    regime: { regime: "risk-on", agreeing: 3, total: 3 },
    rotation: [],
    dispersionPct: null,
    industries: [],
    equity: [],
  });

  const ledgerOf = (...dates: string[]): Ledger => ({ entries: dates.map(entry) });

  it("appends a fresh session onto an existing ledger", () => {
    const g = guardEntry(ledgerOf("2026-08-12"), entry("2026-08-13"), at("2026-08-13"), at("2026-08-13") + 3600_000);
    expect(g).toEqual({ ok: true, kind: "appended" });
  });

  it("allows a same-day re-run and labels it as one", () => {
    const g = guardEntry(ledgerOf("2026-08-12", "2026-08-13"), entry("2026-08-13"), at("2026-08-13"), at("2026-08-13") + 3600_000);
    expect(g).toEqual({ ok: true, kind: "replaced" });
  });

  it("accepts the first entry into an empty ledger", () => {
    const g = guardEntry({ entries: [] }, entry("2026-08-13"), at("2026-08-13"), at("2026-08-13"));
    expect(g).toEqual({ ok: true, kind: "appended" });
  });

  /*
   * THE CASE THAT ACTUALLY HAPPENED. The pipeline kept rebuilding outputs
   * from bars that never advanced; the append was idempotent, the file did
   * not change, and the commit step reported "nothing to deploy" and exited
   * 0. Three days of silence. The data's own age is the only signal that
   * could have caught it, because every other one looked healthy.
   */
  it("refuses a snapshot whose data stopped advancing", () => {
    const g = guardEntry(ledgerOf("2026-08-12"), entry("2026-08-12"), at("2026-08-12"), at("2026-08-12") + 9 * DAY);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.reason).toMatch(/9 days old/);
  });

  it("tolerates a long weekend before it complains", () => {
    // Friday's close recorded on Monday: three days, inside the limit.
    const g = guardEntry(ledgerOf("2026-08-06"), entry("2026-08-07"), at("2026-08-07"), at("2026-08-07") + 3 * DAY);
    expect(g.ok).toBe(true);
  });

  /*
   * A provider serving older bars than the ones already recorded. Appending
   * would leave the ledger holding a date it has already moved past, and
   * every duration count reading backwards through it would be wrong.
   */
  it("refuses a snapshot that went backwards", () => {
    const g = guardEntry(ledgerOf("2026-08-12", "2026-08-13"), entry("2026-08-11"), at("2026-08-11"), at("2026-08-13"));
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.reason).toMatch(/BACKWARDS/);
  });
});

describe("diffEntries — what changed overnight", () => {
  const base = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    date: "2026-08-13",
    regime: { regime: "risk-on", agreeing: 3, total: 3 },
    rotation: [
      { symbol: "XLE", state: "leading", shortRelPct: 4.42 },
      { symbol: "XLK", state: "lagging", shortRelPct: -1.1 },
    ],
    dispersionPct: 2.1,
    industries: [{ slug: "gold-miners", state: "improving", shortRelPct: 1.2, breadthPct: 60 }],
    equity: [{ symbol: "SPY", verdict: "bullish", score: 70, confidence: 40 }],
    ...over,
  });

  it("reports a regime flip", () => {
    const d = diffEntries(base(), base({ regime: { regime: "risk-off", agreeing: 2, total: 3 } }));
    expect(d.changes).toContainEqual({
      kind: "regime",
      subject: "risk environment",
      from: "risk-on",
      to: "risk-off",
    });
  });

  /*
   * THE RULE THAT KEEPS THE FEED WORTH READING. Both sectors moved — XLE by
   * 9 basis points — and neither crossed anything. A feed that reports the
   * measurement breathing teaches the reader to ignore the feed.
   */
  it("ignores numeric drift that crosses no boundary", () => {
    const after = base({
      rotation: [
        { symbol: "XLE", state: "leading", shortRelPct: 4.51 },
        { symbol: "XLK", state: "lagging", shortRelPct: -1.4 },
      ],
      dispersionPct: 2.9,
    });
    expect(diffEntries(base(), after).changes).toEqual([]);
  });

  it("reports a rotation state crossing", () => {
    const after = base({
      rotation: [
        { symbol: "XLE", state: "lagging", shortRelPct: -0.2 },
        { symbol: "XLK", state: "lagging", shortRelPct: -1.1 },
      ],
    });
    expect(diffEntries(base(), after).changes).toEqual([
      { kind: "rotation", subject: "XLE", from: "leading", to: "lagging" },
    ]);
  });

  it("reports industry and equity crossings under their own kinds", () => {
    const after = base({
      industries: [{ slug: "gold-miners", state: "leading", shortRelPct: 3.0, breadthPct: 80 }],
      equity: [{ symbol: "SPY", verdict: "neutral", score: 52, confidence: 30 }],
    });
    const kinds = diffEntries(base(), after).changes.map((c) => c.kind);
    expect(kinds).toEqual(["industry", "equity"]);
  });

  /*
   * "Nothing happened" and "we stopped looking" must not read alike. A
   * subject that appears or vanishes is a change in what the platform can
   * see, and silence about it would make the feed's silence ambiguous.
   */
  it("reports a subject appearing", () => {
    const after = base({
      rotation: [...base().rotation, { symbol: "XLV", state: "improving", shortRelPct: 0.8 }],
    });
    expect(diffEntries(base(), after).changes).toEqual([
      { kind: "rotation", subject: "XLV", from: null, to: "improving" },
    ]);
  });

  it("reports a subject disappearing", () => {
    const after = base({ rotation: [{ symbol: "XLE", state: "leading", shortRelPct: 4.42 }] });
    expect(diffEntries(base(), after).changes).toEqual([
      { kind: "rotation", subject: "XLK", from: "lagging", to: null },
    ]);
  });

  it("carries both dates so a reader knows what span this covers", () => {
    const d = diffEntries(base({ date: "2026-08-12" }), base());
    expect(d.from).toBe("2026-08-12");
    expect(d.to).toBe("2026-08-13");
  });

  it("returns no changes for an identical session rather than inventing one", () => {
    expect(diffEntries(base(), base()).changes).toEqual([]);
  });
});

describe("latestDiff", () => {
  const entry = (date: string, regime: string): LedgerEntry => ({
    date,
    regime: { regime, agreeing: 2, total: 3 },
    rotation: [],
    dispersionPct: null,
    industries: [],
    equity: [],
  });

  /*
   * A one-entry ledger cannot say what changed, and must not answer with an
   * empty feed — that reads as "a quiet session", which is the opposite
   * claim. Null is the difference between "nothing moved" and "we have no
   * yesterday to compare against".
   */
  it("returns null rather than an empty diff when there is no yesterday", () => {
    expect(latestDiff({ entries: [] })).toBeNull();
    expect(latestDiff({ entries: [entry("2026-08-12", "risk-on")] })).toBeNull();
  });

  it("compares the last two entries", () => {
    const d = latestDiff({
      entries: [
        entry("2026-08-11", "risk-off"),
        entry("2026-08-12", "risk-on"),
        entry("2026-08-13", "risk-off"),
      ],
    })!;
    expect(d.from).toBe("2026-08-12");
    expect(d.to).toBe("2026-08-13");
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].to).toBe("risk-off");
  });
});
