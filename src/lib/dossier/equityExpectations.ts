import { MetricVerdict } from "@/lib/signals/types";
import { PlanConstraints } from "@/lib/signals/tradePlan";
import { PlanExpectations } from "./types";

/**
 * EQUITY EXPECTATIONS — the runtime half of the equity execution replay.
 *
 * The research page has, until now, told every stock reader the truth that
 * "there is no equity execution replay yet, so win rate, expected drawdown,
 * how far comparable trades ran and how long they took are NOT measured for
 * stocks." This module is what retires that sentence: the replay
 * (scripts/backtest/equityReplay.ts) walks the committed daily history
 * point-in-time, runs the SAME engine the live page runs, resolves every
 * plan it produced against the bars that actually followed, and publishes
 * the resulting cells here.
 *
 * ── The measurement / policy split, preserved ─────────────────────────
 *
 * This file only READS. It maps a live plan onto the cell that describes it
 * and hands back what was measured. It never gates, never re-scores, and
 * never invents a cell for a bucket the replay declined to publish — a thin
 * cell returns null and the dossier renders its stated absence, exactly as
 * it did before this landed.
 *
 * ── Why the bucket is side × volatility ───────────────────────────────
 *
 * The same taxonomy the crypto planner already uses, for the same reason:
 * both were fixed a priori rather than searched, so the cells are not a
 * multiple-comparisons artefact. Direction changes which tail you are
 * exposed to; volatility changes how far price travels before it decides.
 * Nothing else was added, because every extra dimension divides an already
 * finite sample.
 */

export type EquityVolRegime = "high-vol" | "normal-vol" | "low-vol";
export type EquitySide = "long" | "short";

/** Excursion percentiles over WINNING trades, in positive percent. */
export interface EquityWinnerExcursions {
  n: number;
  maeP50Pct: number;
  maeP80Pct: number;
  mfeP50Pct: number;
  mfeP75Pct: number;
}

export interface EquityCell {
  side: EquitySide;
  volRegime: EquityVolRegime;
  n: number;
  /**
   * Overlapping trades are not independent observations. This is the
   * overlap-corrected count the confidence language is allowed to lean on;
   * `n` is the raw trade count and is always the larger number.
   */
  effectiveN: number;
  winRatePct: number;
  winRateWilsonLowPct: number;
  avgWinPct: number;
  avgLossPct: number;
  evPointPct: number;
  evLowerPct: number;
  medianHoldSessions: number | null;
  /**
   * THE DRIFT NULL. Average forward return of a RANDOM long entry over this
   * cell's own holding period, across the same universe and window — the
   * return you would have got for showing up with no signal at all.
   * Sign-flipped for shorts, because shorting a market that drifts up loses
   * that drift by default.
   */
  driftNullPct: number | null;
  /**
   * Expectancy MINUS the drift null: what the signal added over doing
   * nothing clever. This is the honest edge number, and it is smaller than
   * `evPointPct` for every long cell — in a rising market most of a positive
   * expectancy is the market, not the model.
   */
  excessEvPct: number | null;
  winners: EquityWinnerExcursions | null;
}

export interface EquityExecutionSnapshot {
  generatedAt: number;
  /** How the numbers were produced, carried with them rather than in a doc. */
  method: {
    engine: string;
    lookbackYears: number;
    maxHoldSessions: number;
    costBpsRoundTrip: number;
    barsPerYear: number;
  };
  coverage: {
    symbols: number;
    firstDate: string;
    lastDate: string;
    sessionsEvaluated: number;
    /** Plans the engine printed, before any fill test. */
    plansPrinted: number;
    /**
     * Share of printed plans price actually reached within the entry window.
     * A plan nobody could fill is worthless, so this is published beside the
     * outcome statistics rather than buried.
     */
    reachRatePct: number;
    /** Plans that filled AND resolved — the sample the cells are built on. */
    trades: number;
  };
  cells: Record<string, EquityCell | undefined>;
  /** Stated limitations, published WITH the numbers so they travel together. */
  caveats: string[];
}

/**
 * The volatility bucket, read from the live engine's OWN volatility verdict
 * rather than recomputed here.
 *
 * `evaluateVolatilityRegime` maps an ATR percentile to a verdict with the
 * sign inverted (high volatility is the bearish end), so the verdict already
 * encodes the three buckets exactly. Deriving the bucket from a second
 * threshold of our own would be a competing definition of the same thing —
 * the defect the charter names.
 */
export function volRegimeFromMetrics(metrics: MetricVerdict[]): EquityVolRegime | null {
  const v = metrics.find((m) => m.id === "equityVolatilityRegime");
  if (!v) return null;
  if (v.verdict === "bearish") return "high-vol";
  if (v.verdict === "bullish") return "low-vol";
  if (v.verdict === "neutral") return "normal-vol";
  return null;
}

export function equityCellKey(side: EquitySide, vol: EquityVolRegime): string {
  return `${side}:${vol}`;
}

/**
 * The measured expectations for a live plan, or null when this bucket has no
 * publishable cell.
 *
 * Null is a first-class answer here. It happens when the volatility regime
 * could not be determined, or when the replay refused to publish the cell
 * for thin sample — and in both cases the honest output is the dossier's
 * existing "not measured" reason, never a borrowed number from a
 * neighbouring bucket.
 */
export function equityExpectationsFor(
  side: EquitySide,
  metrics: MetricVerdict[],
  snapshot: EquityExecutionSnapshot | null
): PlanExpectations | null {
  if (!snapshot) return null;
  const vol = volRegimeFromMetrics(metrics);
  if (!vol) return null;

  const key = equityCellKey(side, vol);
  const cell = snapshot.cells[key];
  if (!cell) return null;

  /*
   * Drawdown and run are quoted from WINNERS only, and that is the point:
   * the question a trader asks of a stop is "how much heat did the trades
   * that eventually worked make me take", not "how far did price go across
   * all trades including the ones that never came back". Null winners means
   * too few winning trades to describe their distribution, so those two
   * fields degrade rather than the whole cell.
   */
  return {
    evLowerPct: cell.evLowerPct,
    winRatePct: cell.winRatePct,
    n: cell.n,
    expectedDrawdownPct: cell.winners?.maeP80Pct ?? 0,
    expectedRunPct: cell.winners?.mfeP75Pct ?? null,
    medianHoldSessions: cell.medianHoldSessions,
    driftNullPct: cell.driftNullPct,
    excessEvPct: cell.excessEvPct,
    cellKey: key,
  };
}

/**
 * THE EQUITY EV GATE — the same gate crypto already runs, now fed by
 * equities' own measured record.
 *
 * `tradePlan.ts` has always refused a plan whose bucket loses money at the
 * pessimistic bound; equities simply had no record to check, so they were
 * never gated. The replay changed that, and it found something the page must
 * act on rather than merely display: EVERY short cell loses money, and loses
 * it by more than the drift it was already fighting.
 *
 * ── Why the gate is fed the DRIFT-ADJUSTED number ─────────────────────
 *
 * The raw expectancy of a long in a market that rose is mostly the market.
 * A gate that accepted it would be approving trades for doing what buying
 * and holding already did, at more cost and more risk. So the number handed
 * to the gate is expectancy at its Wilson lower bound MINUS the drift null:
 * the pessimistic estimate of what the signal itself contributed.
 *
 * Measured when this was wired (302,897 replayed trades):
 *   long:high-vol    +2.75 − 0.98 = +1.77   passes
 *   long:normal-vol  +1.21 − 0.83 = +0.38   passes
 *   long:low-vol     +0.83 − 0.68 = +0.15   passes, barely
 *   short:high-vol   −2.43 − (−0.68) = −1.75   REFUSED
 *   short:normal-vol −1.49 − (−0.53) = −0.96   REFUSED
 *   short:low-vol    −1.20 − (−0.46) = −0.74   REFUSED
 *
 * Policy, not measurement — and the split is load-bearing: the replay calls
 * `buildLiveAnalysis` WITHOUT constraints, so the gate can never starve the
 * evidence that justifies it. If a future regeneration turns a short cell
 * positive, the gate re-opens on its own with no code change.
 */
export function equityPlanConstraints(
  side: EquitySide,
  metrics: MetricVerdict[],
  snapshot: EquityExecutionSnapshot | null
): PlanConstraints | null {
  if (!snapshot) return null;
  const vol = volRegimeFromMetrics(metrics);
  if (!vol) return null;

  const key = equityCellKey(side, vol);
  const cell = snapshot.cells[key];
  if (!cell) return null;

  /*
   * No drift null measured means no honest adjustment available. Falling
   * back to the raw bound is the conservative choice for shorts (it is more
   * negative than the adjusted one) and merely lenient for longs, which is
   * the right direction for a gate that should refuse on evidence rather
   * than on the absence of it.
   */
  const gateEv = cell.driftNullPct === null ? cell.evLowerPct : cell.evLowerPct - cell.driftNullPct;

  return {
    cellKey: key,
    n: cell.n,
    evLowerPct: gateEv,
    winnersMaeP50Pct: cell.winners?.maeP50Pct ?? null,
    winnersMaeP80Pct: cell.winners?.maeP80Pct ?? null,
    winnersMfeP75Pct: cell.winners?.mfeP75Pct ?? null,
  };
}
