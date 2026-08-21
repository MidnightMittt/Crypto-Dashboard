import { describe, expect, it } from "vitest";
import {
  SWEEP_SILENT_AFTER_MINUTES,
  SweepRecord,
  assessSweepLiveness,
  withinSweepWindow,
} from "./heartbeat";

/** 14:00 ET on a Friday — inside the sweep window, so silence is meaningful. */
const NOW = new Date("2026-08-21T18:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const rec = (over: Partial<SweepRecord> = {}): SweepRecord => ({
  at: minsAgo(4),
  armed: 3,
  judged: 3,
  fired: 0,
  skippedStale: 0,
  ...over,
});

describe("assessSweepLiveness", () => {
  /*
   * THE STATE THE WATCHDOG IS ACTUALLY IN TODAY. It has never fired, and until
   * now that was indistinguishable from never having run. An empty record must
   * say NEVER RAN in as many words, and name the 401 path — that is the failure
   * this repo has already hit once.
   */
  it("says never ran, rather than implying quiet", () => {
    const r = assessSweepLiveness([], NOW);
    expect(r.health).toBe("never_ran");
    expect(r.sentence).toContain("NEVER RUN");
    expect(r.sentence).toContain("401");
    expect(r.lastSweptAt).toBeNull();
  });

  it("reports watching when a recent sweep judged its levels", () => {
    const r = assessSweepLiveness([rec()], NOW);
    expect(r.health).toBe("watching");
    expect(r.minutesSinceSweep).toBe(4);
    // The point of the sentence: zero fires is given a meaning.
    expect(r.sentence).toContain("no level was crossed, not that nothing ran");
  });

  /*
   * THE STATE THIS MODULE EXISTS FOR. Running, punctual, and judging nothing
   * because every quote is stale. It emits the same zero fires a healthy quiet
   * market does, so nothing else in the system would ever catch it.
   */
  it("catches a sweep that runs on time and judges nothing", () => {
    const r = assessSweepLiveness([rec({ judged: 0, skippedStale: 3 })], NOW);
    expect(r.health).toBe("blind");
    expect(r.sentence).toContain("running and blind");
    expect(r.sentence).toContain("quote feed is the thing to check");
  });

  it("goes silent once the gap exceeds the tolerated drift", () => {
    const late = assessSweepLiveness([rec({ at: minsAgo(SWEEP_SILENT_AFTER_MINUTES + 1) })], NOW);
    expect(late.health).toBe("silent");
    expect(late.sentence).toContain("NOT being watched");

    // Inside the window, cron drift is tolerated rather than alarmed about.
    const drifted = assessSweepLiveness([rec({ at: minsAgo(SWEEP_SILENT_AFTER_MINUTES - 1) })], NOW);
    expect(drifted.health).toBe("watching");
  });

  /* An armed count of zero is not "blind" — there is simply nothing to judge. */
  it("does not call an empty watchlist blind", () => {
    const r = assessSweepLiveness([rec({ armed: 0, judged: 0 })], NOW);
    expect(r.health).toBe("watching");
  });

  it("reads the newest record regardless of the order given", () => {
    const r = assessSweepLiveness(
      [rec({ at: minsAgo(90), fired: 1 }), rec({ at: minsAgo(3) }), rec({ at: minsAgo(45) })],
      NOW
    );
    expect(r.minutesSinceSweep).toBe(3);
    expect(r.firedRecently).toBe(1);
  });
});

describe("withinSweepWindow", () => {
  /*
   * THE CHECK THAT INVALIDATED MY OWN INVESTIGATION. A 45-minute poll was run
   * at 05:35-06:21 ET on a Friday and reported "the sweep is not running" —
   * before the open, and before the day's first cron. It could not tell a dead
   * watchdog from a market that had not opened, which is precisely the
   * non-discriminating check this whole module exists to eliminate.
   */
  it("is closed before the open, when a missing sweep proves nothing", () => {
    expect(withinSweepWindow(new Date("2026-08-21T10:21:00Z"))).toBe(false); // 06:21 ET
    expect(withinSweepWindow(new Date("2026-08-21T13:29:00Z"))).toBe(false); // 09:29 ET
    expect(withinSweepWindow(new Date("2026-08-21T13:30:00Z"))).toBe(true); // 09:30 ET
  });

  it("closes a few minutes past the bell, not at it", () => {
    expect(withinSweepWindow(new Date("2026-08-21T20:04:00Z"))).toBe(true); // 16:04 ET
    expect(withinSweepWindow(new Date("2026-08-21T20:05:00Z"))).toBe(false); // 16:05 ET
  });

  it("is closed all weekend", () => {
    expect(withinSweepWindow(new Date("2026-08-22T18:00:00Z"))).toBe(false); // Sat 14:00 ET
    expect(withinSweepWindow(new Date("2026-08-23T18:00:00Z"))).toBe(false); // Sun
  });
});

describe("assessSweepLiveness outside market hours", () => {
  const CLOSED = new Date("2026-08-21T10:21:00Z"); // 06:21 ET Friday

  /*
   * WITHOUT THIS THE ENDPOINT CRIES WOLF NIGHTLY. Overnight is ~17 hours, far
   * past the 120-minute silence limit, so a perfectly healthy watchdog would
   * report "levels are NOT being watched" every single morning. An alarm that
   * fires every day is muted, and then the real one is missed too.
   */
  it("does not call an idle overnight watchdog silent", () => {
    const r = assessSweepLiveness([rec({ at: "2026-08-20T19:55:00Z" })], CLOSED);
    expect(r.health).toBe("closed");
    expect(r.sentence).toContain("by design, not a fault");
  });

  it("refuses to conclude anything from an empty record while closed", () => {
    const r = assessSweepLiveness([], CLOSED);
    expect(r.health).toBe("closed");
    expect(r.sentence).toContain("proves nothing either way");
    expect(r.sentence).not.toContain("NEVER RUN");
  });
});
