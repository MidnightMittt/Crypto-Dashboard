/**
 * THE SIGNAL LAB — one engine, many pre-declared hypotheses, one correction.
 *
 * The previous momentum study was a standalone script, which is wrong in two
 * ways the roadmap's own rules already name. It could only ever correct
 * across the variants IT tested, so a second script testing a second idea
 * would silently start a new family and every "significant" result would be
 * an uncorrected look. And it left the measurement trapped in `scripts/`,
 * where nothing else can reach it.
 *
 * So hypotheses are DATA here, not code paths. Adding one is adding an entry
 * to a list, and every entry is corrected against every other entry in the
 * same run. That is the only way a platform testing many ideas can honestly
 * claim any of them.
 *
 * ── The contract each hypothesis must satisfy BEFORE it runs ──────────
 *
 * Direction, holding period, costs and kill criteria are fields, not
 * afterthoughts, because the alternative is choosing them once the answer is
 * visible. A hypothesis that cannot state what would kill it is not a
 * hypothesis, it is a hope.
 *
 * ── What this deliberately does NOT do ────────────────────────────────
 *
 * No parameter search. Each hypothesis names ONE parameterisation. Scanning
 * lookbacks for the best one and reporting that is the single most effective
 * way to manufacture a signal from noise, and it is precisely what the FDR
 * correction cannot save you from once you stop counting the scans.
 */

import { assessEdge, EdgeAssessment } from "./edgeGate";

/** One instrument's point-in-time history. Volume is optional. */
export interface LabSeries {
  symbol: string;
  t: number[];
  close: number[];
  high: number[];
  low: number[];
  volume: number[];
}

/**
 * A view of one instrument AT one decision index, handed to the rank
 * function. Nothing beyond `i` is reachable, which is what makes look-ahead
 * a compile-time impossibility rather than a discipline.
 */
export interface RankContext {
  series: LabSeries;
  /** Index of the decision bar. Only data at or before this may be read. */
  i: number;
}

/** Market-wide state at one decision date, for a regime gate. */
export interface PeriodContext {
  panel: LabSeries[];
  decisionTime: number;
}

export interface Hypothesis {
  id: string;
  /** What is claimed, in one sentence, in the direction it is claimed. */
  statement: string;
  /** Why it might be true. Recorded so a failure teaches something. */
  rationale: string;
  /** Sessions held. Must match the phenomenon's own timescale. */
  hold: number;
  /** Bars of history the rank function needs before it can score. */
  warmup: number;
  /** Percentage points of win rate the edge must clear on top of the null. */
  costPp: number;
  /** Stated before the run. What result would retire this idea. */
  killCriteria: string;
  /**
   * Sessions between the signal bar and the entry bar. Default 0 = enter at
   * the same close the signal is read from.
   *
   * Exists for ONE reason: short-horizon reversal measured close-to-close is
   * partly bid-ask bounce, not information. A stock that closed on the bid
   * and then closes on the ask shows a "reversal" nobody could have traded.
   * Delaying entry by a session steps over that bounce — if the effect is
   * real it survives, if it was microstructure it dies. Any hypothesis at a
   * horizon short enough for the bounce to matter owes this test.
   */
  entryOffset?: number;
  /**
   * Ids of hypotheses that must ALSO earn Edge for this one to count.
   *
   * Structural, not advisory. A robustness test whose failure is recorded
   * only in a prose `killCriteria` field is a rule that the next run will
   * quietly ignore — so the dependency lives in the data and the engine
   * enforces it. `reversal-5d` requires its skip-a-session twin precisely
   * because passing alone is the signature of a bid-ask bounce.
   */
  requires?: string[];
  /**
   * Decides whether to trade a PERIOD at all, given the market's own state.
   *
   * Distinct from `rank`, which chooses names within a period. A regime gate
   * answers "should this strategy be on right now", and momentum is the
   * canonical case: its worst outcomes cluster in bear-to-bull reversals,
   * where yesterday's losers rip and the short leg is run over.
   *
   * Receives only the panel and the decision index, so the state must be
   * derived from data at or before the decision — same discipline as rank.
   */
  periodGate?: (ctx: PeriodContext) => boolean;
  /**
   * What is actually held. Default `long-short`.
   *
   * THIS EXISTS BECAUSE A DOSSIER CANNOT HOLD A SPREAD. Every result in this
   * family so far measures top-decile MINUS bottom-decile, and that number
   * belongs to a four-legged portfolio. A reader looking at one ticker holds
   * the long leg alone and inherits none of the spread's record — quoting it
   * at them would be the single most tempting overstatement this engine
   * could make, because the statistic is real and merely about something
   * else.
   *
   * `long-vs-panel` measures the top decile against the equal-weighted panel
   * over the same window, which is the comparison a single long position
   * actually faces. The null stays 50% for both: each is a relative
   * comparison over identical windows, so market drift cancels rather than
   * accruing to one side.
   */
  leg?: "long-short" | "long-vs-panel";
  /**
   * Higher = more attractive to be LONG. The long-short spread is always
   * top-decile minus bottom-decile of this number, so the sign convention
   * lives in the hypothesis rather than in the engine.
   */
  rank: (ctx: RankContext) => number | null;
}

/**
 * One period's legs, kept so a benchmark can be measured against the SAME
 * entries and exits the hypothesis actually traded.
 *
 * Emitted rather than recomputed. A second pass rebuilding the calendar would
 * be free to drift from this one — a different warmup, a different skip, a
 * different idea of where a period starts — and the resulting comparison
 * would be against dates the signal never held.
 */
export interface PeriodLeg {
  /** Bar time of entry. The benchmark is read at exactly this instant. */
  entryTime: number;
  exitTime: number;
  /** Top-decile mean forward return, as a fraction. What a trader would hold. */
  top: number;
  /** Equal-weight mean over every ranked name — the universe leg. */
  universe: number;
}

export interface HypothesisResult {
  id: string;
  statement: string;
  /** Non-overlapping periods with a full panel. */
  n: number;
  /**
   * Per-period legs, in period order. `n` is their count.
   *
   * Present so `decompose` can separate selection skill from pool drift
   * without this function needing to know a benchmark exists — ranking a
   * panel and comparing to an index are different jobs.
   */
  periods: PeriodLeg[];
  winRate: number;
  /** Mean long-short spread per period, as a fraction. */
  meanSpread: number;
  /** Median, because a single period can dominate a mean. */
  medianSpread: number;
  /**
   * The left tail, which is what actually ends a strategy.
   *
   * A hit rate says how OFTEN you win; these say what happens when you do
   * not. momentum-12-1 wins 55% of months with a +0.91% median and a +0.13%
   * mean — the entire gap is a handful of periods, and a trader sizing on
   * the hit rate alone would be sized for the wrong distribution.
   */
  worstSpread: number;
  p05Spread: number;
  p95Spread: number;
  /** Periods skipped because the regime gate was closed. */
  periodsGatedOut: number;
  assessment: EdgeAssessment;
  pValue: number;
  /** Filled in by the caller once the whole family is corrected. */
  survivesFdr: boolean;
  /**
   * Clears the gate AND survives FDR AND every hypothesis it depends on does
   * too. This is the only field a consumer should read to decide whether a
   * signal may move a decision.
   */
  earnsEdge: boolean;
  /** Which dependency retired it, when one did. */
  retiredBy: string | null;
}

/** Fraction of the ranked panel taken at each end. */
const DECILE = 0.1;
/** Below this many ranked names a cross-sectional decile is meaningless. */
const MIN_PANEL = 40;

/** Index of the last bar at or before `time`, or -1. */
export function indexAsOf(t: number[], time: number): number {
  let lo = 0;
  let hi = t.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Nearest-rank percentile. Small samples do not deserve interpolation. */
function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Runs one hypothesis over the panel.
 *
 * Periods step by the holding period, so they never overlap in time. That is
 * what lets n be used directly as the effective sample: the overlap
 * correction exists for rolling windows, and there are none here. Any future
 * hypothesis that samples more often than it holds MUST route through
 * effectiveSampleSize instead — this shortcut is only sound because the step
 * equals the hold.
 */
export function runHypothesis(series: LabSeries[], h: Hypothesis): HypothesisResult {
  const calendar = [...new Set(series.flatMap((s) => s.t))].sort((a, b) => a - b);
  const spreads: number[] = [];
  const periods: PeriodLeg[] = [];

  const offset = h.entryOffset ?? 0;
  let gatedOut = 0;
  for (let c = h.warmup; c + h.hold + offset < calendar.length; c += h.hold) {
    const decisionTime = calendar[c];
    if (h.periodGate && !h.periodGate({ panel: series, decisionTime })) {
      gatedOut++;
      continue;
    }
    const entryTime = calendar[c + offset];
    const exitTime = calendar[c + h.hold + offset];
    const scored: Array<{ score: number; fwd: number }> = [];

    for (const s of series) {
      const i = indexAsOf(s.t, decisionTime);
      if (i < h.warmup) continue;

      const score = h.rank({ series: s, i });
      if (score === null || !Number.isFinite(score)) continue;

      /*
       * The score is read at `i`; the position is entered at `entryIdx` and
       * exited at `exit`. When offset is 0 those first two coincide. The
       * ordering below is asserted rather than assumed — a delisted name must
       * drop out, not report a flat period that dilutes both tails to zero.
       */
      const entryIdx = indexAsOf(s.t, entryTime);
      const exit = indexAsOf(s.t, exitTime);
      if (entryIdx < i || exit <= entryIdx) continue;
      const entry = s.close[entryIdx];
      if (!(entry > 0) || !(s.close[exit] > 0)) continue;

      scored.push({ score, fwd: s.close[exit] / entry - 1 });
    }

    if (scored.length < MIN_PANEL) continue;
    scored.sort((a, b) => b.score - a.score);
    const k = Math.max(1, Math.floor(scored.length * DECILE));
    const top = mean(scored.slice(0, k).map((x) => x.fwd));
    const universe = mean(scored.map((x) => x.fwd));
    // See `leg`. The short leg is the bottom decile, or the panel itself when
    // the hypothesis is about a long position rather than a spread.
    const reference =
      h.leg === "long-vs-panel" ? universe : mean(scored.slice(-k).map((x) => x.fwd));
    spreads.push(top - reference);
    /*
     * Recorded on EVERY period the hypothesis counted, gated ones excluded —
     * `spreads` and `periods` grow together and are therefore the same
     * sample. A benchmark compared against a different set of dates would
     * answer a question nobody asked.
     */
    periods.push({ entryTime, exitTime, top, universe });
  }

  const n = spreads.length;
  const wins = spreads.filter((x) => x > 0).length;
  const winRate = n > 0 ? wins / n : 0;

  /*
   * The null is 50%, and for a long-short spread that is the correct bar
   * rather than a lazy one: the position is dollar-neutral, so it does not
   * inherit the market's upward drift the way a long-only read does. A
   * long-only hypothesis would need the drift-matched base rate instead.
   */
  const assessment = assessEdge(
    { winRate, baseRate: 0.5, effectiveN: n, holdingPeriod: `${h.hold}d` },
    h.costPp
  );

  return {
    id: h.id,
    statement: h.statement,
    n,
    periods,
    winRate,
    meanSpread: mean(spreads),
    medianSpread: median(spreads),
    worstSpread: spreads.length ? Math.min(...spreads) : 0,
    p05Spread: percentile(spreads, 0.05),
    p95Spread: percentile(spreads, 0.95),
    periodsGatedOut: gatedOut,
    assessment,
    pValue: signTestP(wins, n),
    survivesFdr: false,
    earnsEdge: false,
    retiredBy: null,
  };
}

/** Two-sided sign test against a fair coin, normal approximation. */
export function signTestP(wins: number, n: number): number {
  if (n <= 0) return 1;
  const z = Math.abs(wins / n - 0.5) / Math.sqrt(0.25 / n);
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz-Stegun 7.1.26, max error 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// ── Shared feature helpers, so hypotheses stay one line of intent ───────

/** Simple return between two indices. Null when either bar is unusable. */
export function ret(s: LabSeries, from: number, to: number): number | null {
  const a = s.close[from];
  const b = s.close[to];
  return a > 0 && b > 0 ? b / a - 1 : null;
}

/** Annualisation-free realised volatility: stdev of daily log returns. */
export function realisedVol(s: LabSeries, i: number, window: number): number | null {
  if (i - window < 0) return null;
  const rs: number[] = [];
  for (let k = i - window + 1; k <= i; k++) {
    const a = s.close[k - 1];
    const b = s.close[k];
    if (!(a > 0) || !(b > 0)) return null;
    rs.push(Math.log(b / a));
  }
  const m = mean(rs);
  return Math.sqrt(mean(rs.map((r) => (r - m) ** 2)));
}

/** Highest close over a trailing window, inclusive of `i`. */
export function trailingHigh(s: LabSeries, i: number, window: number): number | null {
  if (i - window + 1 < 0) return null;
  let hi = -Infinity;
  for (let k = i - window + 1; k <= i; k++) if (s.close[k] > hi) hi = s.close[k];
  return Number.isFinite(hi) ? hi : null;
}

/** Mean volume over a trailing window, inclusive of `i`. */
export function meanVolume(s: LabSeries, i: number, window: number): number | null {
  if (i - window + 1 < 0) return null;
  let sum = 0;
  for (let k = i - window + 1; k <= i; k++) {
    if (!Number.isFinite(s.volume[k])) return null;
    sum += s.volume[k];
  }
  return sum / window;
}

/**
 * Resolves `earnsEdge` across the family once FDR is known.
 *
 * Runs after correction because a dependency that fails FDR must retire its
 * dependents just as surely as one that fails the gate — both mean the
 * robustness test did not hold.
 */
export function resolveDependencies(
  results: HypothesisResult[],
  family: Hypothesis[]
): void {
  const passes = (r: HypothesisResult) => r.assessment.verdict === "edge" && r.survivesFdr;
  const byId = new Map(results.map((r) => [r.id, r]));

  for (const r of results) {
    const h = family.find((x) => x.id === r.id);
    let retiredBy: string | null = null;
    for (const dep of h?.requires ?? []) {
      const d = byId.get(dep);
      if (!d || !passes(d)) {
        retiredBy = dep;
        break;
      }
    }
    r.retiredBy = retiredBy;
    r.earnsEdge = passes(r) && retiredBy === null;
  }
}

/**
 * Market state from the panel itself: the share of instruments trading above
 * their own 200-session average, at the decision date.
 *
 * Derived from the panel rather than an index series so it needs no new data
 * and cannot disagree with the universe being traded. Breadth rather than a
 * single index level, because the question a momentum gate is really asking
 * is "are most things going up", which an index can answer wrongly when a
 * few mega-caps carry it.
 */
export function panelBreadth(panel: LabSeries[], decisionTime: number): number | null {
  let above = 0;
  let counted = 0;
  for (const s of panel) {
    const i = indexAsOf(s.t, decisionTime);
    if (i < 200) continue;
    let sum = 0;
    for (let k = i - 199; k <= i; k++) sum += s.close[k];
    const ma = sum / 200;
    if (ma > 0 && s.close[i] > 0) {
      counted++;
      if (s.close[i] > ma) above++;
    }
  }
  return counted >= 40 ? above / counted : null;
}

/**
 * Instruments whose history contains an impossible single-session move.
 *
 * NVR prints 0.38 -> 10.25 on 1993-09-30, a +2,633% session. MARA shows
 * 53.04 -> 104 on two different dates with identical values. These are
 * unadjusted corporate actions and stale duplicated bars, not market events,
 * and one of them is enough to produce a -370% decile spread — which is what
 * exposed them.
 *
 * ── Why exclude the INSTRUMENT rather than clip the BAR ───────────────
 *
 * Clipping is a silent repair, and the roadmap forbids those: it would turn
 * a +2,633% print into a plausible-looking number and hide that the series
 * is unreliable everywhere around that date. Excluding the whole instrument
 * is a statement about the DATA.
 *
 * ── Why this is not look-ahead ────────────────────────────────────────
 *
 * The decision uses the instrument's ENTIRE history and is identical for
 * every period, so it cannot depend on any period's outcome. Filtering a
 * name out of a specific period because its FORWARD return looked wrong
 * would be look-ahead; this is not that. The cost is real and stated: a
 * genuine 60% session — a takeover, a biotech readout — also removes its
 * instrument, so the panel is biased slightly toward the uneventful.
 */
const IMPLAUSIBLE_SESSION_MOVE = 0.6;

export interface PanelIntegrity {
  clean: LabSeries[];
  excluded: Array<{ symbol: string; worstMovePct: number; date: string }>;
}

export function excludeCorruptSeries(panel: LabSeries[]): PanelIntegrity {
  const clean: LabSeries[] = [];
  const excluded: PanelIntegrity["excluded"] = [];

  for (const s of panel) {
    let worst = 0;
    let worstAt = 0;
    for (let i = 1; i < s.close.length; i++) {
      const a = s.close[i - 1];
      const b = s.close[i];
      if (!(a > 0) || !(b > 0)) continue;
      const r = Math.abs(b / a - 1);
      if (r > worst) {
        worst = r;
        worstAt = s.t[i];
      }
    }
    if (worst > IMPLAUSIBLE_SESSION_MOVE) {
      excluded.push({
        symbol: s.symbol,
        worstMovePct: worst * 100,
        date: new Date(worstAt).toISOString().slice(0, 10),
      });
    } else clean.push(s);
  }
  return { clean, excluded };
}
