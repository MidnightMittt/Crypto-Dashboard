import { CONSTANT_MATURITY_DAYS } from "../options/ivTermStructure";
import { ANNUALISATION_SESSIONS, IV_TENOR_SESSIONS, IvRvPoint, matchedLeg } from "./ivRv";
import { projectSessionsForward } from "./marketCalendar";
import { PanelObservation, panelBlockBootstrap, summarizePanel } from "./panelBootstrap";

/**
 * THE KILL LINE FOR `ivrv-option-screen`, WRITTEN BEFORE THE DATA ARRIVES.
 *
 * One CLSK call was bought on 2026-09-02 because implied vol sat at 83
 * against a trailing realized around 105 — a ratio near 0.79, which read as
 * "the option is cheap". It returned +$325 on a $135 premium. That trade is
 * in the round-trip log carrying `method.method_id = "ivrv-option-screen"`,
 * which is the only labelled trip we have.
 *
 * A profitable trade with a story attached is the most dangerous object in
 * this repository. It is indistinguishable, from the inside, from a method.
 * The only thing that separates them is a test written down BEFORE the data
 * that could settle it exists — because a test written afterwards is chosen,
 * consciously or not, from the family of tests the data happens to pass.
 *
 * Zero forward legs have resolved as of 2026-09-13. That is precisely why
 * this file ships today.
 *
 * ── What is pinned, and why each pin matters ──────────────────────────
 *
 * ONE trailing window. `TRAILING_WINDOWS` stores 10, 15 and 63 because which
 * belongs in the denominator was an open question at collection time. It is
 * closed here, in advance, at 15 — the window that matches the tenor implied
 * vol is interpolated to, so both sides of the ratio describe the same amount
 * of time. The other two are computed and reported as sensitivity and are
 * explicitly NOT allowed to rescue a dead result. Three windows scored and
 * the best one quoted is an argmax over three correlated specifications, and
 * this project has already watched that inflate a funding-band t to 1.90 that
 * was 1.14 standalone.
 *
 * ── The horizon was corrected on 2026-09-13, before any leg resolved ──
 *
 * This declaration originally said 21 sessions on both legs. That was a unit
 * error inherited from `IV_TENOR_SESSIONS`, which had been pinned to the
 * options module's `CONSTANT_MATURITY_DAYS` by a test comparing two integers
 * in different units: implied vol is interpolated to 21 CALENDAR days, and 21
 * SESSIONS is thirty calendar days. The corrected horizon is fifteen sessions
 * — three calendar weeks — and `ivRv.ts` carries the derivation.
 *
 * The correction reaches the four-window gate on 2026-11-16 instead of
 * 2026-12-21, and shortening a horizon to get an answer sooner is exactly the
 * move this file exists to prevent. Three things separate the two:
 *
 *   The reason is a unit mismatch, not a result. Zero forward legs had
 *   resolved when it was made, so there was no answer to shorten toward.
 *
 *   The rejected alternative was SHORTER still. The trading session proposed
 *   ten sessions, to match the CLSK position's holding period. Ten was refused
 *   — see below — and a search motivated by speed does not refuse the fastest
 *   option on the table.
 *
 *   Had the arithmetic gone the other way, 21 calendar days working out to 28
 *   sessions, the same correction would have shipped at a gate date in
 *   February. The audit script prints the power comparison for exactly this
 *   reason: to show the date was a consequence.
 *
 * ── Why not ten sessions, to match how the trade was held ─────────────
 *
 * Two reasons, and the second is the disqualifying one.
 *
 * The holding period is the wrong clock. CLSK was held seven sessions because
 * it was closed at a discretionary moment, and a horizon fitted to a realised
 * exit is a barrier chosen by the outcome — winners close early, losers get
 * held, and the register already carries that failure under
 * `outcomes-must-enter-the-sample-together`. The clock known AT ENTRY is the
 * contract's, and CLSK's was 17 calendar days: nearer fifteen than ten.
 *
 * And a ten-session leg against a 21-calendar-day implied number would be
 * measuring realized vol over a window SHORTER than the tenor. The days in the
 * gap are priced by IV and invisible to RV, so a name with an event in them
 * gets a high screen ratio and a low premium at once — a negative contribution
 * to the correlation, which is the sign this screen predicted in advance. The
 * shared-IV artefact named further down is tolerable because it pushes against
 * the hypothesis. A mismatch that pushes FOR it is not tolerable at any size,
 * and the direction is what rules ten out rather than the magnitude.
 *
 * A properly tenored ten-session leg would need implied vol interpolated to
 * 14 DTE, which the chain does bracket. It is not available retroactively:
 * `positioningHistory.json` stores only the constant-maturity number, and
 * CBOE's delayed chain has no date parameter, so the 634 readings already
 * banked cannot be re-tenored. That leg is a new collector and a new series
 * starting from zero, not a re-reading of this one.
 *
 * ONE statistic. The within-date rank correlation between the screen and the
 * realised variance premium. No threshold — a threshold is a fourth free
 * parameter and there is no evidence with which to choose one.
 *
 * ONE sign, declared. Low screen ratio should predict a HIGH premium, so the
 * correlation must come out NEGATIVE. A significant positive correlation is
 * not a pass with the story rewritten; it is a kill, and it is recorded as
 * one below.
 *
 * ── Why the statistic is centred WITHIN each date ─────────────────────
 *
 * Vol is overwhelmingly a common factor. A market-wide vol expansion lifts
 * the forward leg of all ninety-odd names at once, and an uncentred statistic
 * would mostly measure whether that expansion happened to occur — one event,
 * scored ninety times. Ranking inside the date removes the common factor and
 * leaves the only question the screen actually asks, which is a
 * cross-sectional one: given today's names, does the ratio tell you WHICH to
 * buy. That is what was done on 2026-09-02, when CLSK was picked over the
 * other ninety-five.
 *
 * ── The gate is denominated in independent windows, not rows ──────────
 *
 * The trading session proposed evaluating at n>=100 resolved. That number is
 * kept — as a NECESSARY condition — but it cannot be the gate, and the reason
 * is arithmetic rather than a matter of taste:
 *
 *   The first rows resolve on one observation date, not many.
 *   n>=100 is first reached on the third observation date.
 *   The forward window is 15 sessions. The ten observation dates collected so
 *   far span 14 sessions end to end — LESS THAN ONE non-overlapping window.
 *
 * So "n >= 100 resolved" describes roughly one and a half independent bets
 * dressed as a hundred. Firing a kill line on it, in either direction, would
 * be the same error the round-trip log's `closed-only` blocker names and the
 * same one the overlap corrections in `overlap.ts` exist to prevent. The gate
 * below therefore counts observation dates whose forward windows do not
 * overlap, and the interval is produced by a block bootstrap over date slices
 * rather than by a formula over the row count.
 *
 * ── The consequence is mechanical ─────────────────────────────────────
 *
 * `classification` is a value this module computes, not a sentence somebody
 * remembers to edit. The day the test can run, the register's label for the
 * CLSK trip changes without anyone touching prose — which is the only version
 * of a pre-declared kill line that survives contact with a busy week.
 *
 * @see ivRv.ts — the collector, which deliberately holds no threshold
 * @see roundTrips.ts — the log carrying the one labelled trip this judges
 */

/** Minimum resolved observations on a date before its rank correlation is formed. */
export const MIN_CROSS_SECTION = 5;

/**
 * Independent forward windows required before any verdict is possible.
 *
 * Four is a floor, not a comfort. Below four the bootstrap has three or fewer
 * distinct blocks to draw from and its interval is an artefact of the
 * resampling scheme rather than a measurement. Four is the point at which
 * "the interval contains zero" starts to mean something about the world.
 *
 * Reaching four takes three further horizons of collection past the first
 * resolution. The date is computed rather than written down here — see
 * `sessionsUntilEvaluable` — because a distance stated in prose stops being
 * recomputed the moment the horizon or the collection cadence changes, and
 * both have already changed once.
 */
export const MIN_INDEPENDENT_WINDOWS = 4;

/** Resolved rows required. The trading session's number, kept as necessary-not-sufficient. */
export const MIN_RESOLVED = 100;

export type ScreenClassification = "screened-method" | "one-lucky-read" | "undetermined";

export interface IvRvScreenDeclaration {
  /** Joins `method.method_id` in ~/trading/roundtrips.jsonl. */
  id: "ivrv-option-screen";
  declaredOn: string;
  statement: string;
  /** Pinned in advance. The other windows are sensitivity, never the test. */
  primaryTrailingWindow: number;
  sensitivityWindows: number[];
  horizonSessions: number;
  /** Why this clock and not another — the answer to the only free parameter left. */
  horizonRationale: string;
  statistic: string;
  /** -1: the screen claims a LOW ratio predicts a HIGH realised premium. */
  predictedSign: -1;
  minimumResolved: number;
  minimumIndependentWindows: number;
  killCriteria: string;
  /** What each verdict does to the CLSK trip's label in the register. */
  consequence: Record<"survives" | "inside-noise", ScreenClassification>;
}

export const IVRV_SCREEN_DECLARATION: IvRvScreenDeclaration = {
  id: "ivrv-option-screen",
  declaredOn: "2026-09-13",
  statement:
    "Among the names quoted on a given session, the ones whose implied vol sits lowest " +
    "against their own trailing realized vol go on to realize the most vol relative to " +
    "what was implied. If that is true the screen is a method; if it is not, the CLSK " +
    "trade was a good outcome from an uninformative reading.",
  primaryTrailingWindow: IV_TENOR_SESSIONS,
  sensitivityWindows: [10, 63],
  horizonSessions: IV_TENOR_SESSIONS,
  horizonRationale:
    `${IV_TENOR_SESSIONS} sessions because implied vol is interpolated to a ${CONSTANT_MATURITY_DAYS}-` +
    `calendar-day tenor, and ${CONSTANT_MATURITY_DAYS} calendar days is three calendar weeks. ` +
    "Corrected on the declaration date from 21 sessions, which was the calendar number reused " +
    "as a session count and would have scored a three-week forecast against thirty calendar " +
    "days of realisation. No forward leg had resolved when the correction was made.",
  statistic:
    "Observation-weighted mean of the per-session Spearman correlation between the screen " +
    `ratio (IV / trailing RV, ${IV_TENOR_SESSIONS} sessions) and the realised variance premium ` +
    `(ln(forward RV / IV) over the following ${IV_TENOR_SESSIONS} sessions). Ranks are midranks; ` +
    "both legs are ranked inside their own session, so the common vol factor is removed and only " +
    "the cross-sectional question survives.",
  predictedSign: -1,
  minimumResolved: MIN_RESOLVED,
  minimumIndependentWindows: MIN_INDEPENDENT_WINDOWS,
  killCriteria:
    `Evaluated once BOTH gates are met: at least ${MIN_RESOLVED} resolved observations AND at ` +
    `least ${MIN_INDEPENDENT_WINDOWS} non-overlapping ${IV_TENOR_SESSIONS}-session forward ` +
    "windows. If the 95% block-bootstrap interval on the correlation then contains zero, or the " +
    "correlation is significant with the WRONG sign, the screen is inside its own noise floor " +
    "and the CLSK trade is reclassified in the register from a screened method to one lucky " +
    "read. The 10- and 63-session windows are reported alongside and cannot overturn this — a " +
    "result that needs the argmax of three correlated windows is the argmax, not the result.",
  consequence: { survives: "screened-method", "inside-noise": "one-lucky-read" },
};

/**
 * Horizons the gate date is reported at, so "when can this speak" is
 * answerable per-clock rather than as a single number.
 *
 * These are NOT four tests. Exactly one — `horizonSessions` — is declared, and
 * only it will ever produce a correlation. The others are here because the
 * trading session asked how the answer's date moves with the clock, and
 * because the most useful thing this table does is make the argmax hazard
 * visible: a reader can see that the declared horizon is not the one that
 * would have spoken soonest, which is the check they would otherwise have to
 * take on trust.
 *
 * 5 and 10 are below the tenor and would measure realized vol over a window
 * the implied number outlives. 21 is the uncorrected default. Their dates are
 * shown; their correlations are not computed, here or anywhere.
 */
export const REPORTED_HORIZONS = [5, 10, IV_TENOR_SESSIONS, 21] as const;

export interface HorizonGateRow {
  horizonSessions: number;
  /** Trading sessions expressed back in calendar days, rounded to one place. */
  calendarDays: number;
  /** Non-overlapping windows the observations already collected are worth. */
  independentWindows: number;
  /** Best case from the latest observation, if collection continues every session. */
  sessionsUntilGate: number | null;
  evaluableDate: string | null;
  declared: boolean;
  /** Why this row is not the declared one. Empty on the declared row. */
  note: string;
}

/** One condition the verdict is waiting on, with the numbers that make it checkable. */
export interface ScreenGate {
  id: "resolved-rows" | "independent-windows" | "sessions-with-statistic";
  have: number;
  need: number;
  met: boolean;
  detail: string;
}

export interface IvRvScreenStanding {
  declaration: IvRvScreenDeclaration;
  /** Resolved observations carrying a computable screen at the pinned window. */
  resolved: number;
  /** Distinct observation sessions among them. */
  sessions: number;
  /** Sessions wide enough to form a rank correlation. */
  sessionsWithStatistic: number;
  /** Observation sessions whose forward windows do not overlap. The honest sample size. */
  independentWindows: number;
  /** Date slices a block must span to cover one forward window. */
  blockPeriods: number;
  /**
   * Best-case sessions from the latest observation until the window gate could
   * be met, if collection continues every session. Null with no observations.
   */
  earliestEvaluableInSessions: number | null;
  /**
   * That best case as a calendar date, on the same declared market calendar
   * the resolution schedule projects against. Null when it cannot be dated.
   */
  earliestEvaluableDate: string | null;
  /**
   * The same best case at every horizon in `REPORTED_HORIZONS`, so the clock
   * is visible as a choice. One row is declared; none of the others is ever
   * scored.
   */
  horizonCalendar: HorizonGateRow[];
  gates: ScreenGate[];
  /** Null until every gate is met. Nothing is computed early, not even privately. */
  result: ScreenResult | null;
  verdict: "waiting" | "survives" | "inside-noise";
  classification: ScreenClassification;
  /** One sentence, generated from the numbers above so it cannot drift from them. */
  reading: string;
}

export interface ScreenResult {
  /** The pinned-window statistic. Negative is the predicted direction. */
  correlation: number;
  lower: number;
  upper: number;
  bootstrapSe: number;
  /** Implied by the bootstrap variance; never composed from separate factors. */
  effectiveN: number;
  containsZero: boolean;
  signAsPredicted: boolean;
  /** The 10- and 63-session windows. Reported; explicitly not determinative. */
  sensitivity: { windowSessions: number; correlation: number }[];
}

/** Midranks — ties share the average of the positions they span. @see positioning.ts */
function midranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].i] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Per-observation terms whose MEAN over a session is that session's Spearman
 * correlation, and whose mean over the panel is the statistic.
 *
 * Expressed this way on purpose: it makes the correlation an ordinary panel
 * mean, so `panelBlockBootstrap` — the estimator already used for every other
 * dependence-corrected number on this site — applies unchanged, and the
 * correlation and its interval come from one code path rather than two.
 *
 * Returns an empty array for a session whose ranks are degenerate on either
 * leg (every value tied), because a correlation is undefined there rather
 * than zero.
 */
export function sessionTerms(x: readonly number[], y: readonly number[]): number[] {
  const n = x.length;
  if (n < MIN_CROSS_SECTION) return [];
  const rx = midranks(x);
  const ry = midranks(y);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  const sd = (a: number[], m: number) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  const sx = sd(rx, mx);
  const sy = sd(ry, my);
  if (sx === 0 || sy === 0) return [];
  return rx.map((r, i) => ((r - mx) * (ry[i] - my)) / (sx * sy));
}

/**
 * Observation dates whose forward windows do not overlap.
 *
 * Greedy from the earliest: take a date, discard every date inside its
 * horizon, take the next survivor. This is the count that determines how much
 * the data can say, and it is the number the row count is usually mistaken
 * for.
 */
export function countIndependentWindows(
  sessionIndices: readonly number[],
  horizonSessions: number
): number {
  const sorted = [...new Set(sessionIndices)].sort((a, b) => a - b);
  let count = 0;
  let cursor = -Infinity;
  for (const idx of sorted) {
    if (idx >= cursor) {
      count++;
      cursor = idx + horizonSessions;
    }
  }
  return count;
}

/**
 * Date slices a bootstrap block must span to cover one forward window.
 *
 * The widest cluster of observation dates falling inside any single horizon.
 * Taking the maximum rather than the median is deliberate: a block shorter
 * than the true dependence horizon under-corrects, and under-correcting is
 * the failure that publishes a t-statistic. Over-correcting only widens the
 * interval, which costs nothing but patience.
 */
export function blockPeriodsFor(
  sessionIndices: readonly number[],
  horizonSessions: number
): number {
  const sorted = [...new Set(sessionIndices)].sort((a, b) => a - b);
  let widest = 1;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] < sorted[i] + horizonSessions) j++;
    widest = Math.max(widest, j - i + 1);
  }
  return widest;
}

/**
 * Sessions from the latest observation until the declared window gate COULD
 * be met, assuming collection continues on every session from here.
 *
 * A best case, and labelled as one wherever it is shown. It exists because
 * "not yet" is not an answer anybody can plan around, and because the honest
 * distance is the most surprising number in this file: the first tranche of
 * resolutions all land on a single observation date and are worth ONE window
 * between them, so the gate is months past the day the row count clears, not
 * days. No figure here is written as a literal — every count and date the
 * panel shows is computed from the observations actually banked, because the
 * two that were once hard-coded in prose both went stale the same afternoon
 * the horizon was corrected.
 *
 * Returns null when there are no observations to anchor from.
 */
export function sessionsUntilEvaluable(
  sessionIndices: readonly number[],
  horizonSessions: number,
  needWindows: number
): number | null {
  const sorted = [...new Set(sessionIndices)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const latest = sorted[sorted.length - 1];

  /* The anchors already collected, by the same greedy rule as the gate. */
  let anchors = 0;
  let cursor = -Infinity;
  let lastAnchor = sorted[0];
  for (const idx of sorted) {
    if (idx >= cursor) {
      anchors++;
      lastAnchor = idx;
      cursor = idx + horizonSessions;
    }
  }
  /* Each further window needs a fresh anchor one whole horizon later. */
  while (anchors < needWindows) {
    lastAnchor += horizonSessions;
    anchors++;
  }
  /* The last anchor's own forward leg still has to resolve. */
  return Math.max(0, lastAnchor + horizonSessions - latest);
}

/**
 * The gate date at every reported horizon, from the observation dates already
 * banked.
 *
 * Every row is arithmetic over the SAME anchors — no row involves the screen,
 * the premium, or implied vol, so building the whole table reveals nothing
 * about any answer. What it reveals is the shape of the tradeoff, which is the
 * thing a reader needs in order to judge whether the declared clock was chosen
 * for a reason.
 */
function buildHorizonCalendar(
  allPeriods: readonly number[],
  dateAfter: (sessions: number | null) => string | null
): HorizonGateRow[] {
  const declared = IVRV_SCREEN_DECLARATION.horizonSessions;
  return REPORTED_HORIZONS.map((h) => {
    const sessionsUntilGate = sessionsUntilEvaluable(
      allPeriods,
      h,
      IVRV_SCREEN_DECLARATION.minimumIndependentWindows
    );
    return {
      horizonSessions: h,
      calendarDays: Math.round((h * 365 * 10) / ANNUALISATION_SESSIONS) / 10,
      independentWindows: countIndependentWindows(allPeriods, h),
      sessionsUntilGate,
      evaluableDate: dateAfter(sessionsUntilGate),
      declared: h === declared,
      note: horizonNote(h, declared),
    };
  });
}

function horizonNote(h: number, declared: number): string {
  if (h === declared) return "";
  if (h < declared) {
    return (
      "Shorter than the implied tenor. The days in the gap are priced by IV and invisible to " +
      "realized vol, which pushes high-screen names toward low premiums — the predicted sign, " +
      "manufactured by the mismatch. Refused for that reason, not for its date."
    );
  }
  return (
    "The uncorrected default: the 21 in the calendar-day tenor reused as a session count. " +
    "Scores a three-week forecast against thirty calendar days of realisation."
  );
}

/** The screen value at a given trailing window, or null if it is not computable. */
function screenAt(point: IvRvPoint, windowSessions: number): number | null {
  if (windowSessions === IV_TENOR_SESSIONS) return matchedLeg(point)?.ratio ?? null;
  return point.trailing.find((l) => l.windowSessions === windowSessions)?.ratio ?? null;
}

/**
 * The realised variance premium, in logs.
 *
 * Positive means realized vol exceeded what was implied — the long-vol buyer
 * was right. Derived from `forwardRatio` rather than recomputed from the two
 * vols so that this and the collector cannot disagree about what the ratio is.
 *
 * A note on the one artefact in this construction, stated because it is
 * easier to defend a bias you have named: implied vol appears in the
 * denominator of the screen and in the numerator of the premium, so a name
 * with unusually high IV is pushed toward a LOW screen and a LOW premium at
 * once. That is a POSITIVE contribution to the correlation, and the predicted
 * sign is negative — so the shared term biases the test against the
 * hypothesis, never toward it. A surviving negative correlation cannot have
 * been manufactured by it.
 */
function premiumOf(point: IvRvPoint): number | null {
  const fr = point.forwardRatio;
  if (fr === null || !(fr > 0)) return null;
  return -Math.log(fr);
}

interface ScreenRow {
  period: number;
  unitId: string;
  screen: number;
  premium: number;
}

function correlationOver(rows: readonly ScreenRow[]): {
  statistic: number;
  observations: PanelObservation[];
} {
  const byPeriod = new Map<number, ScreenRow[]>();
  for (const r of rows) {
    const bucket = byPeriod.get(r.period);
    if (bucket) bucket.push(r);
    else byPeriod.set(r.period, [r]);
  }
  const observations: PanelObservation[] = [];
  for (const [period, bucket] of byPeriod) {
    const terms = sessionTerms(
      bucket.map((b) => b.screen),
      bucket.map((b) => b.premium)
    );
    if (terms.length === 0) continue;
    bucket.forEach((b, i) => observations.push({ period, unitId: b.unitId, value: terms[i] }));
  }
  const statistic =
    observations.length === 0
      ? 0
      : observations.reduce((s, o) => s + o.value, 0) / observations.length;
  return { statistic, observations };
}

const BOOTSTRAP_ITERATIONS = 4000;
const BOOTSTRAP_SEED = 20260913;

/**
 * Evaluate the declared screen against whatever has resolved.
 *
 * `sessionIndexOf` maps an observation date to its position in the panel
 * calendar. Passed in rather than inferred from the date string: calendar
 * days are not sessions, and a horizon measured in the wrong unit is exactly
 * the kind of error that makes a gate look met when it is not.
 */
export function evaluateIvRvScreen(
  points: readonly IvRvPoint[],
  sessionIndexOf: (date: string) => number | undefined
): IvRvScreenStanding {
  const d = IVRV_SCREEN_DECLARATION;

  const rows: ScreenRow[] = [];
  const sensitivityRows = new Map<number, ScreenRow[]>();
  for (const w of d.sensitivityWindows) sensitivityRows.set(w, []);

  for (const p of points) {
    const premium = premiumOf(p);
    if (premium === null) continue;
    const period = sessionIndexOf(p.date);
    if (period === undefined) continue;
    const screen = screenAt(p, d.primaryTrailingWindow);
    if (screen !== null) rows.push({ period, unitId: p.symbol, screen, premium });
    for (const w of d.sensitivityWindows) {
      const s = screenAt(p, w);
      if (s !== null) sensitivityRows.get(w)!.push({ period, unitId: p.symbol, screen: s, premium });
    }
  }

  const periods = [...new Set(rows.map((r) => r.period))];
  const independentWindows = countIndependentWindows(periods, d.horizonSessions);
  const blockPeriods = blockPeriodsFor(periods, d.horizonSessions);

  /*
   * The projection counts EVERY observation date, resolved or not. The gate
   * counts only resolved ones. Using the resolved set for both would say the
   * clock has not started until the first forward leg lands, when in fact
   * every reading already taken is an anchor waiting to mature.
   */
  const allPeriods = points
    .map((p) => sessionIndexOf(p.date))
    .filter((i): i is number => i !== undefined);
  const earliestEvaluableInSessions = sessionsUntilEvaluable(
    allPeriods,
    d.horizonSessions,
    d.minimumIndependentWindows
  );
  const latestDate = points.map((p) => p.date).sort().at(-1) ?? null;
  const dateAfter = (sessions: number | null): string | null =>
    latestDate !== null && sessions !== null
      ? projectSessionsForward(latestDate, sessions).date
      : null;
  const earliestEvaluableDate = dateAfter(earliestEvaluableInSessions);

  const horizonCalendar = buildHorizonCalendar(allPeriods, dateAfter);

  const primary = correlationOver(rows);
  const sessionsWithStatistic = summarizePanel(primary.observations).periods;

  const gates: ScreenGate[] = [
    {
      id: "resolved-rows",
      have: rows.length,
      need: d.minimumResolved,
      met: rows.length >= d.minimumResolved,
      detail:
        `Resolved observations carrying a computable screen at the pinned ${d.primaryTrailingWindow}-` +
        "session window. Necessary, and on its own worth very little — the first tranche of them " +
        "all land on a single observation date and are therefore one window between them.",
    },
    {
      id: "independent-windows",
      have: independentWindows,
      need: d.minimumIndependentWindows,
      met: independentWindows >= d.minimumIndependentWindows,
      detail:
        `Observation sessions whose ${d.horizonSessions}-session forward windows do not ` +
        "overlap. This is the binding gate and the one a row count is normally mistaken " +
        "for: dates a few sessions apart share almost their entire forward window and are " +
        "very nearly the same measurement.",
    },
    {
      id: "sessions-with-statistic",
      have: sessionsWithStatistic,
      need: 2,
      met: sessionsWithStatistic >= 2,
      detail:
        `Sessions holding at least ${MIN_CROSS_SECTION} resolved names, which is the minimum ` +
        "for a cross-sectional rank correlation to exist at all. One such session is a " +
        "single draw, not a distribution.",
    },
  ];

  const open = gates.filter((g) => !g.met);
  if (open.length > 0) {
    return {
      declaration: d,
      resolved: rows.length,
      sessions: periods.length,
      sessionsWithStatistic,
      independentWindows,
      blockPeriods,
      earliestEvaluableInSessions,
      earliestEvaluableDate,
      horizonCalendar,
      gates,
      result: null,
      verdict: "waiting",
      classification: "undetermined",
      reading: waitingReading(rows.length, periods.length, independentWindows, open),
    };
  }

  const distribution = panelBlockBootstrap(
    primary.observations,
    blockPeriods,
    BOOTSTRAP_ITERATIONS,
    BOOTSTRAP_SEED
  );
  const mean = distribution.reduce((a, b) => a + b, 0) / distribution.length;
  const variance =
    distribution.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, distribution.length - 1);
  const bootstrapSe = Math.sqrt(variance);
  const sorted = [...distribution].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  const lower = pick(0.025);
  const upper = pick(0.975);
  const containsZero = lower <= 0 && upper >= 0;
  const signAsPredicted = Math.sign(primary.statistic) === d.predictedSign;

  /*
   * Effective N inverted from the realised bootstrap variance, the same way
   * panelBootstrapProportion does it, so temporal and cross-sectional
   * dependence cannot be charged for twice. The spread of a correlation term
   * is its own sample variance rather than p(1-p).
   */
  const termMean = primary.statistic;
  const termVar =
    primary.observations.reduce((s, o) => s + (o.value - termMean) ** 2, 0) /
    Math.max(1, primary.observations.length - 1);
  const effectiveN =
    bootstrapSe > 0 && termVar > 0
      ? Math.min(primary.observations.length, termVar / (bootstrapSe * bootstrapSe))
      : independentWindows;

  const result: ScreenResult = {
    correlation: primary.statistic,
    lower,
    upper,
    bootstrapSe,
    effectiveN,
    containsZero,
    signAsPredicted,
    sensitivity: d.sensitivityWindows.map((w) => ({
      windowSessions: w,
      correlation: correlationOver(sensitivityRows.get(w)!).statistic,
    })),
  };

  const survives = !containsZero && signAsPredicted;
  const verdict = survives ? "survives" : "inside-noise";
  return {
    declaration: d,
    resolved: rows.length,
    sessions: periods.length,
    sessionsWithStatistic,
    independentWindows,
    blockPeriods,
    earliestEvaluableInSessions,
    earliestEvaluableDate,
    horizonCalendar,
    gates,
    result,
    verdict,
    classification: d.consequence[verdict],
    reading: verdictReading(result, verdict, independentWindows),
  };
}

function waitingReading(
  resolved: number,
  sessions: number,
  independentWindows: number,
  open: readonly ScreenGate[]
): string {
  if (resolved === 0) {
    return (
      "No forward leg has resolved, so the screen has not been tested and this is not a " +
      "claim that it works. The test above was written down first, which is the only thing " +
      "that will make its answer worth anything."
    );
  }
  const missing = open
    .map((g) => `${g.id.replace(/-/g, " ")} ${g.have} of ${g.need}`)
    .join("; ");
  return (
    `${resolved} observations across ${sessions} session${sessions === 1 ? "" : "s"} have ` +
    `resolved, worth ${independentWindows} independent forward window` +
    `${independentWindows === 1 ? "" : "s"}. The declared test cannot run yet: ${missing}. ` +
    "Until it does, the CLSK trade is neither a method nor a lucky read — it is unjudged, " +
    "and nothing on this site should be sized as though it were more."
  );
}

function verdictReading(
  r: ScreenResult,
  verdict: "survives" | "inside-noise",
  independentWindows: number
): string {
  const interval = `[${r.lower.toFixed(3)}, ${r.upper.toFixed(3)}]`;
  const sens = r.sensitivity
    .map((s) => `${s.windowSessions}d ${s.correlation.toFixed(3)}`)
    .join(", ");
  if (verdict === "survives") {
    return (
      `The screen holds. Correlation ${r.correlation.toFixed(3)}, 95% interval ${interval} ` +
      `over ${independentWindows} independent windows, in the direction declared in advance. ` +
      `Sensitivity windows, which had no vote: ${sens}. The CLSK trade stays classified as a ` +
      "screened method."
    );
  }
  const why = r.containsZero
    ? `its 95% interval ${interval} contains zero`
    : `it points the wrong way — ${r.correlation.toFixed(3)}, against a sign declared negative before the data existed`;
  return (
    `The screen is inside its own noise floor: ${why}, over ${independentWindows} independent ` +
    `windows. Sensitivity windows, which do not get a vote: ${sens}. Per the criterion declared ` +
    "on 2026-09-13, the CLSK trade is reclassified from a screened method to one lucky read."
  );
}
