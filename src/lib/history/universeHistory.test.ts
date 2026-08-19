import { describe, expect, it } from "vitest";
import {
  UniverseSnapshot,
  appendSnapshots,
  membershipChange,
  snapshot,
  snapshotAsOf,
} from "./universeHistory";

const row = (over: Partial<Parameters<typeof snapshot>[0]> = {}): UniverseSnapshot =>
  snapshot({
    date: "2026-08-18",
    panel: "equity_panel_v1",
    declared: ["MU", "INTC", "HUT"],
    ranked: ["MU", "INTC"],
    excluded: [{ symbol: "HUT", reason: "corrupt_bars" }],
    ...over,
  });

describe("building a snapshot", () => {
  /* A directory walk's order is not membership. Sorting makes a diff mean something. */
  it("sorts both lists so a day-to-day diff shows real change", () => {
    const s = snapshot({
      date: "2026-08-18",
      panel: "p",
      declared: ["MU", "AMD", "INTC"],
      ranked: ["INTC", "AMD"],
      excluded: [],
    });
    expect(s.declared).toEqual(["AMD", "INTC", "MU"]);
    expect(s.ranked).toEqual(["AMD", "INTC"]);
  });

  it("keeps every declared name accounted for, ranked or excluded", () => {
    const s = row();
    const accounted = new Set([...s.ranked, ...s.excluded.map((e) => e.symbol)]);
    for (const d of s.declared) expect(accounted.has(d), `${d} unaccounted`).toBe(true);
  });
});

describe("appendSnapshots", () => {
  it("is idempotent per date and panel, so a re-run cannot grow the file", () => {
    const once = appendSnapshots([], [row(), row()]);
    expect(once).toHaveLength(1);
    const again = appendSnapshots(once, [row({ ranked: ["MU"] })]);
    expect(again).toHaveLength(1);
    expect(again[0].ranked).toEqual(["MU"]);
  });

  /*
   * Two compositions on one date are two rows. This is what lets a versioned
   * second panel run beside the first without either overwriting the other —
   * the migration path the equity panel's own docs commit to.
   */
  it("keeps different panels on the same date side by side", () => {
    const both = appendSnapshots([], [row(), row({ panel: "equity_panel_v2" })]);
    expect(both).toHaveLength(2);
    expect(both.map((s) => s.panel)).toEqual(["equity_panel_v1", "equity_panel_v2"]);
  });

  it("keeps rows in date order however they arrive", () => {
    const out = appendSnapshots([], [row({ date: "2026-08-20" }), row({ date: "2026-08-18" })]);
    expect(out.map((s) => s.date)).toEqual(["2026-08-18", "2026-08-20"]);
  });
});

describe("snapshotAsOf — the survivorship-free lookup", () => {
  const history = [
    row({ date: "2026-08-10", declared: ["MU", "INTC"], ranked: ["MU", "INTC"], excluded: [] }),
    row({ date: "2026-08-18", declared: ["MU", "INTC", "HUT"], ranked: ["MU", "INTC", "HUT"], excluded: [] }),
  ];

  /*
   * THE WHOLE POINT. A replay of 2026-08-14 must not see HUT, which was added
   * to the panel on the 18th. Seeing it is precisely the look-ahead that makes
   * every cross-sectional result on a current instrument list suspect.
   */
  it("cannot see a name added after the date being replayed", () => {
    const at = snapshotAsOf(history, "2026-08-14", "equity_panel_v1")!;
    expect(at.date).toBe("2026-08-10");
    expect(at.declared).not.toContain("HUT");
  });

  it("uses the row for the date itself when one exists", () => {
    expect(snapshotAsOf(history, "2026-08-18", "equity_panel_v1")!.date).toBe("2026-08-18");
    expect(snapshotAsOf(history, "2026-08-18", "equity_panel_v1")!.declared).toContain("HUT");
  });

  /*
   * Before the record begins the answer is UNKNOWN, never today's list.
   * Substituting the current panel is the bias this file exists to remove, so
   * a caller has to handle the null rather than be handed a plausible lie.
   */
  it("returns null before the record starts rather than falling back to today", () => {
    expect(snapshotAsOf(history, "2026-07-01", "equity_panel_v1")).toBeNull();
  });

  it("never answers with another panel's membership", () => {
    expect(snapshotAsOf(history, "2026-08-18", "equity_panel_v2")).toBeNull();
  });
});

describe("membershipChange", () => {
  /*
   * A name leaving the PANEL is a decision; a name leaving the RANKING while
   * still declared is the data refusing it that day. Reporting them as one
   * number would make a single bad print look like a change of reference set.
   */
  it("separates a panel decision from a one-day data refusal", () => {
    const prev = row({ declared: ["MU", "INTC", "HUT"], ranked: ["MU", "INTC", "HUT"], excluded: [] });
    const next = row({
      date: "2026-08-19",
      declared: ["MU", "INTC", "HUT"],
      ranked: ["MU", "INTC"],
      excluded: [{ symbol: "HUT", reason: "corrupt_bars" }],
    });
    const c = membershipChange(prev, next);
    expect(c.droppedFromRanking).toEqual(["HUT"]);
    expect(c.removedFromPanel).toEqual([]);
  });

  it("reports a genuine panel addition", () => {
    const prev = row({ declared: ["MU"], ranked: ["MU"], excluded: [] });
    const next = row({ date: "2026-08-19", declared: ["MU", "AMD"], ranked: ["MU", "AMD"], excluded: [] });
    expect(membershipChange(prev, next).addedToPanel).toEqual(["AMD"]);
  });

  it("reports a name returning to the ranking after a refusal", () => {
    const prev = row({ declared: ["MU", "HUT"], ranked: ["MU"], excluded: [{ symbol: "HUT", reason: "corrupt_bars" }] });
    const next = row({ date: "2026-08-19", declared: ["MU", "HUT"], ranked: ["MU", "HUT"], excluded: [] });
    expect(membershipChange(prev, next).returnedToRanking).toEqual(["HUT"]);
  });

  it("is empty on an unchanged day, which is most days", () => {
    const c = membershipChange(row(), row({ date: "2026-08-19" }));
    expect(c).toEqual({
      addedToPanel: [],
      removedFromPanel: [],
      droppedFromRanking: [],
      returnedToRanking: [],
    });
  });
});
