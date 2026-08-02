/**
 * Pure technical-indicator math. No I/O, no app types, no interpretation —
 * this file only turns a price series into numbers. Whether those numbers
 * are bullish, and how they're phrased, lives in sentiment/technicals.ts.
 *
 * ── Two conventions that matter, and are easy to get wrong ─────────────
 *
 * 1. WILDER'S SMOOTHING, NOT A PLAIN EMA. RSI, ATR and ADX are all defined
 *    by Wilder with a smoothing factor of 1/n, which is equivalent to an
 *    EMA of period (2n - 1) — NOT an EMA of period n. Using `ema(xs, 14)`
 *    for these would produce numbers that look completely reasonable and
 *    are consistently wrong. `wilderSmooth` below is deliberately separate
 *    from `ema` so the two can never be confused at a call site.
 *
 * 2. SERIES ARE OLDEST-FIRST. Every function here assumes index 0 is the
 *    oldest bar. OKX returns candles newest-first, so the provider reverses
 *    them before they ever reach this file.
 *
 * Every function returns null rather than computing on too short a series —
 * a half-formed RSI is worse than no RSI, and matches the "missing data must
 * not quietly read as neutral" rule the rest of this app follows.
 */

export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote-currency (USD) volume — comparable across assets, unlike contract counts. */
  volumeUsd: number;
}

/** Simple mean. Callers guarantee non-empty. */
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Exponential moving average over the whole series, returning the final
 * value. Seeded with the SMA of the first `period` values — the standard
 * convention, and the one that makes short series behave predictably.
 */
export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) {
    acc = values[i] * k + acc * (1 - k);
  }
  return acc;
}

/** Full EMA series (same seeding as `ema`), oldest-first, starting at index `period - 1`. */
function emaSeries(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [mean(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    out.push(values[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

/**
 * Wilder's smoothing: seed with the mean of the first `period` values, then
 * acc = acc + (x - acc)/period. See this file's header for why this is not
 * interchangeable with `ema`.
 */
function wilderSmooth(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const out: number[] = [mean(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    const prev = out[out.length - 1];
    out.push(prev + (values[i] - prev) / period);
  }
  return out;
}

/** Wilder's RSI. 0-100; above 70 conventionally overbought, below 30 oversold. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }

  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);
  if (avgGain.length === 0 || avgLoss.length === 0) return null;

  const g = avgGain[avgGain.length - 1];
  const l = avgLoss[avgLoss.length - 1];

  // No down-moves in the window: RSI is 100 by definition, and guarding here
  // avoids a divide-by-zero producing NaN.
  if (l === 0) return g === 0 ? 50 : 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

/** MACD(12, 26, 9). Histogram > 0 means the fast line is above its signal. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult | null {
  if (closes.length < slow + signalPeriod) return null;

  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  if (fastSeries.length === 0 || slowSeries.length === 0) return null;

  /*
   * The two EMA series start at different bars (fast begins earlier), so they
   * must be aligned from the RIGHT before subtracting. Zipping them from
   * index 0 would silently subtract values from different dates — a bug that
   * still produces a plausible-looking curve.
   */
  const n = Math.min(fastSeries.length, slowSeries.length);
  const fastTail = fastSeries.slice(fastSeries.length - n);
  const slowTail = slowSeries.slice(slowSeries.length - n);
  const macdLine = fastTail.map((v, i) => v - slowTail[i]);

  const signalSeries = emaSeries(macdLine, signalPeriod);
  if (signalSeries.length === 0) return null;

  const macdValue = macdLine[macdLine.length - 1];
  const signalValue = signalSeries[signalSeries.length - 1];
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

/** True range for bar `i` (requires i >= 1 for the previous close). */
function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    out.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return out;
}

/** Wilder's ATR — absolute price units. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const smoothed = wilderSmooth(trueRanges(candles), period);
  return smoothed.length ? smoothed[smoothed.length - 1] : null;
}

/**
 * Wilder's ADX — trend STRENGTH, with no direction of its own. Above ~25 is
 * conventionally a trending market, below ~20 a ranging one.
 *
 * Needs roughly 2x period of bars: one period to smooth the directional
 * movement, another to smooth DX into ADX.
 */
export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2 + 1) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    // Only the larger move counts, and only when positive — Wilder's rule.
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const tr = trueRanges(candles);
  const smoothedTr = wilderSmooth(tr, period);
  const smoothedPlus = wilderSmooth(plusDM, period);
  const smoothedMinus = wilderSmooth(minusDM, period);
  if (smoothedTr.length === 0) return null;

  const dx: number[] = [];
  for (let i = 0; i < smoothedTr.length; i++) {
    const trv = smoothedTr[i];
    if (trv === 0) continue;
    const plusDi = (smoothedPlus[i] / trv) * 100;
    const minusDi = (smoothedMinus[i] / trv) * 100;
    const sum = plusDi + minusDi;
    if (sum === 0) continue;
    dx.push((Math.abs(plusDi - minusDi) / sum) * 100);
  }

  if (dx.length < period) return null;
  const adxSeries = wilderSmooth(dx, period);
  return adxSeries.length ? adxSeries[adxSeries.length - 1] : null;
}

/** Directional bias from +DI vs -DI. Separate from `adx`, which is strength only. */
export function directionalBias(candles: Candle[], period = 14): "up" | "down" | null {
  if (candles.length < period + 1) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothedPlus = wilderSmooth(plusDM, period);
  const smoothedMinus = wilderSmooth(minusDM, period);
  if (smoothedPlus.length === 0 || smoothedMinus.length === 0) return null;

  const p = smoothedPlus[smoothedPlus.length - 1];
  const m = smoothedMinus[smoothedMinus.length - 1];
  if (p === m) return null;
  return p > m ? "up" : "down";
}

/**
 * Volume-weighted average price over the trailing `period` bars.
 *
 * NOTE this is a ROLLING VWAP, not the session-anchored VWAP an intraday
 * trader means by the term. Session anchoring needs intraday bars and a
 * defined session open; on daily candles a rolling window is the honest
 * equivalent, and is labelled as such wherever it surfaces.
 */
export function rollingVwap(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  const totalVolume = window.reduce((s, c) => s + c.volumeUsd, 0);
  if (totalVolume <= 0) return null;
  // Typical price, the standard VWAP input — not the close.
  const weighted = window.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volumeUsd, 0);
  return weighted / totalVolume;
}

/** Latest bar's volume as a multiple of the trailing average (1.0 = exactly average). */
export function volumeRatio(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const prior = candles.slice(candles.length - period - 1, candles.length - 1);
  const avg = mean(prior.map((c) => c.volumeUsd));
  if (avg <= 0) return null;
  return candles[candles.length - 1].volumeUsd / avg;
}

export type TrendStructure = "higher-highs" | "lower-lows" | "sideways";

/**
 * Swing structure over the last `lookback` bars, judged by comparing the
 * most recent half against the previous half. Deliberately coarse: precise
 * swing-point detection is a genuine judgment call with no single correct
 * definition, and this app's convention is to prefer a simple, explainable
 * rule over a precise-looking one that hides its assumptions.
 */
export function trendStructure(candles: Candle[], lookback = 20): TrendStructure | null {
  if (candles.length < lookback) return null;
  const window = candles.slice(candles.length - lookback);
  const half = Math.floor(lookback / 2);
  const older = window.slice(0, half);
  const recent = window.slice(window.length - half);

  const olderHigh = Math.max(...older.map((c) => c.high));
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const olderLow = Math.min(...older.map((c) => c.low));
  const recentLow = Math.min(...recent.map((c) => c.low));

  if (recentHigh > olderHigh && recentLow > olderLow) return "higher-highs";
  if (recentHigh < olderHigh && recentLow < olderLow) return "lower-lows";
  return "sideways";
}

/** Final close, or null on an empty series. */
export function lastClose(candles: Candle[]): number | null {
  return candles.length ? candles[candles.length - 1].close : null;
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}
