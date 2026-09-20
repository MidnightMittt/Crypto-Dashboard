import { POSITION, THRESHOLDS } from "./config";
import { FeeSeriesRow } from "./feeSeries";
import { PositionCard } from "./lpPosition";
import { lvrCoverage } from "./uniV3Math";

/**
 * LP ALERTS — measure and warn, never recommend.
 *
 * Every alert here states a fact and a threshold. None says buy, sell, add or
 * exit: "tick reached the review level" is an observation; what to do about it
 * lives with the trading session, not this file. That line is the whole
 * constraint of this build and it is enforced by the wording, so the wording is
 * part of the contract.
 *
 * ── Fired on TRANSITIONS, so the channel is not spam ──────────────────
 *
 * The monitor runs every 6h. An alert that re-fired every run while a
 * condition held would teach the reader to ignore the channel — the same
 * failure the watch levels avoid by firing once. Here there is no separate
 * fired-state store: the alert fires when the condition is TRUE NOW and was
 * FALSE on the previous row. The series is the state. A condition that clears
 * and returns fires again, which is correct — it is a new crossing.
 */

export interface LpAlert {
  key: "review_tick" | "range_exit" | "lvr_uncovered" | "series_gap";
  severity: "review" | "warn";
  message: string;
}

/** Min tick observations before a volatility-derived figure is trustworthy. */
export const MIN_SIGMA_ROWS = 12;

/**
 * Daily volatility of PONS from the pool's OWN tick series.
 *
 * PONS_usd ∝ 1 / 1.0001^tick, so the log return of PONS between two rows is
 * -(Δtick) * ln(1.0001). Sigma is the stdev of those per-step log returns,
 * scaled from the mean sampling gap to one day. Returns the figure AND the
 * window it was measured over, because a sigma without its window is not a
 * number a reader can argue with. Refuses (null) below MIN_SIGMA_ROWS — the
 * MIN_ENTRIES culture applied to volatility.
 */
export function ponsDailySigmaFromTicks(
  rows: readonly FeeSeriesRow[]
): { sigma: number; windowRows: number; windowHours: number } | null {
  const samples = rows.filter((r) => r.kind === "sample");
  if (samples.length < MIN_SIGMA_ROWS) return null;
  const ln10001 = Math.log(1.0001);
  const rets: number[] = [];
  const gapsH: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dTick = samples[i].tick - samples[i - 1].tick;
    rets.push(-dTick * ln10001);
    gapsH.push((Date.parse(samples[i].ts) - Date.parse(samples[i - 1].ts)) / 3_600_000);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const perStepSigma = Math.sqrt(variance);
  const meanGapH = gapsH.reduce((s, x) => s + x, 0) / gapsH.length;
  if (!(meanGapH > 0)) return null;
  // Scale per-step sigma to one day by sqrt of steps-per-day.
  const stepsPerDay = 24 / meanGapH;
  const sigma = perStepSigma * Math.sqrt(stepsPerDay);
  const windowHours = (Date.parse(samples[samples.length - 1].ts) - Date.parse(samples[0].ts)) / 3_600_000;
  return { sigma, windowRows: samples.length, windowHours };
}

/**
 * Evaluate the LP alerts for the row about to be written, against the previous
 * row and the series behind it. `newRow` is the row nextRow() produced.
 */
export function evaluateLpAlerts(
  card: PositionCard,
  newRow: FeeSeriesRow,
  priorRows: readonly FeeSeriesRow[]
): LpAlert[] {
  const alerts: LpAlert[] = [];
  const prev = [...priorRows].reverse().find((r) => r.kind === "sample");

  // 1. Review tick crossed upward through 85596 (PONS ~$0.50, 85% through range).
  const nowAtReview = card.currentTick >= THRESHOLDS.reviewTick;
  const wasAtReview = prev ? prev.tick >= THRESHOLDS.reviewTick : false;
  if (nowAtReview && !wasAtReview) {
    alerts.push({
      key: "review_tick",
      severity: "review",
      message:
        `LP review level: tick ${card.currentTick} reached ${THRESHOLDS.reviewTick} ` +
        `(${(card.pctThroughRange * 100).toFixed(0)}% through the ${POSITION.tickLower}..${POSITION.tickUpper} range, ` +
        `PONS ≈ $${card.ponsUsd.toFixed(3)}). A review prompt, not a trade instruction.`,
    });
  }

  // 2. Range exit, either side. Fires on the transition into out-of-range.
  const wasInRange = prev ? prev.tick >= POSITION.tickLower && prev.tick < POSITION.tickUpper : true;
  if (!card.inRange && wasInRange) {
    const side = card.currentTick < POSITION.tickLower ? "below" : "above";
    alerts.push({
      key: "range_exit",
      severity: "warn",
      message:
        `LP OUT OF RANGE: tick ${card.currentTick} exited ${side} ${POSITION.tickLower}..${POSITION.tickUpper}. ` +
        `The position earns no fees until price re-enters the range.`,
    });
  }

  // 3. LVR coverage < 1.0 — fees not paying for the volatility's implied IL.
  //    Uses PONS sigma from the pool's own tick series; refuses below MIN rows.
  const sig = ponsDailySigmaFromTicks([...priorRows, newRow]);
  if (sig && newRow.fee_rate_usd_per_day !== null && card.usdValue !== null) {
    const cov = lvrCoverage({
      feeRateUsdPerDay: newRow.fee_rate_usd_per_day,
      dailySigma: sig.sigma,
      positionValueUsd: card.usdValue,
    });
    if (cov && cov.coverage < 1) {
      alerts.push({
        key: "lvr_uncovered",
        severity: "warn",
        message:
          `LP fees not covering LVR: rate $${newRow.fee_rate_usd_per_day.toFixed(2)}/day vs ` +
          `LVR $${cov.lvrUsdPerDay.toFixed(2)}/day (coverage ${cov.coverage.toFixed(2)}). ` +
          `PONS σ ${(sig.sigma * 100).toFixed(1)}%/day from ${sig.windowRows} ticks over ` +
          `${sig.windowHours.toFixed(0)}h; LVR = σ²/8 × value.`,
      });
    }
  }

  // 4. Series gap > 12h — the watcher watching the watcher.
  if (newRow.gap_hours !== null && newRow.gap_hours > THRESHOLDS.seriesGapAlertHours) {
    alerts.push({
      key: "series_gap",
      severity: "warn",
      message:
        `LP fee series gap: ${newRow.gap_hours.toFixed(1)}h since the last read ` +
        `(cadence target ${THRESHOLDS.cadenceHours}h). The monitor under-sampled — a rate across ` +
        `this gap is an average over an unwatched window.`,
    });
  }

  return alerts;
}
