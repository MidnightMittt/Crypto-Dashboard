import { describe, expect, it } from "vitest";
import {
  earningsVeto,
  earningsStatus,
  describeEarningsStatus,
  sessionsUntil,
  EarningsCalendar,
  MAX_CALENDAR_AGE_DAYS,
} from "./earningsVeto";

// 2026-08-13 is a Thursday (hand-checked against a calendar).
const THURSDAY = Date.parse("2026-08-13T14:30:00Z");

const calendar = (entries: EarningsCalendar["entries"]): EarningsCalendar => ({
  generatedAt: THURSDAY,
  entries,
});

describe("sessionsUntil", () => {
  it("counts trading sessions, hand-verified across a weekend", () => {
    expect(sessionsUntil(THURSDAY, "2026-08-13")).toBe(0); // today
    expect(sessionsUntil(THURSDAY, "2026-08-14")).toBe(1); // Friday
    expect(sessionsUntil(THURSDAY, "2026-08-15")).toBe(1); // Saturday counts no new session
    expect(sessionsUntil(THURSDAY, "2026-08-17")).toBe(2); // Monday
    expect(sessionsUntil(THURSDAY, "2026-08-19")).toBe(4); // Wednesday
  });

  it("returns null for past dates and garbage — the past cannot veto", () => {
    expect(sessionsUntil(THURSDAY, "2026-08-12")).toBeNull();
    expect(sessionsUntil(THURSDAY, "not-a-date")).toBeNull();
  });
});

describe("earningsVeto", () => {
  it("vetoes inside the window and cites the nearest date", () => {
    const result = earningsVeto(
      "HD",
      calendar([
        { symbol: "HD", date: "2026-08-18" }, // Tuesday, 3 sessions
        { symbol: "HD", date: "2026-11-17" },
      ]),
      THURSDAY
    );
    expect(result).toEqual({ date: "2026-08-18", sessions: 3 });
  });

  it("does not veto outside the window", () => {
    // Wednesday 2026-08-19 is 4 sessions away — one past the default 3.
    expect(earningsVeto("HD", calendar([{ symbol: "HD", date: "2026-08-19" }]), THURSDAY)).toBeNull();
  });

  it("never vetoes on missing calendars or unknown symbols — absence of evidence is not a veto", () => {
    expect(earningsVeto("HD", null, THURSDAY)).toBeNull();
    expect(earningsVeto("HD", calendar([]), THURSDAY)).toBeNull();
    expect(earningsVeto("HD", calendar([{ symbol: "LOW", date: "2026-08-14" }]), THURSDAY)).toBeNull();
  });

  it("ignores already-reported dates", () => {
    expect(earningsVeto("HD", calendar([{ symbol: "HD", date: "2026-08-11" }]), THURSDAY)).toBeNull();
  });
});

/**
 * THREE STATES, NEVER A BOOLEAN.
 *
 * `earningsVeto` returns null for three unrelated facts, and the page was
 * rendering all three as an affirmative "no earnings in window". Measured on
 * 2026-08-16 the committed calendar covered 17 symbols against a 95-name
 * panel, and exactly one of the twelve traded names — so eleven of twelve
 * showed a safety pass derived from never having been looked up.
 */
describe("earningsStatus — unknown is not clear", () => {
  const AS_OF = Date.UTC(2026, 7, 13); // Thursday 2026-08-13
  const cal = (
    entries: Array<{ symbol: string; date: string }>,
    generatedAt = AS_OF
  ): EarningsCalendar => ({ generatedAt, entries });

  it("confirms a date inside the window", () => {
    const s = earningsStatus("HD", cal([{ symbol: "HD", date: "2026-08-14" }]), AS_OF);
    expect(s.status).toBe("confirmed_date");
    if (s.status === "confirmed_date") expect(s.sessions).toBe(1);
  });

  /* Clear means a date is KNOWN and outside the window — never an absence. */
  it("confirms clear only when it can name the next report", () => {
    const s = earningsStatus("HD", cal([{ symbol: "HD", date: "2026-09-30" }]), AS_OF);
    expect(s.status).toBe("confirmed_none");
    if (s.status === "confirmed_none") expect(s.nextDate).toBe("2026-09-30");
  });

  /*
   * THE BUG. A symbol the calendar never covered is UNKNOWN. Before this it
   * was indistinguishable from clear, which is how eleven of twelve traded
   * names got an affirmative overnight pass out of thin air.
   */
  it("calls an uncovered symbol unknown, not clear", () => {
    const s = earningsStatus("APLD", cal([{ symbol: "IREN", date: "2026-09-30" }]), AS_OF);
    expect(s.status).toBe("lookup_failed");
    if (s.status === "lookup_failed") expect(s.reason).toBe("symbol_not_covered");
  });

  it("calls a missing calendar unknown", () => {
    expect(earningsStatus("HD", null, AS_OF).status).toBe("lookup_failed");
    expect(earningsStatus("HD", cal([]), AS_OF).status).toBe("lookup_failed");
  });

  /*
   * The pipeline keeps a stale calendar on purpose when the provider fails,
   * reasoning that entries expire by date. True, and beside the point: a date
   * announced AFTER the last fetch never appears at all.
   */
  it("calls a stale calendar unknown even when it holds a date for the symbol", () => {
    const stale = cal(
      [{ symbol: "HD", date: "2026-09-30" }],
      AS_OF - (MAX_CALENDAR_AGE_DAYS + 1) * 86_400_000
    );
    const s = earningsStatus("HD", stale, AS_OF);
    expect(s.status).toBe("lookup_failed");
    if (s.status === "lookup_failed") {
      expect(s.reason).toBe("calendar_stale");
      expect(s.calendarAgeDays).toBe(MAX_CALENDAR_AGE_DAYS + 1);
    }
  });

  it("still trusts a calendar right at the age limit", () => {
    const edge = cal(
      [{ symbol: "HD", date: "2026-09-30" }],
      AS_OF - MAX_CALENDAR_AGE_DAYS * 86_400_000
    );
    expect(earningsStatus("HD", edge, AS_OF).status).toBe("confirmed_none");
  });

  /* A report already delivered is priced in, not a pending gap. */
  it("ignores past dates and reports the symbol as uncovered", () => {
    const s = earningsStatus("HD", cal([{ symbol: "HD", date: "2026-08-11" }]), AS_OF);
    expect(s.status).toBe("lookup_failed");
  });

  it("takes the soonest of several future dates", () => {
    const s = earningsStatus(
      "HD",
      cal([{ symbol: "HD", date: "2026-09-30" }, { symbol: "HD", date: "2026-08-14" }]),
      AS_OF
    );
    expect(s.status).toBe("confirmed_date");
  });
});

describe("describeEarningsStatus", () => {
  it("never says no-earnings when the answer is unknown", () => {
    const line = describeEarningsStatus({
      status: "lookup_failed", reason: "symbol_not_covered", calendarAgeDays: 0,
    });
    expect(line).toContain("UNKNOWN");
    expect(line).not.toMatch(/no earnings/i);
  });

  it("names the date it is relying on when it says clear", () => {
    const line = describeEarningsStatus({
      status: "confirmed_none", nextDate: "2026-09-30", sessions: 33,
    });
    expect(line).toContain("2026-09-30");
  });

  it("says how stale the calendar was", () => {
    const line = describeEarningsStatus({
      status: "lookup_failed", reason: "calendar_stale", calendarAgeDays: 12,
    });
    expect(line).toContain("12 days old");
  });
});
