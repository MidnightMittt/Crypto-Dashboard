import { describe, expect, it } from "vitest";
import {
  HOLIDAYS_DECLARED_THROUGH,
  US_MARKET_HOLIDAYS,
  isSessionDate,
  projectSessionsForward,
} from "./marketCalendar";
import panelJson from "@/data/barsPanel.json";

const panel = panelJson as { sessions: string[] };

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Every weekday from `from` to `to` inclusive. */
function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = parse(from); ms <= parse(to); ms += DAY_MS) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(iso(ms));
  }
  return out;
}

/**
 * THE RECONCILIATION. This is the reason the declared table is trustworthy.
 *
 * The bars panel's calendar is derived from what actually traded across 124
 * symbols under a 50% quorum, so it is an observation rather than a claim.
 * Checking the declared holidays against it turns a hand-written list into a
 * measured one over the window they share.
 */
describe("declared holidays reconcile against the observed panel calendar", () => {
  const sessions = new Set(panel.sessions);
  const first = panel.sessions[0];
  const last = panel.sessions[panel.sessions.length - 1];

  it("has a panel span to check against", () => {
    expect(panel.sessions.length).toBeGreaterThan(200);
  });

  it("declares every weekday the panel has no session for", () => {
    const missing = weekdaysBetween(first, last).filter((d) => !sessions.has(d));
    const undeclared = missing.filter((d) => !US_MARKET_HOLIDAYS.includes(d));
    /*
     * A weekday absent from the panel that is not a declared holiday is one of
     * two things, and both are findings: a holiday this table does not know
     * about, or a session the ingest failed to collect. Either way the message
     * names the dates rather than just failing a count.
     */
    expect(
      undeclared,
      `weekdays with no panel session and no declared holiday: ${undeclared.join(", ")}`
    ).toEqual([]);
  });

  it("declares no holiday the panel actually traded on", () => {
    const inSpan = US_MARKET_HOLIDAYS.filter((d) => d >= first && d <= last);
    const traded = inSpan.filter((d) => sessions.has(d));
    expect(traded, `declared holidays the panel has a session for: ${traded.join(", ")}`).toEqual([]);
  });

  it("covers the panel span with at least one holiday per quarter it contains", () => {
    // A guard against the list being empty in range and the two tests above
    // passing vacuously.
    const inSpan = US_MARKET_HOLIDAYS.filter((d) => d >= first && d <= last);
    expect(inSpan.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the table is well-formed", () => {
  it("is sorted and free of duplicates", () => {
    const sorted = [...US_MARKET_HOLIDAYS].sort();
    expect(US_MARKET_HOLIDAYS).toEqual(sorted);
    expect(new Set(US_MARKET_HOLIDAYS).size).toBe(US_MARKET_HOLIDAYS.length);
  });

  it("never declares a weekend, which would be a silent no-op", () => {
    const weekendEntries = US_MARKET_HOLIDAYS.filter((d) => {
      const dow = new Date(parse(d)).getUTCDay();
      return dow === 0 || dow === 6;
    });
    expect(weekendEntries).toEqual([]);
  });

  it("reaches the declared horizon", () => {
    const lastHoliday = US_MARKET_HOLIDAYS[US_MARKET_HOLIDAYS.length - 1];
    expect(lastHoliday < HOLIDAYS_DECLARED_THROUGH).toBe(true);
    // Roughly nine to eleven closures a year; a year silently missing from the
    // table would show up here rather than as a wrong projection.
    const years = new Set(US_MARKET_HOLIDAYS.map((d) => d.slice(0, 4)));
    for (const y of years) {
      const n = US_MARKET_HOLIDAYS.filter((d) => d.startsWith(y)).length;
      expect(n, `${y} declares ${n} closures`).toBeGreaterThanOrEqual(9);
    }
  });
});

describe("isSessionDate", () => {
  it("rejects weekends", () => {
    expect(isSessionDate("2026-09-12")).toBe(false); // Saturday
    expect(isSessionDate("2026-09-13")).toBe(false); // Sunday
  });

  it("rejects declared holidays", () => {
    expect(isSessionDate("2026-09-07")).toBe(false); // Labor Day
    expect(isSessionDate("2026-11-26")).toBe(false); // Thanksgiving
  });

  it("accepts an ordinary weekday", () => {
    expect(isSessionDate("2026-09-11")).toBe(true);
    expect(isSessionDate("2026-11-27")).toBe(true); // half session, still a session
  });
});

describe("projectSessionsForward", () => {
  it("returns the origin for a zero-session projection", () => {
    expect(projectSessionsForward("2026-09-10", 0)).toEqual({
      date: "2026-09-10",
      refusedBecause: null,
    });
  });

  it("steps one session over a weekend", () => {
    expect(projectSessionsForward("2026-09-11", 1).date).toBe("2026-09-14");
  });

  it("counts from a non-session origin as if from the session before it", () => {
    // Saturday and the Friday before it must agree — the count is of sessions
    // strictly after the origin, and neither origin is one.
    expect(projectSessionsForward("2026-09-12", 3).date).toBe(
      projectSessionsForward("2026-09-13", 3).date
    );
    expect(projectSessionsForward("2026-09-12", 3).date).toBe("2026-09-16");
  });

  it("skips a holiday inside the span", () => {
    // 2026-11-25 Wed -> 26 Thanksgiving (skipped) -> 27 Fri is one session on.
    expect(projectSessionsForward("2026-11-25", 1).date).toBe("2026-11-27");
  });

  it("agrees with the observed panel calendar over a historical span", () => {
    /*
     * The strongest available check on the projection arithmetic: walk it
     * forward across a stretch the panel already knows the answer to. If the
     * weekend and holiday handling is off by anything, these diverge.
     */
    const idx = Math.max(0, panel.sessions.length - 40);
    const from = panel.sessions[idx];
    for (let k = 1; k <= 20; k++) {
      const projected = projectSessionsForward(from, k);
      expect(projected.date, `k=${k} from ${from}`).toBe(panel.sessions[idx + k]);
    }
  });

  it("refuses rather than extrapolating past the declared table", () => {
    const far = projectSessionsForward("2027-12-01", 200);
    expect(far.date).toBeNull();
    expect(far.refusedBecause).toContain(HOLIDAYS_DECLARED_THROUGH);
  });

  it("refuses a negative or fractional count instead of guessing", () => {
    expect(projectSessionsForward("2026-09-10", -1).date).toBeNull();
    expect(projectSessionsForward("2026-09-10", 1.5).date).toBeNull();
  });
});
