import { describe, expect, it } from "vitest";
import {
  MIN_SPREAD_SESSIONS,
  SpreadObservation,
  appendObservations,
  observe,
  pruneObservations,
  roundTripCostBp,
  summariseWindow,
} from "./spreadHistory";

/** A capture with a given bid/ask, dated onto a session. */
const obs = (
  session: string,
  bid: number,
  ask: number,
  over: Partial<SpreadObservation> = {}
): SpreadObservation => {
  const o = observe({
    t: new Date(`${session}T19:50:00Z`),
    session,
    symbol: "APLD",
    window: "entry",
    targetMinute: "15:50",
    bid,
    ask,
    last: (bid + ask) / 2,
  })!;
  return { ...o, ...over };
};

describe("observe — refusing rather than recording", () => {
  it("computes the spread in basis points off the mid", () => {
    // 31.19 / 31.20 -> spread 0.01, mid 31.195 -> 3.2056bp
    const o = obs("2026-08-14", 31.19, 31.2);
    expect(o.mid).toBeCloseTo(31.195, 10);
    expect(o.spreadBp).toBeCloseTo((0.01 / 31.195) * 10_000, 8);
  });

  /*
   * A crossed book is a stale or malformed quote, never a negative cost.
   * Recording one would pull a median BELOW what anyone can actually trade,
   * which is the direction that invents edge.
   */
  it("refuses a crossed book instead of recording a negative spread", () => {
    const crossed = observe({
      t: new Date(), session: "2026-08-14", symbol: "APLD", window: "entry",
      targetMinute: "15:50", bid: 31.2, ask: 31.19, last: 31.2,
    });
    expect(crossed).toBeNull();
  });

  it("refuses a missing or non-positive side", () => {
    const base = { t: new Date(), session: "2026-08-14", symbol: "APLD", window: "entry" as const, targetMinute: "15:50", last: 1 };
    expect(observe({ ...base, bid: null, ask: 31.2 })).toBeNull();
    expect(observe({ ...base, bid: 31.19, ask: undefined })).toBeNull();
    expect(observe({ ...base, bid: 0, ask: 31.2 })).toBeNull();
  });

  it("accepts a zero-width book — a locked market is real, not malformed", () => {
    const o = observe({
      t: new Date(), session: "2026-08-14", symbol: "APLD", window: "entry",
      targetMinute: "15:50", bid: 31.2, ask: 31.2, last: 31.2,
    })!;
    expect(o.spreadBp).toBe(0);
  });
});

describe("appendObservations", () => {
  it("is idempotent per symbol, session, window and minute", () => {
    const once = appendObservations([], [obs("2026-08-14", 31.19, 31.2)]);
    const twice = appendObservations(once, [obs("2026-08-14", 31.18, 31.22)]);
    expect(twice).toHaveLength(1);
    // A retry REPLACES rather than double-weighting the minute in the median.
    expect(twice[0].bid).toBe(31.18);
  });

  it("keeps distinct capture minutes apart", () => {
    const a = obs("2026-08-14", 31.19, 31.2, { targetMinute: "15:50" });
    const b = obs("2026-08-14", 31.19, 31.21, { targetMinute: "15:54" });
    expect(appendObservations([], [a, b])).toHaveLength(2);
  });

  it("keeps the two windows apart", () => {
    const entry = obs("2026-08-14", 31.19, 31.2);
    const exit = obs("2026-08-14", 31.1, 31.2, { window: "exit", targetMinute: "09:35" });
    expect(appendObservations([], [entry, exit])).toHaveLength(2);
  });
});

describe("summariseWindow — sessions, not captures", () => {
  /*
   * THE SAMPLE-SIZE TRAP. Three captures a session are the same book minutes
   * apart, not three independent observations. Counting them as such would
   * make a week of data look like three weeks and let the round-trip cost
   * clear its minimum three times too early.
   */
  it("counts SESSIONS as the sample and captures separately", () => {
    const rows = [
      obs("2026-08-12", 10, 10.01, { targetMinute: "15:50" }),
      obs("2026-08-12", 10, 10.01, { targetMinute: "15:54" }),
      obs("2026-08-12", 10, 10.01, { targetMinute: "15:58" }),
      obs("2026-08-13", 10, 10.01, { targetMinute: "15:50" }),
    ];
    const s = summariseWindow(rows, "APLD", "entry");
    expect(s.sessions).toBe(2);
    expect(s.observations).toBe(4);
  });

  /*
   * A session with more captures must not outvote one with fewer, so each
   * session contributes exactly one number to the median.
   */
  it("gives every session equal weight in the median", () => {
    const rows = [
      // Four wide captures on one session...
      ...["15:50", "15:54", "15:58", "15:59"].map((m) =>
        obs("2026-08-12", 10, 10.1, { targetMinute: m })
      ),
      // ...and one tight capture on each of two others.
      obs("2026-08-13", 10, 10.01, { targetMinute: "15:50" }),
      obs("2026-08-14", 10, 10.01, { targetMinute: "15:50" }),
    ];
    const s = summariseWindow(rows, "APLD", "entry");
    expect(s.sessions).toBe(3);
    // Median of [wide, tight, tight] is TIGHT. Capture-weighted it would be wide.
    expect(s.medianBp!).toBeCloseTo((0.01 / 10.005) * 10_000, 6);
  });

  it("reports the share of SESSIONS whose book was one tick wide", () => {
    const rows = [
      obs("2026-08-12", 10, 10.01), // one tick
      obs("2026-08-13", 10, 10.01), // one tick
      obs("2026-08-14", 10, 10.06), // six ticks
    ];
    const s = summariseWindow(rows, "APLD", "entry");
    expect(s.oneTickSessionShare).toBeCloseTo((2 / 3) * 100, 6);
  });

  it("returns nulls, not zeros, when a window has never been captured", () => {
    const s = summariseWindow([], "APLD", "entry");
    expect(s.sessions).toBe(0);
    expect(s.medianBp).toBeNull();
    expect(s.oneTickSessionShare).toBeNull();
  });

  it("keeps symbols and windows separate", () => {
    const rows = [
      obs("2026-08-12", 10, 10.01),
      obs("2026-08-12", 10, 10.5, { symbol: "RIOT" }),
      obs("2026-08-12", 10, 10.5, { window: "exit", targetMinute: "09:35" }),
    ];
    expect(summariseWindow(rows, "APLD", "entry").observations).toBe(1);
  });
});

describe("roundTripCostBp — null until measured, never modelled", () => {
  const sessions = (n: number, window: "entry" | "exit", bid: number, ask: number) =>
    Array.from({ length: n }, (_, i) =>
      obs(`2026-06-${String(i + 1).padStart(2, "0")}`, bid, ask, {
        window,
        targetMinute: window === "entry" ? "15:50" : "09:35",
      })
    );

  /*
   * THE FIELD THAT DECIDES A TRADE. Substituting a modelled spread here is
   * how a fictional edge gets published — Corwin-Schultz returns 114-177bp on
   * these names where the observed book is one tick, so a fallback would be
   * wrong by two orders of magnitude and confidently so.
   */
  it("refuses with a reason when neither window has enough sessions", () => {
    const c = roundTripCostBp([], "APLD");
    expect(c.bp).toBeNull();
    expect(c.reason).toBe("no_spread_history");
  });

  it("still refuses when only ONE leg has been measured", () => {
    const c = roundTripCostBp(sessions(MIN_SPREAD_SESSIONS, "entry", 10, 10.01), "APLD");
    expect(c.bp).toBeNull();
    expect(c.reason).toBe("no_spread_history");
    // The measured leg is still reported, so the wait is legible.
    expect(c.entry.sessions).toBe(MIN_SPREAD_SESSIONS);
    expect(c.exit.sessions).toBe(0);
  });

  it("sums both legs once both clear the minimum", () => {
    const rows = [
      ...sessions(MIN_SPREAD_SESSIONS, "entry", 10, 10.01),
      ...sessions(MIN_SPREAD_SESSIONS, "exit", 10, 10.02),
    ];
    const c = roundTripCostBp(rows, "APLD");
    expect(c.reason).toBeNull();
    const entryBp = (0.01 / 10.005) * 10_000;
    const exitBp = (0.02 / 10.01) * 10_000;
    expect(c.bp!).toBeCloseTo(entryBp + exitBp, 6);
  });

  it("does not let three capture minutes fake twenty sessions", () => {
    // 20 sessions' worth of CAPTURES, but only 7 distinct sessions.
    const rows = ["15:50", "15:54", "15:58"].flatMap((m) =>
      Array.from({ length: 7 }, (_, i) =>
        obs(`2026-06-0${i + 1}`, 10, 10.01, { targetMinute: m })
      )
    );
    expect(summariseWindow(rows, "APLD", "entry").observations).toBe(21);
    expect(roundTripCostBp(rows, "APLD").bp).toBeNull();
  });
});

describe("pruneObservations", () => {
  it("caps per symbol and drops the oldest first", () => {
    const rows = Array.from({ length: 6 }, (_, i) => obs(`2026-06-0${i + 1}`, 10, 10.01));
    const out = pruneObservations(rows, 2);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.session)).toEqual(["2026-06-05", "2026-06-06"]);
  });

  it("does not let one symbol evict another", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => obs(`2026-06-0${i + 1}`, 10, 10.01)),
      obs("2026-06-01", 10, 10.5, { symbol: "RIOT" }),
    ];
    const out = pruneObservations(rows, 2);
    expect(out.filter((o) => o.symbol === "RIOT")).toHaveLength(1);
    expect(out.filter((o) => o.symbol === "APLD")).toHaveLength(2);
  });
});
