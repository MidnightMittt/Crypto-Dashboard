import { describe, expect, it } from "vitest";
import { earningsVeto, sessionsUntil, EarningsCalendar } from "./earningsVeto";

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
