import { Bar } from "./types";

/**
 * WHERE TO PUT THE EXITS, MEASURED RATHER THAN ROUNDED.
 *
 * Rungs were set at +25% and +42% only after measuring that a +10% rung
 * fills 75% of 20-session windows and a +15% fills 64% — which is to say
 * those levels cap a runner most of the time in exchange for a small gain.
 * Without the measurement the round numbers win, and they are wrong in the
 * expensive direction.
 *
 * This is the reach side of the same machinery stopViability computes for
 * stops, and it deliberately mirrors its conventions so the two can be read
 * together:
 *
 *   stops  use LOWS  — did price fall far enough to take me out
 *   targets use HIGHS — did price rise far enough to fill me
 *
 * Using closes for either would understate both, because a level touched
 * intraday and given back still fills a resting order.
 *
 * ── Mean AND median, never one of them ────────────────────────────────
 *
 * Ladder expectancy is reported as both, separately, because on these names
 * they disagree and the disagreement IS the finding. A single runner drags
 * the mean while the median says most trades were unremarkable. Reporting
 * only the mean sells the ladder on one lucky path; reporting only the
 * median hides the fat tail that pays for the strategy. A reader needs the
 * gap to size honestly.
 */

/** Sessions of history required before any reach figure is reported. */
export const MIN_ENTRIES = 30;

/** Target levels measured by default, in percent above entry. */
export const DEFAULT_TARGETS_PCT = [5, 10, 15, 25, 40, 60] as const;

export interface ReachCell {
  /** Distance above entry, percent. */
  targetPct: number;
  horizonDays: number;
  /** Share of entries whose HIGH reached the target within the horizon, 0-100. */
  reachPct: number;
  /** Entry sessions measured. Windows OVERLAP — see independentN. */
  n: number;
  /** Non-overlapping windows the same span would hold. The honest sample size. */
  independentN: number;
  /**
   * reachPct x targetPct, in percent. NOT an expectancy — it ignores what
   * happens when the target is missed. It exists to show WHERE the product
   * peaks, because a high fill rate on a small target and a low fill rate on
   * a large one can be worth the same, and the peak is not where intuition
   * puts it.
   */
  reachTimesTarget: number;
}

/**
 * How often price reached `targetPct` above entry within `horizonDays`.
 *
 * Every session with a full forward window is an entry. Null when there are
 * too few to say anything — a reach rate over a handful of windows is
 * arithmetic, not evidence.
 */
export function reachAt(
  bars: readonly Bar[],
  targetPct: number,
  horizonDays: number
): ReachCell | null {
  if (!(targetPct > 0) || !(horizonDays > 0)) return null;
  const last = bars.length - horizonDays;
  if (last < MIN_ENTRIES) return null;

  let reached = 0;
  let n = 0;
  for (let i = 0; i < last; i++) {
    const entry = bars[i].close;
    if (!(entry > 0)) continue;
    const target = entry * (1 + targetPct / 100);
    n++;
    for (let j = i + 1; j <= i + horizonDays; j++) {
      if (bars[j].high >= target) {
        reached++;
        break;
      }
    }
  }
  if (n < MIN_ENTRIES) return null;

  const reachPct = (reached / n) * 100;
  return {
    targetPct,
    horizonDays,
    reachPct: Math.round(reachPct * 10) / 10,
    n,
    independentN: Math.floor(n / horizonDays),
    reachTimesTarget: Math.round(reachPct * targetPct) / 100,
  };
}

/** The reach curve across target levels at one horizon, nearest target first. */
export function reachCurve(
  bars: readonly Bar[],
  horizonDays: number,
  targets: readonly number[] = DEFAULT_TARGETS_PCT
): ReachCell[] {
  return targets
    .map((t) => reachAt(bars, t, horizonDays))
    .filter((c): c is ReachCell => c !== null);
}

/**
 * The target whose reach x size product is largest.
 *
 * Not a recommendation to place a rung there. It is the peak of a curve that
 * ignores the cost of missing, and the honest use is to see how FLAT the
 * curve is — when several levels sit within a point of each other, the choice
 * between them is not supported by the data and should be made on other
 * grounds.
 */
export function peakOfCurve(curve: readonly ReachCell[]): ReachCell | null {
  if (curve.length === 0) return null;
  return [...curve].sort((a, b) => b.reachTimesTarget - a.reachTimesTarget)[0];
}

export interface LadderOutcome {
  /** Mean realised return across entry windows, percent. */
  meanPct: number;
  /** Median realised return. Reported separately because it disagrees. */
  medianPct: number;
  n: number;
  independentN: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Replay a ladder against history and report what it would have realised.
 *
 * `rungs` are [targetPct, fractionOfPosition] pairs; whatever is unsold at
 * the horizon exits at that session's close. A rung fills when the HIGH
 * reaches it, in the order given, at most once each.
 *
 * The stop is honoured FIRST within a session: if the low reaches the stop
 * and the high reaches a rung on the same bar, this assumes the stop. Intraday
 * order is unknowable from a daily bar, and assuming the favourable sequence
 * would inflate every ladder in the study by exactly the amount that makes it
 * look good.
 */
export function ladderOutcome(
  bars: readonly Bar[],
  horizonDays: number,
  rungs: ReadonlyArray<readonly [number, number]>,
  stopPct: number | null
): LadderOutcome | null {
  const outcomes = replayWindows(bars, horizonDays, rungs, stopPct);
  if (outcomes === null || outcomes.length < MIN_ENTRIES) return null;
  return {
    meanPct: Math.round((outcomes.reduce((s, v) => s + v, 0) / outcomes.length) * 100) / 100,
    medianPct: Math.round(median(outcomes) * 100) / 100,
    n: outcomes.length,
    independentN: Math.floor(outcomes.length / horizonDays),
  };
}

/**
 * The per-window realised returns behind `ladderOutcome`, unaggregated.
 *
 * Exposed because comparing two rule settings needs the PAIRED differences
 * window by window, not two means. Both settings run over the same entries, so
 * the difference series cancels the market path they share — computing it from
 * summary statistics would throw that away and understate the power available.
 *
 * Same replay, same pessimistic stop tie-break. One implementation, so a rule
 * cannot be judged against a different simulator than the one that sets exits.
 */
export function replayWindows(
  bars: readonly Bar[],
  horizonDays: number,
  rungs: ReadonlyArray<readonly [number, number]>,
  stopPct: number | null
): number[] | null {
  const last = bars.length - horizonDays;
  if (last < MIN_ENTRIES) return null;

  const outcomes: number[] = [];
  for (let i = 0; i < last; i++) {
    const entry = bars[i].close;
    if (!(entry > 0)) continue;

    const filled = rungs.map(() => false);
    let realised = 0;
    let remaining = 1;
    let stopped = false;

    for (let j = i + 1; j <= i + horizonDays && !stopped; j++) {
      if (stopPct !== null) {
        const stopPrice = entry * (1 - stopPct / 100);
        if (bars[j].low <= stopPrice) {
          realised += remaining * -stopPct;
          remaining = 0;
          stopped = true;
          break;
        }
      }
      for (let k = 0; k < rungs.length; k++) {
        if (filled[k]) continue;
        const [targetPct, size] = rungs[k];
        if (bars[j].high >= entry * (1 + targetPct / 100)) {
          const take = Math.min(size, remaining);
          realised += take * targetPct;
          remaining -= take;
          filled[k] = true;
        }
      }
    }

    if (!stopped && remaining > 0) {
      const exit = bars[Math.min(i + horizonDays, bars.length - 1)].close;
      realised += remaining * ((exit / entry - 1) * 100);
    }
    outcomes.push(realised);
  }

  return outcomes;
}

/**
 * The per-position loss budget for defined-risk structures.
 *
 * Exists for the case the stop grid keeps discovering: above roughly 1.6%
 * ATR no tested stop width clears the 70% survival floor, so an exit-based
 * control is simply unavailable on the names this account actually trades.
 * The honest routing is not "don't trade" — it is "bound the downside by
 * construction", and a construction-bounded position needs a budget, not a
 * width. Capacity is what sits above the account's hard floor; the budget
 * divides it across the concurrent positions the caller intends to run.
 *
 * Pure arithmetic on the CALLER's numbers — the site does not hold the
 * account and must not pretend to. Null when the inputs cannot describe a
 * budget (account at or under its floor, or a nonsensical position count),
 * because a negative budget rendered as a number would read as permission.
 */
export interface RiskBudget {
  riskCapacityUsd: number;
  perPositionUsd: number;
}

export function definedRiskBudget(
  accountValueUsd: number,
  hardFloorUsd: number,
  concurrentPositions: number
): RiskBudget | null {
  if (!Number.isFinite(accountValueUsd) || !Number.isFinite(hardFloorUsd)) return null;
  if (hardFloorUsd < 0 || accountValueUsd <= hardFloorUsd) return null;
  if (!Number.isInteger(concurrentPositions) || concurrentPositions < 1) return null;
  const capacity = accountValueUsd - hardFloorUsd;
  return {
    riskCapacityUsd: Math.round(capacity * 100) / 100,
    perPositionUsd: Math.round((capacity / concurrentPositions) * 100) / 100,
  };
}

/**
 * One sentence on whether the ladder beat holding, naming both statistics.
 *
 * Deliberately refuses a verdict when mean and median disagree in sign. That
 * is not indecision — it is the case where the answer genuinely depends on
 * whether you can survive the variance to collect the tail, which is a
 * question about the account and not about the data.
 */
export function compareToHold(ladder: LadderOutcome, hold: LadderOutcome): string {
  const dMean = ladder.meanPct - hold.meanPct;
  const dMedian = ladder.medianPct - hold.medianPct;
  const f = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp`;

  const both = `Laddering changes the mean by ${f(dMean)} and the median by ${f(dMedian)} ` +
    `over ${ladder.independentN} independent windows.`;

  if (dMean > 0 === dMedian > 0) {
    return (
      `${both} Both move the same way, so the ladder ` +
      (dMean > 0 ? "helped" : "cost") +
      ` on this history rather than merely reshaping the distribution.`
    );
  }
  return (
    `${both} They disagree in SIGN: the ladder ` +
    (dMedian > 0 ? "improves the typical trade while giving up the tail" : "gives up typical outcomes in exchange for tail") +
    `. No verdict is offered, because which one matters depends on whether the account can ` +
    `survive the variance long enough to collect the rare path — a question about position size, not about this data.`
  );
}
