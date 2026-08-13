/**
 * Is the confidence score actually calibrated?
 *
 * The dashboard prints "Confidence 64/100" next to a directional call. A
 * reader will inevitably read that as "about 64% likely to be right" — and
 * nothing in the codebase has ever checked whether that reading is
 * defensible. marketBias.ts is careful to define confidence as EVIDENCE
 * QUALITY rather than probability, but a number between 0 and 100 sitting
 * beside a market call does not get to rely on a doc comment for its
 * interpretation.
 *
 * This module answers the question empirically: bucket historical days by
 * the confidence the engine reported at the time, then measure how often
 * the call actually went the right way afterwards. Two things matter, and
 * they are different:
 *
 *   MONOTONICITY — does higher confidence produce better outcomes? This is
 *   the weaker, more achievable claim, and the one that actually makes the
 *   score useful for ranking setups.
 *
 *   CALIBRATION — does 64 confidence mean 64% favourable? This is the
 *   strong claim, and the one that must NOT be assumed.
 *
 * A score can be usefully monotonic while being badly calibrated. Reporting
 * both separately is the entire point; collapsing them would smuggle the
 * strong claim in behind the weak one.
 */

import { wilsonInterval, ProportionInterval } from "./metrics";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

export interface CalibrationInput {
  /** The engine's own reported confidence at that timestamp, 0-100. */
  confidence: number;
  verdict: string;
  /** Forward return over the horizon being calibrated against. */
  forwardReturnPct: number | null;
}

export interface CalibrationBucket {
  label: string;
  lowerBound: number;
  upperBound: number;
  n: number;
  /** Share of days where the verdict's direction matched the forward move. */
  observedRatePct: number;
  interval: ProportionInterval;
  /** Midpoint of the bucket — what the score would imply IF it were a probability. */
  impliedRatePct: number;
  /** observed - implied. Positive means the engine was underconfident in this band. */
  calibrationErrorPct: number;
}

export interface CalibrationReport {
  horizon: string;
  buckets: CalibrationBucket[];
  /** Mean absolute gap between implied and observed across buckets with enough data. */
  meanAbsoluteCalibrationErrorPct: number | null;
  /**
   * True only when observed rates never DECREASE as confidence rises.
   * Weaker than calibration and reported separately on purpose.
   */
  monotonic: boolean | null;
  /** Plain-language verdict, written from the numbers rather than asserted. */
  interpretation: string;
}

const BUCKET_BOUNDS: Array<[number, number]> = [
  [0, 20],
  [20, 40],
  [40, 60],
  [60, 80],
  [80, 100],
];

/** Directional hit: a bullish call wants a positive move, a bearish call a negative one. Neutral days have no direction to score and are excluded. */
function isFavourable(verdict: string, forwardReturnPct: number): boolean {
  return verdict === "bullish" ? forwardReturnPct > 0 : forwardReturnPct < 0;
}

export function buildCalibration(inputs: CalibrationInput[], horizon: string): CalibrationReport {
  const scored = inputs.filter((i) => i.verdict !== "neutral" && i.forwardReturnPct !== null);

  const buckets: CalibrationBucket[] = [];
  for (const [lowerBound, upperBound] of BUCKET_BOUNDS) {
    // Upper-inclusive only on the top bucket, so a confidence of exactly
    // 100 lands somewhere and 40 doesn't get counted twice.
    const inBucket = scored.filter(
      (i) => i.confidence >= lowerBound && (upperBound === 100 ? i.confidence <= 100 : i.confidence < upperBound)
    );
    if (inBucket.length < MIN_SAMPLE_N) continue;

    const hits = inBucket.filter((i) => isFavourable(i.verdict, i.forwardReturnPct as number)).length;
    const interval = wilsonInterval(hits, inBucket.length)!;
    const observedRatePct = (hits / inBucket.length) * 100;
    const impliedRatePct = (lowerBound + upperBound) / 2;

    buckets.push({
      label: `${lowerBound}-${upperBound}`,
      lowerBound,
      upperBound,
      n: inBucket.length,
      observedRatePct,
      interval,
      impliedRatePct,
      calibrationErrorPct: observedRatePct - impliedRatePct,
    });
  }

  const meanAbsoluteCalibrationErrorPct = buckets.length
    ? buckets.reduce((s, b) => s + Math.abs(b.calibrationErrorPct), 0) / buckets.length
    : null;

  const monotonic =
    buckets.length < 2 ? null : buckets.every((b, i) => i === 0 || b.observedRatePct >= buckets[i - 1].observedRatePct);

  return {
    horizon,
    buckets,
    meanAbsoluteCalibrationErrorPct,
    monotonic,
    interpretation: interpret(buckets, monotonic, meanAbsoluteCalibrationErrorPct),
  };
}

/**
 * Writes the conclusion FROM the numbers. Kept as its own function so the
 * wording can never drift from the data it describes — and so the
 * "insufficient data" case produces an explicit statement rather than a
 * confident-sounding sentence built on two buckets.
 */
function interpret(buckets: CalibrationBucket[], monotonic: boolean | null, mace: number | null): string {
  if (buckets.length < 2 || mace === null) {
    return "Not enough days in enough confidence bands to say anything about calibration. The score should not be read as a probability.";
  }

  const spread = buckets[buckets.length - 1].observedRatePct - buckets[0].observedRatePct;
  const direction =
    monotonic === true
      ? `Higher confidence did correspond to better outcomes across every band (${buckets[0].observedRatePct.toFixed(0)}% at ${buckets[0].label} rising to ${buckets[buckets.length - 1].observedRatePct.toFixed(0)}% at ${buckets[buckets.length - 1].label}).`
      : `Higher confidence did NOT reliably correspond to better outcomes — the observed rate falls somewhere as confidence rises, so the score does not cleanly rank setups.`;

  const calibrated =
    mace <= 5
      ? `Observed rates sit within ${mace.toFixed(1)} points of what the score implies, so reading it roughly as a probability is defensible.`
      : `Observed rates differ from the score's implied probability by ${mace.toFixed(1)} points on average, so this is NOT a probability and must not be presented as one.`;

  const magnitude =
    Math.abs(spread) < 5
      ? " The spread between the least and most confident bands is under 5 points, which is small enough that confidence adds little discriminating power in practice."
      : "";

  return `${direction} ${calibrated}${magnitude}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * SCORE-BUCKET × TREND-REGIME CALIBRATION — the redesign's §9 headline
 * quantity ("Calibrated Probability"): the empirical hit rate of reads
 * like TODAY's, meaning the same direction, the same score strength, and
 * the same trend regime. Confidence-band calibration above turned out
 * degenerate (98% of days in one band); score direction/strength and
 * regime are the dimensions that actually vary day to day.
 *
 * Each cell also carries the DRIFT NULL — what blind exposure in that
 * direction earned inside that regime — because a bullish read during
 * bull-tagged days must beat bull-day drift, not a coin (H1, same rule as
 * every other cell in the census). Cells thinner than MIN_SAMPLE_N are
 * still emitted with their n so a lookup can say "uncalibrated" with the
 * reason, rather than silently borrowing the global rate.
 * ──────────────────────────────────────────────────────────────────────── */

export type TrendRegime = "bull" | "bear" | "neutral";
export type ScoreStrength = "leaning" | "clear";

export interface ScoreCalibrationInput {
  score: number;
  verdict: string;
  /** The day's trend tag: "bull"/"bear" if tagged, else "neutral". */
  trendRegime: TrendRegime;
  forwardReturnPct: number | null;
  /** 1 if the read's direction matched blind drift for this row's asset — supplied by the caller as the per-row null probability (see buildNullLookup). */
  nullProb: number;
}

export interface ScoreCalibrationCell {
  /** `${direction}:${strength}:${trendRegime}` */
  key: string;
  n: number;
  /** Independent observations after the two-correlated-assets-per-day discount. */
  effectiveN: number;
  hitRatePct: number;
  /** Wilson 95% interval on the hit rate. */
  interval: ProportionInterval;
  /** Exposure-weighted drift null for this cell, %. The number the hit rate must beat. */
  nullRatePct: number;
  /** hitRatePct − nullRatePct, percentage points. */
  edgePP: number;
  /** True when n clears MIN_SAMPLE_N — the gate a UI must respect before quoting the rate. */
  calibrated: boolean;
}

/**
 * The boundary between a "leaning" and a "clear" read is intensityLabel's
 * own 15-point threshold (scoring.ts) — the cell definition must match the
 * vocabulary the UI already prints, or the quoted rate describes a
 * different population than the label the user is reading.
 */
const CLEAR_SCORE_DISTANCE = 15;

export function scoreCellKey(score: number, verdict: string, trendRegime: TrendRegime): string | null {
  if (verdict !== "bullish" && verdict !== "bearish") return null; // neutral asserts no direction — nothing to calibrate
  const strength: ScoreStrength = Math.abs(score - 50) >= CLEAR_SCORE_DISTANCE ? "clear" : "leaning";
  return `${verdict}:${strength}:${trendRegime}`;
}

export function trendRegimeOf(regimeTags: string[]): TrendRegime {
  if (regimeTags.includes("bull")) return "bull";
  if (regimeTags.includes("bear")) return "bear";
  return "neutral";
}

export function buildScoreRegimeCalibration(
  inputs: ScoreCalibrationInput[],
  /** Dependent-run length for the effective-n discount — blockLengthFor("24h", assetsPerDay) at the call site. */
  blockLength: number
): Record<string, ScoreCalibrationCell> {
  const byCell = new Map<string, ScoreCalibrationInput[]>();
  for (const i of inputs) {
    if (i.forwardReturnPct === null) continue;
    const key = scoreCellKey(i.score, i.verdict, i.trendRegime);
    if (!key) continue;
    const list = byCell.get(key) ?? [];
    list.push(i);
    byCell.set(key, list);
  }

  const cells: Record<string, ScoreCalibrationCell> = {};
  for (const [key, list] of byCell) {
    const hits = list.filter((i) => isFavourable(i.verdict, i.forwardReturnPct as number)).length;
    const interval = wilsonInterval(hits, list.length);
    if (!interval) continue;
    const nullRate = list.reduce((s, i) => s + i.nullProb, 0) / list.length;
    cells[key] = {
      key,
      n: list.length,
      effectiveN: Math.round(list.length / Math.max(1, blockLength)),
      hitRatePct: (hits / list.length) * 100,
      interval,
      nullRatePct: nullRate * 100,
      edgePP: (hits / list.length - nullRate) * 100,
      calibrated: list.length >= MIN_SAMPLE_N,
    };
  }
  return cells;
}
