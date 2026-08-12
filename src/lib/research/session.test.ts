import { describe, expect, it } from "vitest";
import { sessionPeriodKey, sessionDateLabel, sameSession, calendarDateInZone } from "./session";
import { CONTINUOUS_SESSION, US_EQUITY_SESSION, FX_SESSION } from "./types";

/** Readable helper: the epoch of a UTC-midnight date, which is what a period key is. */
const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe("calendarDateInZone", () => {
  it("returns ISO dates and respects the zone", () => {
    // 2026-03-10T02:00Z is still 2026-03-09 in New York (21:00 EST).
    const t = Date.UTC(2026, 2, 10, 2, 0, 0);
    expect(calendarDateInZone(t, "UTC")).toBe("2026-03-10");
    expect(calendarDateInZone(t, "America/New_York")).toBe("2026-03-09");
  });
});

describe("the midnight-boundary rule", () => {
  /*
   * A crypto daily bar closing at Tuesday 00:00 UTC covers MONDAY's trading.
   * Keying on the raw close would call it Tuesday and misalign it by a full
   * day against every session-based market — the silent failure this module
   * exists to prevent.
   */
  it("attributes a midnight close to the session it completes, not the one it opens", () => {
    const tuesdayMidnight = Date.UTC(2026, 5, 16, 0, 0, 0); // Tue 16 Jun 2026 00:00Z
    expect(sessionPeriodKey(tuesdayMidnight, CONTINUOUS_SESSION)).toBe(utcDay(2026, 6, 15)); // Monday
    expect(sessionDateLabel(tuesdayMidnight, CONTINUOUS_SESSION)).toBe("2026-06-15");
  });

  it("a mid-session timestamp stays on its own date", () => {
    const mondayNoon = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(sessionPeriodKey(mondayNoon, CONTINUOUS_SESSION)).toBe(utcDay(2026, 6, 15));
  });
});

describe("cross-market alignment — the reason this exists", () => {
  /*
   * THE load-bearing test. A crypto bar closing Tuesday 00:00 UTC and a US
   * equity bar closing Monday 16:00 ET both cover Monday. They are three
   * hours and a calendar date apart in raw timestamps, and MUST share a
   * period key or the panel estimator will treat them as independent.
   */
  it("crypto and US equity bars covering the same trading day share a period key", () => {
    const cryptoClose = Date.UTC(2026, 5, 16, 0, 0, 0); // Tue 00:00Z — covers Monday
    const equityClose = Date.UTC(2026, 5, 15, 20, 0, 0); // Mon 16:00 EDT — covers Monday

    expect(sessionPeriodKey(cryptoClose, CONTINUOUS_SESSION)).toBe(utcDay(2026, 6, 15));
    expect(sessionPeriodKey(equityClose, US_EQUITY_SESSION)).toBe(utcDay(2026, 6, 15));
    expect(sameSession(cryptoClose, CONTINUOUS_SESSION, equityClose, US_EQUITY_SESSION)).toBe(true);
  });

  it("bars covering DIFFERENT trading days do not share a key", () => {
    const cryptoMonday = Date.UTC(2026, 5, 16, 0, 0, 0); // covers Monday
    const equityTuesday = Date.UTC(2026, 5, 16, 20, 0, 0); // Tue 16:00 EDT — covers Tuesday
    expect(sameSession(cryptoMonday, CONTINUOUS_SESSION, equityTuesday, US_EQUITY_SESSION)).toBe(false);
  });

  it("the naive raw-timestamp key would have got this wrong", () => {
    // Documents the bug rather than merely fixing it: raw timestamps differ,
    // and a key built from them would split one session into two.
    const cryptoClose = Date.UTC(2026, 5, 16, 0, 0, 0);
    const equityClose = Date.UTC(2026, 5, 15, 20, 0, 0);
    expect(cryptoClose).not.toBe(equityClose);
    expect(sessionPeriodKey(cryptoClose, CONTINUOUS_SESSION)).toBe(
      sessionPeriodKey(equityClose, US_EQUITY_SESSION)
    );
  });

  it("FX closing 17:00 ET aligns with the same session", () => {
    // Mon 17:00 EDT = Mon 21:00Z; the bar covers Sunday 17:00 -> Monday 17:00,
    // conventionally Monday.
    const fxClose = Date.UTC(2026, 5, 15, 21, 0, 0);
    expect(sessionPeriodKey(fxClose, FX_SESSION)).toBe(utcDay(2026, 6, 15));
  });
});

describe("daylight saving", () => {
  /*
   * A fixed UTC offset would be wrong for roughly half the year, and wrong
   * in a way that silently splits one session across two keys at the DST
   * boundary. These pin that Intl is doing the real zone arithmetic.
   */
  it("a 16:00 ET close maps to the same local date in winter and summer despite different UTC times", () => {
    // Winter: 16:00 EST = 21:00Z. Summer: 16:00 EDT = 20:00Z.
    const winterClose = Date.UTC(2026, 0, 15, 21, 0, 0); // 15 Jan 2026
    const summerClose = Date.UTC(2026, 6, 15, 20, 0, 0); // 15 Jul 2026

    expect(sessionDateLabel(winterClose, US_EQUITY_SESSION)).toBe("2026-01-15");
    expect(sessionDateLabel(summerClose, US_EQUITY_SESSION)).toBe("2026-07-15");
  });

  it("handles the spring-forward day without splitting or duplicating a session", () => {
    // US DST begins 2026-03-08. The close that day is 16:00 EDT = 20:00Z.
    const dstDayClose = Date.UTC(2026, 2, 8, 20, 0, 0);
    const dayBeforeClose = Date.UTC(2026, 2, 6, 21, 0, 0); // Fri, still EST
    expect(sessionDateLabel(dstDayClose, US_EQUITY_SESSION)).toBe("2026-03-08");
    expect(sessionDateLabel(dayBeforeClose, US_EQUITY_SESSION)).toBe("2026-03-06");
    expect(sessionPeriodKey(dstDayClose, US_EQUITY_SESSION)).not.toBe(
      sessionPeriodKey(dayBeforeClose, US_EQUITY_SESSION)
    );
  });

  it("an equity close near midnight UTC in winter still resolves to the correct ET date", () => {
    // 2026-01-15T21:00Z is 16:00 EST on the 15th — not the 16th.
    expect(sessionDateLabel(Date.UTC(2026, 0, 15, 21, 0, 0), US_EQUITY_SESSION)).toBe("2026-01-15");
  });
});

describe("determinism and key shape", () => {
  it("keys are UTC-midnight epochs, so they sort chronologically and compare by value", () => {
    const mon = sessionPeriodKey(Date.UTC(2026, 5, 16, 0, 0, 0), CONTINUOUS_SESSION);
    const tue = sessionPeriodKey(Date.UTC(2026, 5, 17, 0, 0, 0), CONTINUOUS_SESSION);
    expect(tue - mon).toBe(86_400_000);
    expect(mon % 86_400_000).toBe(0);
  });

  it("is deterministic across repeated calls", () => {
    const t = Date.UTC(2026, 5, 15, 20, 0, 0);
    const a = Array.from({ length: 50 }, () => sessionPeriodKey(t, US_EQUITY_SESSION));
    expect(new Set(a).size).toBe(1);
  });

  it("is independent of the machine's local timezone", () => {
    // The key is built from an explicit zone and Date.UTC, never from local
    // getters, so a process running in Tokyo produces the same answer.
    const t = Date.UTC(2026, 5, 15, 20, 0, 0);
    expect(sessionPeriodKey(t, US_EQUITY_SESSION)).toBe(utcDay(2026, 6, 15));
  });
});
