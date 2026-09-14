import { REACH_HORIZON_SESSIONS } from "./forwardReach";
import { excursionStats } from "./exitDesign";
import type { BarsPanel } from "./barsPanel";
import type { Bar } from "./types";
import {
  MIN_CROSS_SECTION,
  blockPeriodsFor,
  countIndependentWindows,
  sessionTerms,
  sessionsUntilEvaluable,
} from "./ivRvScreen";
import { PanelObservation, panelBlockBootstrap } from "./panelBootstrap";

/**
 * THE FORWARD RECORD FOR `asymmetry-excursion-screen`, DECLARED AT ZERO.
 *
 * The contracts screen carries `asymmetry_ratio` as an unvalidated column —
 * the trading session's original instinct was to RANK by it, which was
 * refused because reach probability is the only column with a forward
 * record. This file is how the column earns or fails a record of its own.
 *
 * ── What is shared with reach, and what is deliberately not ──────────
 *
 * SHARED: the resolution calendar. Outcomes resolve on the same
 * 10-session clock reach uses (`REACH_HORIZON_SESSIONS`, imported rather
 * than restated), on the same panel sessions, all names of a session
 * together — resolution is purely bars-reaching-far-enough, so a hit can
 * never enter the sample before a miss.
 *
 * SEPARATE: the declaration, the record, and the gate. This record starts
 * at zero observations on the declaration date and earns independence
 * windows one horizon at a time. Nothing here may ever be cited as
 * independent corroboration of the reach record or vice versa: the two
 * share resolution windows, so their agreement is ONE piece of evidence.
 *
 * ── Why the record is forward-only when every input is historical ────
 *
 * Both legs are pure functions of `barsPanel.json`, so a backfilled
 * "record" over 300 sessions could be generated tonight. It would also be
 * an in-sample study wearing a forward record's clothes — the declaration
 * date is what makes a forward record evidence (`declaration-date splits
 * the record`: the overnight premium read +30bp in-sample and -37bp since
 * declared, and both were always true). So `buildAsymmetryObservations`
 * refuses sessions before `declaredOn`, and `evaluateAsymmetryScreen`
 * re-checks the boundary rather than trusting its caller.
 *
 * ── The one free parameter this design does NOT have ─────────────────
 *
 * IV/RV had a free trailing window and pinned it in advance. This screen
 * has no analogue: the horizon is reach's by declaration (sharing the
 * calendar IS the point), and the ratio's lookback is the committed
 * panel's depth, which is fixed upstream. There is no sensitivity table
 * because there is nothing to be sensitive to.
 */

export const ASYMMETRY_HORIZON_SESSIONS = REACH_HORIZON_SESSIONS;

/** Resolved observations required. Necessary, never sufficient. */
export const ASYMMETRY_MIN_RESOLVED = 100;
/** Non-overlapping forward windows required. The binding gate, as it was for IV/RV. */
export const ASYMMETRY_MIN_INDEPENDENT_WINDOWS = 4;

export interface AsymmetryScreenDeclaration {
  id: "asymmetry-excursion-screen";
  declaredOn: string;
  statement: string;
  horizonSessions: number;
  horizonRationale: string;
  ratioDefinition: string;
  outcomeDefinition: string;
  statistic: string;
  /** +1: a higher ratio claims a more up-favourable forward excursion balance. */
  predictedSign: 1;
  minimumResolved: number;
  minimumIndependentWindows: number;
  killCriteria: string;
  consequence: Record<"survives" | "inside-noise", string>;
  corroborationNote: string;
}

export const ASYMMETRY_SCREEN_DECLARATION: AsymmetryScreenDeclaration = {
  id: "asymmetry-excursion-screen",
  declaredOn: "2026-09-14",
  statement:
    "Among the panel names on a given session, the ones whose own history shows the most " +
    "up-favourable excursion asymmetry go on to realize a more up-favourable excursion " +
    "balance over the following ten sessions. If that is true the column may be PROPOSED " +
    "as a ranking input — a separate decision with its own review. If it is not, the " +
    "column stays descriptive and the rank-by-asymmetry instinct is closed as refuted.",
  horizonSessions: ASYMMETRY_HORIZON_SESSIONS,
  horizonRationale:
    "Ten sessions because that is reach's clock and sharing the resolution calendar is " +
    "declared policy: one calendar, two records, agreement counted once. A horizon chosen " +
    "separately would have been a second free parameter and a second argmax.",
  ratioDefinition:
    "excursionStats(bars, 10).upMedianPct / |downMedianPct| over the symbol's real panel " +
    "bars (interpolated fills excluded), exactly the arithmetic the contracts screen " +
    "serves in its asymmetry_ratio column — the record scores the number the page shows, " +
    "not a cousin of it. Null (and the name unregistered that session) when the median " +
    "down excursion is not negative or the history is too short.",
  outcomeDefinition:
    "Over the ten panel sessions after the observation: up = (max high - entry close) / " +
    "entry close, down = (entry close - min low) / entry close, outcome = up - down in " +
    "percentage points. A DIFFERENCE, not a ratio: a single window's down leg can be " +
    "zero, and an unbounded outcome would hand the statistic to whichever name gapped. " +
    "A name with any interpolated bar inside its forward window resolves to null with " +
    "the exclusion counted — a carried-forward fill cannot supply a real high or low, " +
    "and those exclusions correlate with halts, so their count is reported rather than " +
    "the names silently dropped.",
  statistic:
    "Observation-weighted mean of the per-session Spearman correlation between the " +
    "declared ratio and the realized outcome, midranks, both legs ranked inside their " +
    "own session so the common market move drops out. Interval from the same " +
    "panel block bootstrap every other dependence-corrected number on this site uses, " +
    "with blocks spanning the widest cluster of observation dates inside one horizon.",
  predictedSign: 1,
  minimumResolved: ASYMMETRY_MIN_RESOLVED,
  minimumIndependentWindows: ASYMMETRY_MIN_INDEPENDENT_WINDOWS,
  killCriteria:
    `Evaluated once BOTH gates are met: at least ${ASYMMETRY_MIN_RESOLVED} resolved ` +
    `observations AND at least ${ASYMMETRY_MIN_INDEPENDENT_WINDOWS} non-overlapping ` +
    `${ASYMMETRY_HORIZON_SESSIONS}-session forward windows, counted greedily over panel ` +
    "session indices. If the 95% block-bootstrap interval then contains zero, or the " +
    "correlation is significant with the wrong sign, the column is inside its own noise " +
    "floor: it keeps its caveat forever and is never proposed for ranking. No early " +
    "reads — result is null until the gates, nothing is computed privately.",
  consequence: {
    survives: "eligible to be PROPOSED as a ranking input, with its own review",
    "inside-noise": "stays a described column; rank-by-asymmetry is closed as refuted",
  },
  corroborationNote:
    "This record shares its resolution windows with the forward reach record by design. " +
    "The two may never be cited as independent corroboration of each other; where they " +
    "agree, that agreement is one observation, not two.",
};

/** One (session, symbol) registration. `outcome` is null until bars reach far enough. */
export interface AsymmetryObservation {
  session: string;
  /** Index into the panel's session array — the unit the window math runs on. */
  sessionIndex: number;
  symbol: string;
  ratio: number;
  outcome: number | null;
  /** Why a null outcome is null. `pending` resolves later; `excluded_interpolated` never will. */
  status: "resolved" | "pending" | "excluded_interpolated";
}

export interface AsymmetryRecord {
  generatedAt: number;
  declaration: { id: string; declaredOn: string; horizonSessions: number };
  /** Sessions examined (>= declaredOn only). Empty until the panel reaches the declaration date. */
  sessions: string[];
  observations: AsymmetryObservation[];
  /** Exclusions per session, so survivorship is visible instead of silent. */
  excludedInterpolatedBySession: Record<string, number>;
}

/** The exact column arithmetic, factored so the record and a test can pin identity. */
export function asymmetryRatioOf(bars: readonly Bar[]): number | null {
  const exc = excursionStats(bars, ASYMMETRY_HORIZON_SESSIONS);
  return exc && exc.downMedianPct < 0
    ? Math.round((exc.upMedianPct / Math.abs(exc.downMedianPct)) * 100) / 100
    : null;
}

/**
 * Build the record's observations from the committed panel. Pure, so the
 * nightly script stays an I/O wrapper and this logic is testable.
 *
 * Sessions strictly before `declaredOn` are refused here — not filtered by
 * the caller, refused by the function that knows why.
 */
export function buildAsymmetryObservations(
  panel: BarsPanel,
  declaredOn: string
): Pick<AsymmetryRecord, "sessions" | "observations" | "excludedInterpolatedBySession"> {
  const H = ASYMMETRY_HORIZON_SESSIONS;
  const sessions: string[] = [];
  const observations: AsymmetryObservation[] = [];
  const excluded: Record<string, number> = {};

  for (let s = 0; s < panel.sessions.length; s++) {
    const session = panel.sessions[s];
    if (session < declaredOn) continue;
    sessions.push(session);

    for (const [symbol, sp] of Object.entries(panel.symbols)) {
      const filled = new Set(sp.interpolated);

      // The declared ratio: real bars up to and including the observation
      // session — the same series the screen column is computed from.
      const history: Bar[] = [];
      for (let i = 0; i <= s; i++) {
        const row = sp.bars[i];
        if (!row || filled.has(i)) continue;
        history.push({
          t: Date.parse(panel.sessions[i]),
          open: row[0],
          high: row[1],
          low: row[2],
          close: row[3],
          volume: row[4] ?? 0,
        });
      }
      const ratio = asymmetryRatioOf(history);
      if (ratio === null) continue;
      const entryRow = sp.bars[s];
      if (!entryRow || filled.has(s)) continue;
      const entry = entryRow[3];
      if (!(entry > 0)) continue;

      // The forward leg: the next H panel sessions. Beyond the panel's end
      // it is pending; an interpolated bar inside the window excludes it,
      // because a carried-forward fill has no real high or low.
      if (s + H >= panel.sessions.length) {
        observations.push({ session, sessionIndex: s, symbol, ratio, outcome: null, status: "pending" });
        continue;
      }
      let hi = -Infinity;
      let lo = Infinity;
      let tainted = false;
      for (let j = s + 1; j <= s + H; j++) {
        const row = sp.bars[j];
        if (!row || filled.has(j)) {
          tainted = true;
          break;
        }
        hi = Math.max(hi, row[1]);
        lo = Math.min(lo, row[2]);
      }
      if (tainted) {
        excluded[session] = (excluded[session] ?? 0) + 1;
        observations.push({ session, sessionIndex: s, symbol, ratio, outcome: null, status: "excluded_interpolated" });
        continue;
      }
      const upPct = ((hi - entry) / entry) * 100;
      const downPct = ((entry - lo) / entry) * 100;
      const outcome = Math.round((upPct - downPct) * 1000) / 1000;
      observations.push({ session, sessionIndex: s, symbol, ratio, outcome, status: "resolved" });
    }
  }

  return { sessions, observations, excludedInterpolatedBySession: excluded };
}

export interface AsymmetryGate {
  id: "resolved-rows" | "independent-windows" | "sessions-with-statistic";
  have: number;
  need: number;
  met: boolean;
  detail: string;
}

export interface AsymmetryScreenResult {
  correlation: number;
  lower: number;
  upper: number;
  bootstrapSe: number;
  effectiveN: number;
  containsZero: boolean;
  signAsPredicted: boolean;
}

export interface AsymmetryScreenStanding {
  declaration: AsymmetryScreenDeclaration;
  resolved: number;
  pending: number;
  excludedInterpolated: number;
  sessions: number;
  sessionsWithStatistic: number;
  independentWindows: number;
  blockPeriods: number;
  earliestEvaluableInSessions: number | null;
  gates: AsymmetryGate[];
  /** Null until every gate is met. Nothing is computed early, not even privately. */
  result: AsymmetryScreenResult | null;
  verdict: "waiting" | "survives" | "inside-noise";
  /** Observations dated before the declaration — always zero unless something upstream backfilled. */
  preDeclarationRows: number;
  reading: string;
}

/**
 * Standing of the screen against its own declaration. Mirrors
 * `evaluateIvRvScreen` deliberately — same gates-then-result shape, same
 * refusal to compute anything before the gates are met.
 */
export function evaluateAsymmetryScreen(
  record: Pick<AsymmetryRecord, "observations">
): AsymmetryScreenStanding {
  const d = ASYMMETRY_SCREEN_DECLARATION;

  /*
   * The boundary re-checked. The builder refuses pre-declaration sessions,
   * but this function may be handed any artifact, and a backfilled record
   * scoring as forward evidence is the exact failure the declaration date
   * exists to prevent. Rows from before it are counted, surfaced, and
   * excluded — never scored.
   */
  const preDeclarationRows = record.observations.filter((o) => o.session < d.declaredOn).length;
  const eligible = record.observations.filter((o) => o.session >= d.declaredOn);

  const resolved = eligible.filter((o) => o.status === "resolved" && o.outcome !== null);
  const pending = eligible.filter((o) => o.status === "pending").length;
  const excludedInterpolated = eligible.filter((o) => o.status === "excluded_interpolated").length;

  const bySession = new Map<number, { ratio: number; outcome: number }[]>();
  for (const o of resolved) {
    if (!bySession.has(o.sessionIndex)) bySession.set(o.sessionIndex, []);
    bySession.get(o.sessionIndex)!.push({ ratio: o.ratio, outcome: o.outcome! });
  }

  const termObservations: PanelObservation[] = [];
  let sessionsWithStatistic = 0;
  for (const [idx, rows] of bySession) {
    const terms = sessionTerms(
      rows.map((r) => r.ratio),
      rows.map((r) => r.outcome)
    );
    if (terms.length === 0) continue;
    sessionsWithStatistic++;
    for (let i = 0; i < terms.length; i++) {
      termObservations.push({ period: idx, unitId: `${idx}:${i}`, value: terms[i] });
    }
  }

  const allIndices = [...bySession.keys()];
  const registeredIndices = [...new Set(eligible.map((o) => o.sessionIndex))];
  const independentWindows = countIndependentWindows(allIndices, d.horizonSessions);
  const blockPeriods = blockPeriodsFor(allIndices, d.horizonSessions);
  const earliest = sessionsUntilEvaluable(
    registeredIndices,
    d.horizonSessions,
    d.minimumIndependentWindows
  );

  const gates: AsymmetryGate[] = [
    {
      id: "resolved-rows",
      have: resolved.length,
      need: d.minimumResolved,
      met: resolved.length >= d.minimumResolved,
      detail: `${resolved.length} of ${d.minimumResolved} resolved observations (${pending} pending, ${excludedInterpolated} excluded on interpolated forward bars).`,
    },
    {
      id: "independent-windows",
      have: independentWindows,
      need: d.minimumIndependentWindows,
      met: independentWindows >= d.minimumIndependentWindows,
      detail: `${independentWindows} of ${d.minimumIndependentWindows} non-overlapping ${d.horizonSessions}-session windows among resolved sessions.`,
    },
    {
      id: "sessions-with-statistic",
      have: sessionsWithStatistic,
      need: 1,
      met: sessionsWithStatistic >= 1,
      detail: `${sessionsWithStatistic} sessions wide enough (>= ${MIN_CROSS_SECTION} names, non-degenerate ranks) to form a correlation.`,
    },
  ];

  const allMet = gates.every((g) => g.met);
  let result: AsymmetryScreenResult | null = null;
  let verdict: AsymmetryScreenStanding["verdict"] = "waiting";

  if (allMet) {
    /*
     * Point estimate is the panel mean of the terms; interval and SE come
     * from the block bootstrap over the same observations — the identical
     * summarisation evaluateIvRvScreen uses, seeded so a rerun on the same
     * artifact reproduces the same interval. Effective N is inverted from
     * the realised bootstrap variance so dependence is never charged twice.
     */
    const correlation =
      termObservations.reduce((s, o) => s + o.value, 0) / termObservations.length;
    const distribution = panelBlockBootstrap(termObservations, blockPeriods, 4000, 20260914);
    const mean = distribution.reduce((a, b) => a + b, 0) / distribution.length;
    const variance =
      distribution.reduce((a, b) => a + (b - mean) ** 2, 0) /
      Math.max(1, distribution.length - 1);
    const bootstrapSe = Math.sqrt(variance);
    const sorted = [...distribution].sort((a, b) => a - b);
    const pick = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
    const lower = pick(0.025);
    const upper = pick(0.975);
    const containsZero = lower <= 0 && upper >= 0;
    const signAsPredicted = Math.sign(correlation) === d.predictedSign;
    const termVar =
      termObservations.reduce((s, o) => s + (o.value - correlation) ** 2, 0) /
      Math.max(1, termObservations.length - 1);
    const effectiveN =
      bootstrapSe > 0 && termVar > 0
        ? Math.min(termObservations.length, termVar / (bootstrapSe * bootstrapSe))
        : independentWindows;
    result = {
      correlation,
      lower,
      upper,
      bootstrapSe,
      effectiveN,
      containsZero,
      signAsPredicted,
    };
    verdict = !containsZero && signAsPredicted ? "survives" : "inside-noise";
  }

  const reading = !allMet
    ? `Waiting: ${gates.filter((g) => !g.met).map((g) => g.id).join(", ")} unmet. ` +
      (earliest !== null
        ? `Best case ${earliest} sessions until the window gate, if the panel updates every session.`
        : "No eligible observations yet — the record begins at the first panel session on or after " +
          `${d.declaredOn}.`) +
      (preDeclarationRows > 0
        ? ` WARNING: ${preDeclarationRows} pre-declaration rows were present in the artifact and refused.`
        : "")
    : verdict === "survives"
      ? `Survives its declaration: correlation ${result!.correlation.toFixed(3)} [${result!.lower.toFixed(3)}, ${result!.upper.toFixed(3)}], predicted sign, interval excludes zero. The column may now be PROPOSED for ranking — a separate decision.`
      : `Inside its own noise floor: correlation ${result!.correlation.toFixed(3)} [${result!.lower.toFixed(3)}, ${result!.upper.toFixed(3)}]. The column keeps its caveat and is never proposed for ranking.`;

  return {
    declaration: d,
    resolved: resolved.length,
    pending,
    excludedInterpolated,
    sessions: bySession.size,
    sessionsWithStatistic,
    independentWindows,
    blockPeriods,
    earliestEvaluableInSessions: earliest,
    gates,
    result,
    verdict,
    preDeclarationRows,
    reading,
  };
}
