import { describe, expect, it } from "vitest";
import {
  assessPriceStaleness,
  latestCompletedSession,
  sessionsBetween,
  STALE_AT_SESSIONS,
} from "./priceStaleness";

/** 2026-08-20 is a Thursday; 08-22/23 are the weekend. */
const at = (iso: string) => new Date(iso);

describe("latestCompletedSession", () => {
  /* 15:59 ET on a Thursday: today's close has not happened, so Wednesday is the latest. */
  it("does not count today before the close", () => {
    expect(latestCompletedSession(at("2026-08-20T19:59:00Z"))).toBe("2026-08-19");
  });

  it("counts today once the close has passed", () => {
    // 16:00 ET = 20:00 UTC in August (EDT).
    expect(latestCompletedSession(at("2026-08-20T20:00:00Z"))).toBe("2026-08-20");
  });

  /* Saturday and Sunday both resolve back to Friday, never to a day with no session. */
  it("skips the weekend", () => {
    expect(latestCompletedSession(at("2026-08-22T18:00:00Z"))).toBe("2026-08-21");
    expect(latestCompletedSession(at("2026-08-23T18:00:00Z"))).toBe("2026-08-21");
    // Monday pre-close also falls back to Friday, not to Sunday.
    expect(latestCompletedSession(at("2026-08-24T13:00:00Z"))).toBe("2026-08-21");
  });

  /*
   * DST is why this uses a real timezone rather than a fixed UTC offset. In
   * January the close is 16:00 EST = 21:00 UTC, so 20:30 UTC is still
   * mid-session and today must not count as completed.
   */
  it("tracks the close through the DST change", () => {
    expect(latestCompletedSession(at("2026-01-15T20:30:00Z"))).toBe("2026-01-14");
    expect(latestCompletedSession(at("2026-01-15T21:00:00Z"))).toBe("2026-01-15");
  });
});

describe("sessionsBetween", () => {
  it("counts weekdays, exclusive of the start", () => {
    expect(sessionsBetween("2026-08-19", "2026-08-20")).toBe(1);
    expect(sessionsBetween("2026-08-20", "2026-08-20")).toBe(0);
  });

  /* The observed gap: 08-14 (Fri) to 08-20 (Thu) is 17,18,19,20 = 4 sessions. */
  it("excludes the weekend from the observed CIFR gap", () => {
    expect(sessionsBetween("2026-08-14", "2026-08-20")).toBe(4);
  });

  it("returns zero when the price is somehow ahead of the calendar", () => {
    expect(sessionsBetween("2026-08-21", "2026-08-20")).toBe(0);
  });
});

describe("assessPriceStaleness", () => {
  /*
   * THE CASE THIS WAS BUILT FOR. A 2026-08-14 close served on 2026-08-20 is
   * four sessions behind and must say so — regardless of how near the live
   * price it happens to sit that hour.
   */
  it("flags the six-day-old close that prompted this", () => {
    const s = assessPriceStaleness("2026-08-14", at("2026-08-20T20:08:00Z"));
    expect(s.stale).toBe(true);
    expect(s.ageSessions).toBe(4);
    expect(s.latestCompletedSession).toBe("2026-08-20");
    expect(s.reason).toContain("4 trading sessions behind");
  });

  /* Yesterday's close during today's session is the datum working correctly. */
  it("does not flag the latest close as stale mid-session", () => {
    const s = assessPriceStaleness("2026-08-19", at("2026-08-20T15:00:00Z"));
    expect(s.stale).toBe(false);
    expect(s.ageSessions).toBe(0);
    expect(s.reason).toBeNull();
  });

  /*
   * The honest window: after today's close and before the nightly rebuild,
   * the panel genuinely IS one session behind and should say so rather than
   * wait for the job to make it true.
   */
  it("flags the gap between the close and the nightly rebuild", () => {
    const s = assessPriceStaleness("2026-08-19", at("2026-08-20T20:30:00Z"));
    expect(s.stale).toBe(true);
    expect(s.ageSessions).toBe(STALE_AT_SESSIONS);
    expect(s.reason).toContain("1 trading session behind");
  });

  it("treats a missing price as stale with its own reason, never as current", () => {
    const s = assessPriceStaleness(null, at("2026-08-20T20:08:00Z"));
    expect(s.stale).toBe(true);
    expect(s.reason).toContain("No price at all");
  });

  /* Staleness is about provenance; the module never sees the value. */
  it("is unaffected by how close the stale price happens to be", () => {
    const a = assessPriceStaleness("2026-08-14", at("2026-08-20T13:00:00Z"));
    const b = assessPriceStaleness("2026-08-14", at("2026-08-20T20:08:00Z"));
    expect(a.stale).toBe(true);
    expect(b.stale).toBe(true);
  });
});
