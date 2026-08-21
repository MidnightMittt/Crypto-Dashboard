import { describe, expect, it } from "vitest";
import { SWEEP_SILENT_AFTER_MINUTES, SweepRecord, assessSweepLiveness } from "./heartbeat";

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
