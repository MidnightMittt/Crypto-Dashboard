import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CAPTURE_MINUTES, ExecutionWindow } from "./spreadHistory";

/**
 * THE CAPTURE SCHEDULE IS ARITHMETIC, AND ARITHMETIC ROTS.
 *
 * The spread recorder's crons are UTC; its targets are Eastern wall-clock
 * minutes. The relationship between them changes twice a year, and the whole
 * dataset depends on every cron landing EARLY enough that the job can wait for
 * its minute instead of arriving after it.
 *
 * That went wrong once already. On 2026-08-17 four scheduled runs reported
 * success and captured nothing, because the head start was 30 minutes and
 * GitHub delivered the crons 41 and 113 minutes late. Nothing failed, so
 * nothing was noticed.
 *
 * So this reads the workflow and the recorder as TEXT and checks the
 * arithmetic against a real summer date and a real winter one, rendering each
 * cron instant back into Eastern rather than trusting an offset. A change to
 * either file that breaks the relationship fails here instead of silently
 * costing sessions.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "record-spreads.yml");
const RECORDER = path.join(ROOT, "scripts", "ingest", "recordSpreads.ts");

/** A weekday in each half of the year. Both are Mon-Fri, as the crons are. */
const SUMMER = "2026-08-17"; // EDT, UTC-4
const WINTER = "2026-01-15"; // EST, UTC-5

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

function crons(): Cron[] {
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  const found = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
  return found.map((expr) => {
    const [minute, hour] = expr.split(/\s+/);
    return {
      expr,
      utcHour: Number(hour),
      utcMinute: Number(minute),
      // Mirrors the workflow's own case statement: the morning cron is the
      // exit window, anything else is entry.
      window: (expr === "5 12 * * 1-5" ? "exit" : "entry") as ExecutionWindow,
    };
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

describe("the spread capture schedule", () => {
  /*
   * The single most important invariant. Two crons per window is what capped
   * the head start at 45 minutes: a longer one would have let the second cron
   * capture too. Collapsing to one is what bought the tolerance, so a second
   * one reappearing must not pass quietly.
   */
  it("declares exactly one cron per execution window", () => {
    const byWindow = new Map<ExecutionWindow, Cron[]>();
    for (const c of crons()) {
      byWindow.set(c.window, [...(byWindow.get(c.window) ?? []), c]);
    }
    expect([...byWindow.keys()].sort()).toEqual(["entry", "exit"]);
    for (const [window, list] of byWindow) {
      expect(list, `${window} should have exactly one cron`).toHaveLength(1);
    }
  });

  /*
   * A cron that fires AFTER its first target can never capture it — the job
   * refuses to back-stamp, correctly, so the session is simply lost. This must
   * hold in both halves of the year from one fixed UTC time.
   */
  it.each([
    [SUMMER, "EDT"],
    [WINTER, "EST"],
  ])("fires before every target on %s (%s)", (date) => {
    for (const c of crons()) {
      const head = headStartMinutes(c, date);
      expect(head, `${c.expr} (${c.window}) must fire before ${CAPTURE_MINUTES[c.window][0]} ET`).toBeGreaterThan(0);
    }
  });

  /*
   * ...and not so far ahead that the recorder's own guard rejects it. The
   * guard exists to catch a cron aimed at the wrong time of day; it must not
   * catch the real ones in winter, when the head start is an hour longer.
   */
  it("keeps every head start inside the recorder's ceiling", () => {
    const ceilingMin = numberFromSource(RECORDER, /MAX_HEAD_START_MS\s*=\s*(\d+)\s*\*\s*60_000/) ;
    for (const date of [SUMMER, WINTER]) {
      for (const c of crons()) {
        expect(headStartMinutes(c, date), `${c.expr} on ${date}`).toBeLessThanOrEqual(ceilingMin);
      }
    }
  });

  /*
   * The winter head start is the long one, and the job sleeps through all of
   * it plus the span of the window. A timeout below that kills the runner
   * mid-doze every day from November to March — and it would fail LOUDLY now,
   * which is better than the old silence but still a lost session.
   */
  it("allows a runner to sleep through the longest winter wait", () => {
    const timeout = numberFromSource(WORKFLOW, /timeout-minutes:\s*(\d+)/);
    for (const c of crons()) {
      const targets = CAPTURE_MINUTES[c.window];
      const untilLast = headStartMinutes(c, WINTER) + (minutesOf(targets[targets.length - 1]) - minutesOf(targets[0]));
      expect(timeout, `${c.window} needs ${untilLast} min of sleep in winter`).toBeGreaterThan(untilLast);
    }
  });

  /*
   * The measured drift that caused the outage was 113 minutes. This does not
   * demand the schedule survive that — it records what the schedule currently
   * tolerates, so a change that quietly halves it has to say so.
   */
  it("tolerates at least an hour of cron drift in the worse (summer) half", () => {
    for (const c of crons()) {
      expect(headStartMinutes(c, SUMMER), `${c.window} drift tolerance`).toBeGreaterThanOrEqual(60);
    }
  });
});
