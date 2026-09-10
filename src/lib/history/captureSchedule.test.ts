import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CAPTURE_MINUTES, ExecutionWindow } from "./spreadHistory";

/**
 * THE CAPTURE SCHEDULE IS ARITHMETIC, AND ARITHMETIC ROTS.
 *
 * The spread recorder's crons are UTC; its targets are Eastern wall-clock
 * minutes. The relationship changes twice a year, and the whole dataset
 * depends on some cron landing early enough that the job can WAIT for its
 * minute rather than arriving after it.
 *
 * That has now gone wrong twice, the same way both times:
 *
 *   2026-08-17  four runs reported success and captured nothing. Head start
 *               30 min; GitHub delivered +41 and +113.
 *   2026-08-28  the exit slot's delay jumped from ~80 min to ~241 and stayed
 *               there. Head start 180 min. It failed EVERY weekday for
 *               fifteen sessions, each one a permanently lost morning book.
 *
 * The lesson of the second is that `head start > worst drift` is not a
 * property you can pin, because the right-hand side moves without warning.
 * So the schedule no longer tries: four crons per window, spaced 100 minutes,
 * each covering a 200-minute band of delivery delay, overlapping two deep.
 *
 * These tests read the workflow and the recorder as TEXT and check the
 * arithmetic against a real summer date and a real winter one, rendering each
 * cron instant back into Eastern rather than trusting an offset.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "record-spreads.yml");
const RECORDER = path.join(ROOT, "scripts", "ingest", "recordSpreads.ts");

/** A weekday in each half of the year. Both are Mon-Fri, as the crons are. */
const SUMMER = "2026-08-17"; // EDT, UTC-4
const WINTER = "2026-01-15"; // EST, UTC-5

/**
 * The worst delivery delay MEASURED on this repository, not a guess.
 *
 *   2026-08-17  entry +41    exit +112
 *   2026-08-18  entry +80    exit +123
 *   2026-08-21  exit  +73    2026-08-26  exit +83
 *   2026-08-28 onward        exit +235..+251, every weekday
 *   2026-09-03..09-10        entry +148..+167
 *
 * The schedule must stay two-deep across all of it. This number has tripled
 * once already; when it rises again, this is the line to move, and moving it
 * will fail the coverage test until the crons are re-spaced.
 */
const WORST_OBSERVED_DRIFT_MIN = 251;

/** Redundancy floor. One cron covering a drift value is a single point of failure. */
const MIN_CRONS_COVERING = 2;

const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

/** Minutes past Eastern midnight for an instant, DST resolved by the tz database. */
function easternMinutes(at: Date): number {
  const p = Object.fromEntries(ET.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  return hour * 60 + Number(p.minute);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

interface Cron {
  expr: string;
  utcHour: number;
  utcMinute: number;
  window: ExecutionWindow;
}

/**
 * The workflow's OWN case statement, parsed rather than restated.
 *
 * The previous version of this file carried `expr === "35 10 * * 1-5" ?
 * "exit" : "entry"` — a second copy of the mapping, in a second language,
 * which would have gone on passing while the workflow filed morning quotes
 * under an afternoon minute. Two sources of truth for which cron is which
 * window is precisely the defect these tests exist to catch elsewhere.
 */
function windowMap(yml: string): Map<string, ExecutionWindow> {
  const block = yml.match(/case "\$SCHED" in([\s\S]*?)esac/);
  if (!block) throw new Error("could not find the schedule case statement in the workflow");
  const map = new Map<string, ExecutionWindow>();
  for (const arm of block[1].matchAll(/((?:"[^"]+"\|?)+)\)\s*WINDOW=(\w+)/g)) {
    const window = arm[2] as ExecutionWindow;
    for (const quoted of arm[1].split("|")) map.set(quoted.replace(/"/g, ""), window);
  }
  return map;
}

function crons(): Cron[] {
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  const map = windowMap(yml);
  return [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)]
    .map((m) => m[1])
    .map((expr) => {
      const window = map.get(expr);
      if (!window) throw new Error(`cron "${expr}" is scheduled but the case statement does not map it`);
      const [minute, hour] = expr.split(/\s+/);
      return { expr, utcHour: Number(hour), utcMinute: Number(minute), window };
    });
}

/** How many minutes before its first target a cron fires on a given date. */
function headStartMinutes(c: Cron, date: string): number {
  const fire = new Date(
    `${date}T${String(c.utcHour).padStart(2, "0")}:${String(c.utcMinute).padStart(2, "0")}:00Z`
  );
  return minutesOf(CAPTURE_MINUTES[c.window][0]) - easternMinutes(fire);
}

function numberFromSource(file: string, pattern: RegExp): number {
  const m = fs.readFileSync(file, "utf8").match(pattern);
  if (!m) throw new Error(`could not find ${pattern} in ${file}`);
  return Number(m[1]);
}

const ceilingMin = () => numberFromSource(RECORDER, /MAX_HEAD_START_MS\s*=\s*(\d+)\s*\*\s*60_000/);

/**
 * Would this cron actually capture, given a delivery delay of `drift`?
 *
 * Two ways to fail, and the job treats them differently. Arriving after the
 * target is a miss. Arriving more than the ceiling early means the runner
 * would doze past its own timeout, so the recorder exits without capturing.
 * Only the band between them works.
 */
function captures(c: Cron, date: string, drift: number): boolean {
  const effective = headStartMinutes(c, date) - drift;
  return effective > 0 && effective <= ceilingMin();
}

describe("the spread capture schedule", () => {
  it("maps every scheduled cron, and schedules every mapped cron", () => {
    const yml = fs.readFileSync(WORKFLOW, "utf8");
    const scheduled = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
    const mapped = [...windowMap(yml).keys()];
    // crons() throws on an unmapped cron; this catches the other direction —
    // a mapping left behind after its cron was removed or retimed.
    expect([...mapped].sort(), "case statement has an arm for a cron that is not scheduled").toEqual(
      [...scheduled].sort()
    );
  });

  it("covers both windows", () => {
    expect([...new Set(crons().map((c) => c.window))].sort()).toEqual(["entry", "exit"]);
  });

  /*
   * THE LOAD-BEARING ONE, and the whole reason the design changed.
   *
   * Not "does a cron fire early enough" — that question has a moving answer.
   * This asks whether, at EVERY delivery delay we have ever measured, at
   * least two crons would still capture. Two, not one: a seam where only a
   * single cron covers is a single point of failure, and the first version of
   * this schedule put such a seam at 140-180 minutes, which is exactly where
   * the entry slot has been running.
   */
  it.each([
    [SUMMER, "EDT"],
    [WINTER, "EST"],
  ])("stays two-deep across every observed drift on %s (%s)", (date) => {
    for (const window of ["entry", "exit"] as const) {
      const list = crons().filter((c) => c.window === window);
      for (let drift = 0; drift <= WORST_OBSERVED_DRIFT_MIN; drift++) {
        const n = list.filter((c) => captures(c, date, drift)).length;
        expect(
          n,
          `${window} on ${date}: only ${n} cron(s) capture at ${drift} min of delivery delay`
        ).toBeGreaterThanOrEqual(MIN_CRONS_COVERING);
      }
    }
  });

  /*
   * The bands must also touch beyond the observed range, or the schedule is
   * merely tuned to today's drift. Single coverage is acceptable out here —
   * this is margin, not the operating range.
   */
  it.each([
    [SUMMER, "EDT"],
    [WINTER, "EST"],
  ])("leaves no uncovered gap below the worst case on %s (%s)", (date) => {
    for (const window of ["entry", "exit"] as const) {
      const list = crons().filter((c) => c.window === window);
      const uncovered: number[] = [];
      for (let drift = 0; drift <= WORST_OBSERVED_DRIFT_MIN + 100; drift++) {
        if (!list.some((c) => captures(c, date, drift))) uncovered.push(drift);
      }
      expect(uncovered, `${window} on ${date} has holes at ${uncovered.slice(0, 5).join(",")} min`).toEqual([]);
    }
  });

  /*
   * A runner may doze at most the ceiling, then sit through the span of the
   * window itself. Below that the runner is killed mid-doze — which fails
   * loudly now, but still costs the session.
   */
  it("allows a runner to sleep through the longest permitted wait", () => {
    const timeout = numberFromSource(WORKFLOW, /timeout-minutes:\s*(\d+)/);
    for (const window of ["entry", "exit"] as const) {
      const targets = CAPTURE_MINUTES[window];
      const span = minutesOf(targets[targets.length - 1]) - minutesOf(targets[0]);
      expect(timeout, `${window} may doze ${ceilingMin()} min then span ${span} min`).toBeGreaterThan(
        ceilingMin() + span
      );
    }
  });

  /*
   * GitHub's hosted-runner job ceiling. The old single-cron design was drifting
   * toward needing a winter head start that would have exceeded it, which is
   * the constraint that makes "just fire earlier" a dead end rather than a
   * smaller version of the same fix.
   */
  it("stays inside GitHub's six-hour job limit", () => {
    expect(numberFromSource(WORKFLOW, /timeout-minutes:\s*(\d+)/)).toBeLessThanOrEqual(360);
  });
});
