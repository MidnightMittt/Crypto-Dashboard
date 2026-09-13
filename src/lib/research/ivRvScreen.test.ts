import { describe, expect, it } from "vitest";
import { IV_TENOR_SESSIONS, IvRvPoint, TRAILING_WINDOWS } from "./ivRv";
import {
  IVRV_SCREEN_DECLARATION,
  MIN_CROSS_SECTION,
  blockPeriodsFor,
  countIndependentWindows,
  evaluateIvRvScreen,
} from "./ivRvScreen";

/**
 * A resolved observation, built from the two numbers the statistic actually
 * uses: the screen (IV / trailing RV at the pinned window) and the forward
 * ratio (IV / forward RV). The realised premium is -ln(forwardRatio), so a
 * forwardRatio BELOW 1 is a win for the option buyer.
 *
 * The trailing legs are generated FROM `TRAILING_WINDOWS` rather than written
 * out. When the horizon moved from 21 sessions to 15 this fixture went on
 * building a leg at 21, and the module — correctly looking for 15 — found no
 * screen on any row and returned a null result. The tests failed loudly, which
 * is the good outcome; a fixture that pins the window it is testing against is
 * the same unit-blind pin that caused the horizon bug in the first place.
 */
const point = (
  date: string,
  symbol: string,
  screen: number,
  forwardRatio: number | null
): IvRvPoint => ({
  date,
  symbol,
  ivPct: 80,
  ivTenorSessions: IV_TENOR_SESSIONS,
  trailing: TRAILING_WINDOWS.map((windowSessions) => ({
    windowSessions,
    rvPct: 80 / screen,
    ratio: screen,
  })),
  forwardRvPct: forwardRatio === null ? null : 80 / forwardRatio,
  forwardRatio,
  forwardResolvedOn: forwardRatio === null ? null : "2026-10-01",
});

/** Session index per date, as the artefact now carries it. */
const calendar = (dates: Record<string, number>) => (d: string) => dates[d];

/**
 * A session where the screen ranks PERFECTLY against the outcome in the
 * declared direction: lowest ratio, largest realised premium. Spearman = -1.
 */
function perfectSession(date: string, n = 8): IvRvPoint[] {
  return Array.from({ length: n }, (_, i) =>
    // screen rises with i; forwardRatio also rises with i, so premium FALLS.
    point(date, `S${i}`, 0.6 + i * 0.1, 0.6 + i * 0.1)
  );
}

describe("countIndependentWindows — the gate a row count is mistaken for", () => {
  /*
   * THE ARITHMETIC THE WHOLE KILL LINE TURNS ON. Ten observation dates over
   * fourteen sessions, judged on a twenty-one-session horizon, are ONE window.
   * The 634 rows collected as of 2026-09-13 sit on exactly this calendar.
   */
  it("counts ten dates inside one horizon as a single independent window", () => {
    const indices = [0, 5, 8, 9, 10, 11, 12, 14, 15, 16];
    expect(countIndependentWindows(indices, 21)).toBe(1);
  });

  it("counts a new window only once the horizon has fully elapsed", () => {
    expect(countIndependentWindows([0, 20], 21)).toBe(1);
    expect(countIndependentWindows([0, 21], 21)).toBe(2);
    expect(countIndependentWindows([0, 21, 41, 42], 21)).toBe(3);
  });

  it("is unmoved by how many rows sit on each date", () => {
    // Duplicated indices are the same session, however many names it holds.
    expect(countIndependentWindows([0, 0, 0, 0, 0], 21)).toBe(1);
  });
});

describe("blockPeriodsFor — a block must span the dependence horizon", () => {
  it("takes the widest cluster of dates inside one horizon, not the median", () => {
    // Dates 0..4 are five dates inside 21 sessions; 40 is on its own.
    expect(blockPeriodsFor([0, 1, 2, 3, 4, 40], 21)).toBe(5);
  });

  it("degenerates to one when every date is already independent", () => {
    expect(blockPeriodsFor([0, 30, 60], 21)).toBe(1);
  });
});

describe("the declaration itself", () => {
  /*
   * These are the pins. A test that asserts them is the mechanism that makes
   * "declared in advance" mean something: changing any of them now fails the
   * suite and forces the change to be an explicit, reviewable act rather than
   * a quiet edit made once the data has an opinion.
   *
   * EVERY VALUE BELOW IS A LITERAL, DELIBERATELY. Writing
   * `expect(d.primaryTrailingWindow).toBe(IV_TENOR_SESSIONS)` would read as
   * tidier and would assert nothing — a pin that imports the value it pins
   * moves whenever that value moves, which is the opposite of a pin. The
   * fixture above derives from the constants because it is describing data;
   * this block hard-codes them because it is describing a commitment.
   *
   * ── This pin fired once, on 2026-09-13 ───────────────────────────────
   *
   * It read 21 and now reads 15. The change is recorded rather than quietly
   * made: `IV_TENOR_SESSIONS` had been set to the options module's
   * CONSTANT_MATURITY_DAYS, which is measured in CALENDAR days, so a
   * three-week implied number was being scored against thirty calendar days of
   * realisation. Zero forward legs had resolved when it was corrected, so
   * there was no result the new horizon could have been chosen to favour, and
   * the shorter alternative on the table — ten sessions — was refused.
   * @see scripts/audit/ivRvHorizonAgreement.ts
   */
  it("pins one window, one sign and both gates before any data exists", () => {
    const d = IVRV_SCREEN_DECLARATION;
    expect(d.id).toBe("ivrv-option-screen");
    expect(d.declaredOn).toBe("2026-09-13");
    expect(d.primaryTrailingWindow).toBe(15);
    expect(d.horizonSessions).toBe(15);
    expect(d.sensitivityWindows).toEqual([10, 63]);
    expect(d.predictedSign).toBe(-1);
    expect(d.minimumResolved).toBe(100);
    expect(d.minimumIndependentWindows).toBe(4);
    expect(d.consequence["inside-noise"]).toBe("one-lucky-read");
    expect(d.consequence.survives).toBe("screened-method");
  });

  /*
   * The horizon is the last free parameter in the declaration, so it carries
   * its own reason in a field rather than only in a comment — the page renders
   * it, and a rationale nobody can see is not a disclosure.
   */
  it("states why the clock is the clock, in a field the page renders", () => {
    const r = IVRV_SCREEN_DECLARATION.horizonRationale;
    expect(r).toContain("calendar");
    expect(r).toContain("15 sessions");
    expect(r.length).toBeGreaterThan(120);
  });

  /* The id IS the join key to `method.method_id` in the round-trip log. */
  it("names the method the one labelled round trip carries", () => {
    expect(IVRV_SCREEN_DECLARATION.id).toBe("ivrv-option-screen");
  });
});

/*
 * The horizon calendar answers "when could each clock speak" without creating
 * a second test. The risk it carries is precisely that it might become one, so
 * these assertions guard the boundary: many rows, exactly one declared, and a
 * result computed at that one alone.
 */
describe("the horizon calendar", () => {
  const DATES = { "2026-09-01": 0, "2026-09-02": 1, "2026-09-03": 2 };
  const standing = () =>
    evaluateIvRvScreen(
      Object.keys(DATES).flatMap((d) => perfectSession(d, 8)),
      calendar(DATES)
    );

  it("marks exactly one horizon as declared, and it is the declared one", () => {
    const rows = standing().horizonCalendar;
    const declared = rows.filter((r) => r.declared);
    expect(declared).toHaveLength(1);
    expect(declared[0].horizonSessions).toBe(IVRV_SCREEN_DECLARATION.horizonSessions);
  });

  it("reports a date for every horizon while computing a correlation for none", () => {
    const s = standing();
    expect(s.horizonCalendar.length).toBeGreaterThan(1);
    for (const r of s.horizonCalendar) expect(r.evaluableDate).not.toBeNull();
    /* Three dates one session apart is one window at any horizon above 1. */
    expect(s.result).toBeNull();
  });

  it("does not choose the horizon that speaks soonest", () => {
    /*
     * The load-bearing assertion. If the declared clock were ever also the
     * fastest, the disclosure would stop being evidence that the horizon was
     * chosen for a reason — and a future edit that quietly shortens it to gain
     * time would sail through every other test in this file.
     */
    const rows = standing().horizonCalendar;
    const soonest = rows.reduce((a, b) =>
      (a.sessionsUntilGate ?? Infinity) <= (b.sessionsUntilGate ?? Infinity) ? a : b
    );
    expect(soonest.declared).toBe(false);
  });

  it("gives every undeclared horizon a named reason for being undeclared", () => {
    for (const r of standing().horizonCalendar) {
      if (r.declared) expect(r.note).toBe("");
      else expect(r.note.length).toBeGreaterThan(40);
    }
  });

  it("converts sessions to calendar days rather than restating them", () => {
    const rows = standing().horizonCalendar;
    for (const r of rows) expect(r.calendarDays).toBeGreaterThan(r.horizonSessions);
    const declared = rows.find((r) => r.declared)!;
    /* 15 sessions is three calendar weeks, so ~21 days — the quoted tenor. */
    expect(declared.calendarDays).toBeCloseTo(21.7, 1);
  });
});

describe("evaluateIvRvScreen — while nothing has resolved", () => {
  it("refuses a verdict and says so as the first thing it says", () => {
    const points = [point("2026-09-10", "CLSK", 0.79, null)];
    const s = evaluateIvRvScreen(points, calendar({ "2026-09-10": 0 }));
    expect(s.verdict).toBe("waiting");
    expect(s.classification).toBe("undetermined");
    expect(s.result).toBeNull();
    expect(s.resolved).toBe(0);
    expect(s.reading).toContain("No forward leg has resolved");
  });

  /*
   * THE CASE THIS FILE EXISTS FOR. Sixty-two rows land on 2026-09-22 and the
   * row gate is still short, but even at n=100 the WINDOW gate would not be:
   * one date is one window. A verdict here in either direction would be a
   * single draw reported as a hundred.
   */
  it("stays silent on a full cohort landing on one date", () => {
    const points = perfectSession("2026-09-22", 62);
    const s = evaluateIvRvScreen(points, calendar({ "2026-09-22": 0 }));
    expect(s.resolved).toBe(62);
    expect(s.independentWindows).toBe(1);
    expect(s.verdict).toBe("waiting");
    // The correlation is a perfect -1 and it is still not computed.
    expect(s.result).toBeNull();
    expect(s.reading).toContain("1 independent forward window");
  });

  it("still refuses at 100+ rows when they sit inside one forward window", () => {
    const dates = { "2026-09-22": 0, "2026-09-29": 5, "2026-10-06": 10 };
    const points = [
      ...perfectSession("2026-09-22", 62),
      ...perfectSession("2026-09-29", 40),
      ...perfectSession("2026-10-06", 40),
    ];
    const s = evaluateIvRvScreen(points, calendar(dates));
    expect(s.resolved).toBe(142);
    expect(s.gates.find((g) => g.id === "resolved-rows")!.met).toBe(true);
    expect(s.independentWindows).toBe(1);
    expect(s.gates.find((g) => g.id === "independent-windows")!.met).toBe(false);
    expect(s.verdict).toBe("waiting");
    expect(s.reading).toContain("independent windows 1 of 4");
  });

  it("names every unmet gate with its own numbers, not a generic refusal", () => {
    const s = evaluateIvRvScreen(perfectSession("2026-09-22", 62), calendar({ "2026-09-22": 0 }));
    const rows = s.gates.find((g) => g.id === "resolved-rows")!;
    expect(rows.have).toBe(62);
    expect(rows.need).toBe(100);
    expect(rows.met).toBe(false);
  });
});

describe("evaluateIvRvScreen — once both gates are met", () => {
  /** Four dates 21+ sessions apart: four genuinely independent windows. */
  const FOUR = { "2026-09-22": 0, "2026-10-21": 21, "2026-11-19": 42, "2026-12-18": 63 };
  const fourDates = (build: (date: string) => IvRvPoint[]) =>
    Object.keys(FOUR).flatMap(build);

  it("survives when the screen ranks the outcome in the declared direction", () => {
    const points = fourDates((d) => perfectSession(d, 30));
    const s = evaluateIvRvScreen(points, calendar(FOUR));
    expect(s.independentWindows).toBe(4);
    expect(s.resolved).toBe(120);
    expect(s.verdict).toBe("survives");
    expect(s.classification).toBe("screened-method");
    expect(s.result!.correlation).toBeCloseTo(-1, 6);
    expect(s.result!.signAsPredicted).toBe(true);
    expect(s.result!.containsZero).toBe(false);
    expect(s.reading).toContain("stays classified as a screened method");
  });

  /*
   * THE KILL, AND THE CASE THE BLOCK BOOTSTRAP EXISTS FOR. Two sessions rank
   * the outcome perfectly (rho -1) and two rank it perfectly inverted (rho
   * +1). The pooled statistic is 0 — but the interesting part is that even if
   * three of the four had agreed, four blocks disagreeing this much produce an
   * interval that spans most of [-1, 1]. That is what "inside its own noise
   * floor" means with four independent windows, and it is why the gate is set
   * where it is rather than at a row count.
   */
  it("reclassifies to one lucky read when the interval covers zero", () => {
    const dates = Object.keys(FOUR);
    const points = dates.flatMap((d, k) =>
      Array.from({ length: 30 }, (_, i) =>
        k % 2 === 0
          ? point(d, `S${i}`, 0.6 + i * 0.05, 0.6 + i * 0.05) // rho -1
          : point(d, `S${i}`, 0.6 + i * 0.05, 2.1 - i * 0.05) // rho +1
      )
    );
    const s = evaluateIvRvScreen(points, calendar(FOUR));
    expect(s.independentWindows).toBe(4);
    expect(s.result!.correlation).toBeCloseTo(0, 6);
    expect(s.result!.containsZero).toBe(true);
    expect(s.verdict).toBe("inside-noise");
    expect(s.classification).toBe("one-lucky-read");
    expect(s.reading).toContain("one lucky read");
  });

  /*
   * A SIGNIFICANT RESULT WITH THE WRONG SIGN IS A KILL, NOT A DISCOVERY. The
   * screen is inverted here — high ratio predicts the high premium — which is
   * a real relationship and the exact opposite of the one declared. Reporting
   * it as a pass with the story rewritten is how a null becomes a finding.
   */
  it("kills a strong correlation that points the wrong way", () => {
    const points = fourDates((d) =>
      Array.from({ length: 30 }, (_, i) =>
        // screen rises with i; forwardRatio FALLS, so premium rises. rho = +1.
        point(d, `S${i}`, 0.6 + i * 0.05, 3 - i * 0.05)
      )
    );
    const s = evaluateIvRvScreen(points, calendar(FOUR));
    expect(s.result!.correlation).toBeCloseTo(1, 6);
    expect(s.result!.signAsPredicted).toBe(false);
    expect(s.verdict).toBe("inside-noise");
    expect(s.classification).toBe("one-lucky-read");
    expect(s.reading).toContain("points the wrong way");
  });

  /* The sensitivity windows are reported and have no vote. */
  it("reports the unpinned windows without letting them change the verdict", () => {
    const points = fourDates((d) => perfectSession(d, 30));
    const s = evaluateIvRvScreen(points, calendar(FOUR));
    expect(s.result!.sensitivity.map((x) => x.windowSessions)).toEqual([10, 63]);
    expect(s.reading).toContain("had no vote");
  });
});

describe("the statistic itself", () => {
  const FOUR = { a: 0, b: 21, c: 42, d: 63 };

  /* A session thinner than the cross-section floor forms no correlation. */
  it("forms no statistic on a session too narrow to rank", () => {
    const thin = Object.keys(FOUR).flatMap((d) =>
      Array.from({ length: MIN_CROSS_SECTION - 1 }, (_, i) => point(d, `S${i}`, 0.6 + i * 0.1, 1.1))
    );
    const s = evaluateIvRvScreen(thin, calendar(FOUR));
    expect(s.sessionsWithStatistic).toBe(0);
    expect(s.verdict).toBe("waiting");
  });

  /*
   * Ranking happens INSIDE each session, so a market-wide vol expansion that
   * lifts every forward leg on one date cannot register as a signal. Both
   * sessions here have identical internal ordering; one is simply shifted so
   * every name realised more vol. The correlation must be unchanged.
   */
  it("is blind to a common vol factor moving one whole session", () => {
    const ordered = (d: string, shift: number) =>
      Array.from({ length: 30 }, (_, i) => point(d, `S${i}`, 0.6 + i * 0.05, (0.6 + i * 0.05) * shift));
    const flat = evaluateIvRvScreen(
      Object.keys(FOUR).flatMap((d) => ordered(d, 1)),
      calendar(FOUR)
    );
    const shocked = evaluateIvRvScreen(
      [...ordered("a", 1), ...ordered("b", 0.3), ...ordered("c", 1), ...ordered("d", 2.5)],
      calendar(FOUR)
    );
    expect(shocked.result!.correlation).toBeCloseTo(flat.result!.correlation, 10);
  });

  /* Ties share a midrank rather than being ordered by array position. */
  it("gives tied screens the same rank instead of an arbitrary order", () => {
    const tied = Object.keys(FOUR).flatMap((d) =>
      // Every screen identical: the x-leg has no spread, so no correlation exists.
      Array.from({ length: 20 }, (_, i) => point(d, `S${i}`, 1.0, 0.7 + i * 0.05))
    );
    const s = evaluateIvRvScreen(tied, calendar(FOUR));
    expect(s.sessionsWithStatistic).toBe(0);
  });
});
