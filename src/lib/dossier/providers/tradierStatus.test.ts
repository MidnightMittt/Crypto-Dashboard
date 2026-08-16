import { describe, expect, it } from "vitest";
import {
  RawClock,
  etInstantOnDate,
  resolveNextChange,
  toVenueQuote,
} from "./tradierStatus";

/**
 * Instants are hand-checked against a calendar. In 2026 daylight time runs
 * 08 March to 01 November, so August is EDT (UTC−4) and January is EST
 * (UTC−5). The transitions are tested directly, because a hardcoded offset
 * would be silently wrong for a third of the year and catastrophically wrong
 * for one hour twice a year.
 */
describe("etInstantOnDate", () => {
  it("resolves a summer time under daylight saving", () => {
    expect(etInstantOnDate("2026-08-14", "16:00")).toBe(Date.UTC(2026, 7, 14, 20));
    expect(etInstantOnDate("2026-08-16", "07:00")).toBe(Date.UTC(2026, 7, 16, 11));
  });

  it("resolves a winter time under standard time", () => {
    expect(etInstantOnDate("2026-01-14", "16:00")).toBe(Date.UTC(2026, 0, 14, 21));
    expect(etInstantOnDate("2026-01-14", "09:30")).toBe(Date.UTC(2026, 0, 14, 14, 30));
  });

  /* 02:30 on the spring-forward date is a wall-clock time that never occurs. */
  it("returns null for a time inside the spring-forward gap", () => {
    expect(etInstantOnDate("2026-03-08", "02:30")).toBeNull();
  });

  /*
   * 01:30 on the fall-back date happens TWICE. The daylight candidate is
   * tried first, so the earlier of the two wins — pinned here so the choice
   * is a decision rather than an accident of loop order.
   */
  it("returns the earlier instant for an ambiguous fall-back time", () => {
    expect(etInstantOnDate("2026-11-01", "01:30")).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("returns null for malformed input rather than an epoch date", () => {
    expect(etInstantOnDate("not-a-date", "16:00")).toBeNull();
    expect(etInstantOnDate("2026-08-14", "")).toBeNull();
  });
});

describe("resolveNextChange — an instant only when it is one", () => {
  const clock = (over: Partial<RawClock> = {}): RawClock => ({
    date: "2026-08-14",
    state: "open",
    description: "Market is open from 09:30 to 16:00",
    timestamp: Date.UTC(2026, 7, 14, 19, 50) / 1000,
    next_change: "16:00",
    next_state: "postmarket",
    ...over,
  });

  it("resolves the close during an open session — the case that matters", () => {
    expect(resolveNextChange(clock())).toEqual({
      iso: "2026-08-14T20:00:00.000Z",
      reason: null,
    });
  });

  /*
   * Read live from the sandbox on Sunday 2026-08-16 21:00 UTC, the clock said
   * exactly this: closed, next change "07:00", next state premarket. That
   * 07:00 is MONDAY's. Pairing it with the clock's own date lands ten hours in
   * the past, so no instant is served.
   */
  it("refuses when next_change is not on the clock's own date", () => {
    const r = resolveNextChange(
      clock({
        date: "2026-08-16",
        state: "closed",
        timestamp: 1_786_914_023,
        next_change: "07:00",
        next_state: "premarket",
      })
    );
    expect(r.iso).toBeNull();
    expect(r.reason).toBe("next_change_not_on_clock_date");
  });

  it("refuses an unparseable time rather than guessing", () => {
    expect(resolveNextChange(clock({ next_change: "soon" })).reason).toBe(
      "next_change_time_unresolvable"
    );
  });
});

describe("toVenueQuote — the book, and how old it is", () => {
  /** APLD as the sandbox actually served it on 2026-08-16. */
  const APLD = {
    symbol: "APLD",
    bid: 31.19,
    ask: 31.2,
    bidsize: 100,
    asksize: 3200,
    bid_date: 1_786_751_690_000,
    ask_date: 1_786_751_684_000,
  };
  const SUNDAY = 1_786_914_023_000;

  it("prices the book off the mid, in basis points", () => {
    const r = toVenueQuote(APLD, SUNDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.book.spread_bp).toBeCloseTo(3.206, 3);
    expect(r.quote.book.bid_size).toBe(100);
    expect(r.quote.book.ask_size).toBe(3200);
  });

  /*
   * THE FIELD THAT STOPS THE BOOK FROM LYING. This one-tick book is 45 hours
   * old — Friday's post-market close, served unflagged on a Sunday. Sized
   * against as though it were live, a 3.2bp spread is a market that has not
   * existed in two days.
   */
  it("dates the book by its STALER side and reports the age", () => {
    const r = toVenueQuote(APLD, SUNDAY);
    if (!r.ok) throw new Error("expected a quote");
    // ask_date is 6s older than bid_date, so the ask dates the book.
    expect(r.quote.bookAsOf).toBe("2026-08-14T23:54:44.000Z");
    expect(r.quote.book.age_seconds).toBe(162_339);
    expect(r.quote.book.age_seconds / 3600).toBeCloseTo(45.1, 1);
  });

  it("never reports a negative age when the venue clock runs ahead", () => {
    const r = toVenueQuote({ ...APLD, bid_date: SUNDAY + 2_000, ask_date: SUNDAY + 2_000 }, SUNDAY);
    if (!r.ok) throw new Error("expected a quote");
    expect(r.quote.book.age_seconds).toBe(0);
  });

  /*
   * The refusal rules mirror spreadHistory.observe deliberately. A snapshot
   * admitted here that the recorder would have refused would put the live
   * spread and the measured median on different samples.
   */
  it("refuses a crossed book rather than serving a negative spread", () => {
    const r = toVenueQuote({ ...APLD, bid: 31.25, ask: 31.2 }, SUNDAY);
    expect(r).toEqual({ ok: false, reason: "crossed_book" });
  });

  it("distinguishes a one-sided book from a missing quote", () => {
    expect(toVenueQuote({ ...APLD, ask: 0 }, SUNDAY)).toEqual({
      ok: false,
      reason: "one_sided_book",
    });
    expect(toVenueQuote({ symbol: "APLD" }, SUNDAY)).toEqual({
      ok: false,
      reason: "no_quote_sides",
    });
  });

  /* An undated book cannot be aged, and an unaged book must not be trusted. */
  it("refuses a book with no timestamp on either side", () => {
    expect(toVenueQuote({ ...APLD, bid_date: null, ask_date: null }, SUNDAY)).toEqual({
      ok: false,
      reason: "quote_undated",
    });
  });
});
