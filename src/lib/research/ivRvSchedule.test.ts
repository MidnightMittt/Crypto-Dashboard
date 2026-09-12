import { describe, expect, it } from "vitest";
import { buildResolutionSchedule, scheduleReading } from "./ivRvSchedule";

/** 2026-09-08 .. 2026-09-11 are consecutive sessions; 09-12/13 are a weekend. */
const SESSIONS = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];

const build = (
  observations: Array<{ sessionIndex: number; resolved: boolean }>,
  horizonSessions = 3,
  sessions = SESSIONS
) => buildResolutionSchedule({ observations, horizonSessions, sessions });

describe("buildResolutionSchedule", () => {
  it("counts a resolved observation as resolved and nothing else", () => {
    const s = build([{ sessionIndex: 0, resolved: true }]);
    expect(s).toMatchObject({ joined: 1, resolved: 1, pending: 0, unresolvable: 0 });
    expect(s.sessionsUntilNextResolution).toBeNull();
  });

  it("separates pending from unresolvable rather than pooling them as open", () => {
    /*
     * The distinction the whole module exists for. Both rows are unresolved;
     * index 0's window ended at index 3 and produced nothing, so it is lost to
     * a gap. Index 2's window ends at index 5, past the panel, so it is time.
     */
    const s = build([
      { sessionIndex: 0, resolved: false }, // 0+3 = 3 = lastIndex -> elapsed, empty
      { sessionIndex: 2, resolved: false }, // 2+3 = 5 > 3 -> two sessions to go
    ]);
    expect(s.unresolvable).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.sessionsUntilNextResolution).toBe(2);
  });

  it("projects the next resolution across the weekend", () => {
    // Last panel session is Friday 2026-09-11; two sessions on is Tuesday.
    const s = build([{ sessionIndex: 2, resolved: false }]);
    expect(s.projectedFrom).toBe("2026-09-11");
    expect(s.projectedNextResolution).toBe("2026-09-15");
    expect(s.projectionNote).toBeNull();
  });

  it("reports the cohort size landing on that date, not just the date", () => {
    const s = build([
      { sessionIndex: 2, resolved: false },
      { sessionIndex: 2, resolved: false },
      { sessionIndex: 2, resolved: false },
      { sessionIndex: 3, resolved: false }, // lands a session later
    ]);
    expect(s.sessionsUntilNextResolution).toBe(2);
    expect(s.nextResolutionCount).toBe(3);
    expect(s.pending).toBe(4);
  });

  it("measures elapsed time from the panel's last session, not the newest observation", () => {
    /*
     * If the newest observation were used as the clock, this row would look
     * like it had three sessions to go instead of two, and every projected
     * date would be late by the gap between the last observation and the last
     * session. That gap is real: implied readings are not recorded nightly.
     */
    const s = build([{ sessionIndex: 2, resolved: false }]);
    expect(s.sessionsUntilNextResolution).toBe(2);
  });

  it("refuses a date rather than extrapolating past the declared holiday table", () => {
    const s = buildResolutionSchedule({
      observations: [{ sessionIndex: 0, resolved: false }],
      horizonSessions: 5000,
      sessions: SESSIONS,
    });
    expect(s.sessionsUntilNextResolution).toBe(4997);
    expect(s.projectedNextResolution).toBeNull();
    expect(s.projectionNote).toContain("2027-12-31");
  });

  it("handles an empty observation set without inventing a schedule", () => {
    const s = build([]);
    expect(s).toMatchObject({ joined: 0, resolved: 0, pending: 0, unresolvable: 0 });
    expect(s.projectedNextResolution).toBeNull();
    expect(s.projectionNote).toBe("no joined observations to schedule");
  });
});

describe("scheduleReading", () => {
  it("leads with the refusal while nothing has resolved", () => {
    const r = scheduleReading(build([{ sessionIndex: 2, resolved: false }]));
    expect(r.startsWith("NO forward leg has resolved")).toBe(true);
    expect(r).toContain("2026-09-15");
    expect(r).toContain("nothing here supports");
  });

  it("names the threshold, ranking and screen it refuses to support", () => {
    const r = scheduleReading(build([{ sessionIndex: 2, resolved: false }]));
    for (const word of ["threshold", "ranking", "screen"]) expect(r).toContain(word);
  });

  it("reports lost rows rather than letting them pass as still-coming", () => {
    const r = scheduleReading(
      build([
        { sessionIndex: 0, resolved: false },
        { sessionIndex: 2, resolved: false },
      ])
    );
    expect(r).toContain("can never resolve");
  });

  it("switches to the breadth caveat once something has resolved", () => {
    const r = scheduleReading(
      build([
        { sessionIndex: 0, resolved: true },
        { sessionIndex: 2, resolved: false },
      ])
    );
    expect(r).toContain("1 of 2 forward legs have resolved");
    expect(r).toContain("effective breadth");
    expect(r).not.toContain("NO forward leg");
  });

  it("says so when nothing is pending and nothing resolved", () => {
    const r = scheduleReading(build([{ sessionIndex: 0, resolved: false }]));
    expect(r).toContain("Nothing has resolved and nothing is pending");
  });

  it("says there is nothing to resolve on an empty set", () => {
    expect(scheduleReading(build([]))).toContain("nothing to resolve");
  });
});
