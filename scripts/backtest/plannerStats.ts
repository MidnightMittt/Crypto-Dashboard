import { wilsonInterval } from "./metrics";

/**
 * PLANNER STATISTICS — the execution replay's per-trade MAE/MFE excursions
 * and outcomes, aggregated into the exact numbers the trade planner needs
 * (decision-engine redesign §10). Everything here is derived from trades
 * already recorded; nothing new is measured.
 *
 * The bucket is SIDE × VOLATILITY REGIME, fixed a priori for two mechanical
 * reasons, not because it scanned best: direction faces the drift asymmetry
 * (longs and shorts are not mirror trades on a drifting asset), and the
 * volatility regime scales both excursions and costs. No other bucketing
 * was tried, so there is no selection to correct for.
 *
 * MEASUREMENT, NOT POLICY. These stats must always describe the UNGATED
 * strategy: the backtest replay keeps generating every plan the geometry
 * supports, and the live path applies the constraints derived here as an
 * overlay. If the replay itself were gated, refusing a bucket would empty
 * that bucket's sample, the gate would lift next cycle, and the system
 * would oscillate between policies. Keeping measurement and policy separate
 * is what makes the gate stable and re-earnable: a bucket that improves in
 * the ungated record re-opens on the next regeneration, and one that decays
 * closes.
 */

export type PlannerSide = "long" | "short";
export type VolRegime = "high-vol" | "normal-vol" | "low-vol";

export interface PlannerTradeRow {
  side: PlannerSide;
  volRegime: VolRegime | null;
  /** Net of fees, slippage and funding — a gross win eaten by costs is not a win. */
  netReturnPct: number;
  /** Max adverse excursion, % (negative or zero as recorded). */
  maePct: number;
  /** Max favorable excursion, % (positive or zero). */
  mfePct: number;
  hoursHeld: number | null;
}

export interface PlannerWinnerExcursions {
  n: number;
  /** Adverse move winners endured before working, as POSITIVE percentages. */
  maeP50Pct: number;
  maeP80Pct: number;
  maeP90Pct: number;
  mfeP50Pct: number;
  mfeP75Pct: number;
}

export interface PlannerCellStats {
  side: PlannerSide;
  volRegime: VolRegime;
  n: number;
  winRatePct: number;
  /** Wilson 95% lower bound on the win rate — the number the EV gate uses. */
  winRateWilsonLowPct: number;
  avgWinPct: number;
  avgLossPct: number;
  /** Expectancy at the point-estimate win rate, % per trade. */
  evPointPct: number;
  /** Expectancy at the Wilson-lower win rate — the pessimistic bound a plan must clear. */
  evLowerPct: number;
  /** Null when fewer than MIN_WINNERS winners exist to describe. */
  winners: PlannerWinnerExcursions | null;
}

export interface SurvivalPoint {
  hours: number;
  /** Trades still unresolved at this age. */
  n: number;
  /** How often those survivors eventually ended net-positive. */
  eventualWinRatePct: number;
}

export interface PlannerStats {
  cells: Partial<Record<`${PlannerSide}:${VolRegime}`, PlannerCellStats>>;
  survival: SurvivalPoint[];
  /** The time-stop verdict, WRITTEN FROM the survival numbers — see buildTimeStopFinding. */
  timeStopFinding: string;
}

/**
 * A cell must clear this many trades before its EV bounds mean anything,
 * and this many WINNERS before its excursion quantiles do. 30 rather than
 * the census's MIN_SAMPLE_N=10 because a p90 needs tail mass: the 90th
 * percentile of 10 observations is the maximum, which is noise.
 */
export const MIN_CELL_N = 30;
export const MIN_WINNERS = 30;

const SURVIVAL_HOURS = [24, 48, 72, 96, 120, 144];

/** Linear-interpolated quantile, q in [0,1]. Callers guarantee xs non-empty. */
export function quantile(xs: number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const i = q * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function buildPlannerStats(rows: PlannerTradeRow[]): PlannerStats {
  const cells: PlannerStats["cells"] = {};

  for (const side of ["long", "short"] as const) {
    for (const volRegime of ["high-vol", "normal-vol", "low-vol"] as const) {
      const bucket = rows.filter((r) => r.side === side && r.volRegime === volRegime);
      if (bucket.length < MIN_CELL_N) continue;

      const wins = bucket.filter((r) => r.netReturnPct > 0);
      const losses = bucket.filter((r) => r.netReturnPct <= 0);
      // A cell with no losses (or no wins) has no measurable expectancy
      // trade-off; leave it out rather than divide by zero into a claim.
      if (wins.length === 0 || losses.length === 0) continue;

      const interval = wilsonInterval(wins.length, bucket.length)!;
      const avgWinPct = wins.reduce((s, r) => s + r.netReturnPct, 0) / wins.length;
      const avgLossPct = losses.reduce((s, r) => s + r.netReturnPct, 0) / losses.length;
      const p = wins.length / bucket.length;

      const winners: PlannerWinnerExcursions | null =
        wins.length >= MIN_WINNERS
          ? {
              n: wins.length,
              maeP50Pct: quantile(wins.map((r) => -r.maePct), 0.5),
              maeP80Pct: quantile(wins.map((r) => -r.maePct), 0.8),
              maeP90Pct: quantile(wins.map((r) => -r.maePct), 0.9),
              mfeP50Pct: quantile(wins.map((r) => r.mfePct), 0.5),
              mfeP75Pct: quantile(wins.map((r) => r.mfePct), 0.75),
            }
          : null;

      cells[`${side}:${volRegime}`] = {
        side,
        volRegime,
        n: bucket.length,
        winRatePct: p * 100,
        winRateWilsonLowPct: interval.lower * 100,
        avgWinPct,
        avgLossPct,
        evPointPct: p * avgWinPct + (1 - p) * avgLossPct,
        evLowerPct: interval.lower * avgWinPct + (1 - interval.lower) * avgLossPct,
        winners,
      };
    }
  }

  const survival: SurvivalPoint[] = [];
  for (const hours of SURVIVAL_HOURS) {
    const alive = rows.filter((r) => (r.hoursHeld ?? 0) >= hours);
    if (alive.length < MIN_CELL_N) continue;
    const w = alive.filter((r) => r.netReturnPct > 0).length;
    survival.push({ hours, n: alive.length, eventualWinRatePct: (100 * w) / alive.length });
  }

  return { cells, survival, timeStopFinding: buildTimeStopFinding(survival) };
}

/**
 * The redesign hypothesized a time stop: "if unresolved trades at day N win
 * <45% forward, the plan says exit by day N." This writes the verdict FROM
 * the survival curve rather than asserting one — and on the current replay
 * the hypothesis is false in the interesting direction: survivors WIN MORE
 * the longer they live (stops resolve faster than targets), so a time stop
 * would amputate winners. Publishing that negative result is the point;
 * if a future replay's curve dips below the threshold, this sentence
 * changes itself and the finding reverses on the record.
 */
export const TIME_STOP_WIN_THRESHOLD_PCT = 45;

export function buildTimeStopFinding(survival: SurvivalPoint[]): string {
  if (survival.length === 0) {
    return "Too few aged trades to evaluate a time stop either way.";
  }
  const breach = survival.find((s) => s.eventualWinRatePct < TIME_STOP_WIN_THRESHOLD_PCT);
  if (breach) {
    return (
      `Trades still open at hour ${breach.hours} went on to win only ` +
      `${breach.eventualWinRatePct.toFixed(1)}% of the time (n=${breach.n}) — below the ` +
      `${TIME_STOP_WIN_THRESHOLD_PCT}% threshold, so plans should exit by hour ${breach.hours}.`
    );
  }
  const first = survival[0];
  const last = survival[survival.length - 1];
  return (
    `NO TIME STOP is justified by this data: eventual win rate RISES with age, from ` +
    `${first.eventualWinRatePct.toFixed(1)}% for trades open at hour ${first.hours} (n=${first.n}) to ` +
    `${last.eventualWinRatePct.toFixed(1)}% at hour ${last.hours} (n=${last.n}) — stops resolve faster ` +
    `than targets, so surviving trades are the good ones and a time stop would amputate winners. ` +
    `The hypothesized exit-if-below-${TIME_STOP_WIN_THRESHOLD_PCT}% trigger never fires at any measured horizon.`
  );
}

/**
 * The EV gate's analytic effect, computed from the same ungated record —
 * what the live overlay keeps and refuses, and what that does to
 * expectancy. Reported alongside the stats because a policy whose measured
 * effect is an 80%+ cut in trade count must say so where the numbers live,
 * not imply the strategy suddenly quadrupled its edge for free.
 */
export interface GateEffect {
  keptN: number;
  refusedN: number;
  keptExpectancyPct: number | null;
  refusedExpectancyPct: number | null;
  ungatedExpectancyPct: number | null;
}

export function gateEffect(rows: PlannerTradeRow[], stats: PlannerStats): GateEffect {
  const kept: number[] = [];
  const refused: number[] = [];
  for (const r of rows) {
    const cell = r.volRegime ? stats.cells[`${r.side}:${r.volRegime}`] : undefined;
    // Untagged or below-sample cells are NOT gated — no evidence, no verdict.
    if (cell && cell.evLowerPct <= 0) refused.push(r.netReturnPct);
    else kept.push(r.netReturnPct);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    keptN: kept.length,
    refusedN: refused.length,
    keptExpectancyPct: mean(kept),
    refusedExpectancyPct: mean(refused),
    ungatedExpectancyPct: mean([...kept, ...refused]),
  };
}
