import type { Bar } from "./types";

/**
 * THE REFLECTION-PRINCIPLE TOUCH PROBABILITY, AND THE SIGMA IT WAS
 * CALIBRATED AGAINST.
 *
 * One source. `scripts/research/touchCalibrationGrid.ts` measures the bias
 * of exactly these formulas over 32 years and imports them from here, so
 * the bias in `touchCalibration.json` describes THIS code and not a cousin
 * of it. A consumer that pairs `pTouchUp` with a correction from
 * `conversionReport` must also pair it with `trailingSigmaAnnualized` —
 * the correction was measured against the 60-session trailing estimate,
 * and feeding a different sigma detaches the correction from its
 * calibration.
 *
 * Conventions, pinned by the calibration study and its tests:
 *  - Barriers in LOG space, asymmetric: b_up = ln(1+m), b_down = -ln(1-m).
 *    A 10% fall is a larger log-move than a 10% rise; using the up-side
 *    number for both understates down-touch by 3.5-6.6pp at the
 *    volatilities this account trades.
 *  - Drift mu = -sigma^2/2 (zero expected simple return). The down side is
 *    the reflection X -> -X, which FLIPS the drift sign — `pTouchDown`
 *    exists so no caller reimplements that flip wrong, which is exactly
 *    the error the trading session's reproduction script carried.
 */

/** Abramowitz-Stegun 7.1.26. */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}

export const Phi = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

/** P(max of log-price with drift mu, vol sigma, over T years, reaches +b). b > 0. */
export function pTouchUp(b: number, sigma: number, T: number, mu: number): number {
  const sT = sigma * Math.sqrt(T);
  if (!(sT > 0)) return 0;
  const v =
    Phi((mu * T - b) / sT) + Math.exp((2 * mu * b) / (sigma * sigma)) * Phi((-b - mu * T) / sT);
  return Math.min(1, Math.max(0, v));
}

/** P(min reaches -b). Reflection X -> -X, which flips the drift. */
export const pTouchDown = (b: number, sigma: number, T: number, mu: number): number =>
  pTouchUp(b, sigma, T, -mu);

/** The trailing window the calibration was measured against. Not a tunable. */
export const TRAILING_VOL_SESSIONS = 60;

/**
 * Annualised sigma from a slice of log returns — the calibration study's
 * own estimator, verbatim: mean-removed, Bessel-corrected, sqrt(252),
 * null outside (0.01, 6) where the estimate is degenerate.
 */
export function sigmaOfLogReturns(logRet: readonly number[], from: number, to: number): number | null {
  const n = to - from;
  if (n < 5) return null;
  let s = 0;
  for (let i = from; i < to; i++) s += logRet[i];
  const m = s / n;
  let v = 0;
  for (let i = from; i < to; i++) v += (logRet[i] - m) ** 2;
  const sd = Math.sqrt(v / (n - 1));
  const ann = sd * Math.sqrt(252);
  return ann > 0.01 && ann < 6 ? ann : null;
}

/**
 * The trailing sigma at the END of a bar series — what a caller planning a
 * trade tonight actually has. Needs TRAILING_VOL_SESSIONS + 1 closes.
 */
export function trailingSigmaAnnualized(bars: readonly Bar[]): number | null {
  if (bars.length < TRAILING_VOL_SESSIONS + 1) return null;
  const logRet: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].close, b = bars[i].close;
    logRet.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  return sigmaOfLogReturns(logRet, logRet.length - TRAILING_VOL_SESSIONS, logRet.length);
}
