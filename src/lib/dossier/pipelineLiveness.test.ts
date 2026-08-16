import { describe, expect, it } from "vitest";
import {
  StoreInput,
  assessLiveness,
  describeLiveness,
  weekdaysBetween,
} from "./pipelineLiveness";

/**
 * Dates are hand-checked against a calendar. 2026-08-14 is a Friday,
 * 2026-08-15/16 the weekend, 2026-08-17 the Monday.
 */
describe("weekdaysBetween — conservative by design", () => {
  it("counts nothing across a weekend", () => {
    // Friday to Sunday: no session has closed in between.
    expect(weekdaysBetween("2026-08-14", "2026-08-16")).toBe(0);
  });

  /*
   * THE RULE THAT STOPS FALSE ALARMS. Friday's data read on Monday is not
   * late: Monday's close has not happened, so a job that runs after it
   * cannot have missed anything yet. A staleness warning that fires every
   * Monday morning trains the reader to ignore it.
   */
  it("does not call Friday's data late on Monday", () => {
    expect(weekdaysBetween("2026-08-14", "2026-08-17")).toBe(0);
  });

  it("counts Monday as missed once Tuesday arrives", () => {
    expect(weekdaysBetween("2026-08-14", "2026-08-18")).toBe(1);
  });

  it("counts a full week of silence", () => {
    // Fri 14th -> Fri 21st: Mon, Tue, Wed, Thu missed.
    expect(weekdaysBetween("2026-08-14", "2026-08-21")).toBe(4);
  });

  it("returns zero rather than a negative for out-of-order dates", () => {
    expect(weekdaysBetween("2026-08-21", "2026-08-14")).toBe(0);
    expect(weekdaysBetween("2026-08-14", "2026-08-14")).toBe(0);
  });

  it("returns zero for unparseable input instead of NaN", () => {
    expect(weekdaysBetween("not-a-date", "2026-08-14")).toBe(0);
  });
});

describe("assessLiveness", () => {
  const stores = (lastUpdates: (string | null)[]): StoreInput[] =>
    lastUpdates.map((lastUpdate, i) => ({
      store: `store-${i}.json`,
      what: `feed ${i}`,
      lastUpdate,
    }));

  it("calls everything current when nothing has been missed", () => {
    const r = assessLiveness(stores(["2026-08-14", "2026-08-14"]), "2026-08-17");
    expect(r.degraded).toBe(0);
    expect(r.worstSessionsBehind).toBe(0);
    expect(r.stores.every((s) => s.status === "current")).toBe(true);
  });

  it("escalates late then stale as sessions accumulate", () => {
    // 2 missed -> late; 5 missed -> stale.
    const late = assessLiveness(stores(["2026-08-14"]), "2026-08-19");
    expect(late.stores[0].sessionsBehind).toBe(2);
    expect(late.stores[0].status).toBe("late");

    const stale = assessLiveness(stores(["2026-08-14"]), "2026-08-24");
    expect(stale.stores[0].sessionsBehind).toBe(5);
    expect(stale.stores[0].status).toBe("stale");
  });

  /*
   * "Never written" is not "zero sessions behind". A store that has never
   * been appended to is a different failure from one that is up to date, and
   * a 0 would render as healthy.
   */
  it("distinguishes never-written from current", () => {
    const r = assessLiveness(stores([null, "2026-08-14"]), "2026-08-17");
    expect(r.stores[0].status).toBe("never");
    expect(r.stores[0].sessionsBehind).toBeNull();
    expect(r.degraded).toBe(1);
    // The never-written store must not drag the worst-lag number to null.
    expect(r.worstSessionsBehind).toBe(0);
  });

  it("reports the worst store, not the average", () => {
    // Fri 14th -> Mon 24th spans Mon-Fri 17-21 only; the 22nd/23rd are a
    // weekend, so five sessions were missed, not six. The second store is
    // current, and the pair must report 5 rather than an average of 2.5.
    const r = assessLiveness(stores(["2026-08-14", "2026-08-24"]), "2026-08-24");
    expect(r.worstSessionsBehind).toBe(5);
  });
});

describe("describeLiveness", () => {
  it("never claims more than that the stores are current", () => {
    const r = assessLiveness(
      [{ store: "a.json", what: "the signal ledger", lastUpdate: "2026-08-14" }],
      "2026-08-17"
    );
    const line = describeLiveness(r);
    expect(line).toContain("current");
    // No forward-looking claim: "operational" would be a promise about later.
    expect(line.toLowerCase()).not.toContain("operational");
  });

  it("names which store is behind, and by how much", () => {
    const r = assessLiveness(
      [
        { store: "a.json", what: "the signal ledger", lastUpdate: "2026-08-14" },
        { store: "b.json", what: "positioning", lastUpdate: "2026-08-14" },
      ],
      "2026-08-24"
    );
    const line = describeLiveness(r);
    expect(line).toContain("the signal ledger");
    expect(line).toContain("positioning");
    expect(line).toContain("2 of 2");
  });

  it("says so plainly when nothing has ever been written", () => {
    const r = assessLiveness([{ store: "a.json", what: "the ledger", lastUpdate: null }], "2026-08-17");
    expect(describeLiveness(r)).toContain("has ever been written");
  });
});
