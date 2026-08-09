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

/**
 * Full Wilder's RSI series, oldest-first. Shared by `rsi()` (last value) and
 * `rsiSeries()` (the whole series — divergence detection needs the history,
 * not just today's reading). Identical computation either way; only how much
 * of the result is kept differs.
 */
function rsiFull(closes: number[], period: number): number[] {
  if (closes.length < period + 1) return [];

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gains.push(Math.max(delta, 0));
    losses.push(Math.max(-delta, 0));
  }

  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);
  if (avgGain.length === 0 || avgLoss.length === 0) return [];

  const n = Math.min(avgGain.length, avgLoss.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    // No down-moves in the window: RSI is 100 by definition, and guarding
    // here avoids a divide-by-zero producing NaN.
    out.push(l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  }
  return out;
}

/** Wilder's RSI. 0-100; above 70 conventionally overbought, below 30 oversold. */
export function rsi(closes: number[], period = 14): number | null {
  const series = rsiFull(closes, period);
  return series.length ? series[series.length - 1] : null;
}

/** Full RSI series, oldest-first — for divergence detection against price swings. */
export function rsiSeries(closes: number[], period = 14): number[] {
  return rsiFull(closes, period);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * Full MACD line/signal/histogram series, oldest-first, all three arrays
 * tail-aligned to the same length. Shared by `macd()` (last value) and
 * `macdHistogramSeries()` (the whole histogram — divergence detection needs
 * the history). Same right-alignment convention as the macdLine/signalSeries
 * merge below: EMA series of different periods start at different bars, so
 * they're always sliced from the RIGHT before combining, never zipped from
 * index 0.
 */
function macdFull(
  closes: number[],
  fast: number,
  slow: number,
  signalPeriod: number
): { macdLine: number[]; signalSeries: number[]; histogramSeries: number[] } | null {
  if (closes.length < slow + signalPeriod) return null;

  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  if (fastSeries.length === 0 || slowSeries.length === 0) return null;

  const n = Math.min(fastSeries.length, slowSeries.length);
  const fastTail = fastSeries.slice(fastSeries.length - n);
  const slowTail = slowSeries.slice(slowSeries.length - n);
  const macdLine = fastTail.map((v, i) => v - slowTail[i]);

  const signalSeries = emaSeries(macdLine, signalPeriod);
  if (signalSeries.length === 0) return null;

  const m = Math.min(macdLine.length, signalSeries.length);
  const macdTail = macdLine.slice(macdLine.length - m);
  const signalTail = signalSeries.slice(signalSeries.length - m);
  const histogramSeries = macdTail.map((v, i) => v - signalTail[i]);

  return { macdLine: macdTail, signalSeries: signalTail, histogramSeries };
}

/** MACD(12, 26, 9). Histogram > 0 means the fast line is above its signal. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult | null {
  const full = macdFull(closes, fast, slow, signalPeriod);
  if (!full) return null;
  const { macdLine, signalSeries, histogramSeries } = full;
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalSeries[signalSeries.length - 1],
    histogram: histogramSeries[histogramSeries.length - 1],
  };
}

/** Full MACD histogram series, oldest-first — for divergence detection against price swings. */
export function macdHistogramSeries(closes: number[], fast = 12, slow = 26, signalPeriod = 9): number[] {
  const full = macdFull(closes, fast, slow, signalPeriod);
  return full ? full.histogramSeries : [];
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

export function highs(candles: Candle[]): number[] {
  return candles.map((c) => c.high);
}

export function lows(candles: Candle[]): number[] {
  return candles.map((c) => c.low);
}

// ─────────────────────────────────────────────────────────────────────────
// Seven additional indicators. Same conventions as above: pure, oldest-
// first, null on insufficient data. Each is verified in indicators.test.ts
// against either a published reference or a mathematical identity that
// must hold by construction — the same bar RSI was held to.
// ─────────────────────────────────────────────────────────────────────────

export interface BollingerBandsResult {
  middle: number;
  upper: number;
  lower: number;
  /** Band width as a percentage of the middle band — a volatility-squeeze read. */
  bandwidthPct: number;
}

/** 20-period SMA +/- 2 standard deviations — the textbook default. */
export function bollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): BollingerBandsResult | null {
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  const middle = mean(window);
  const variance = mean(window.map((c) => (c - middle) ** 2));
  const stdDev = Math.sqrt(variance);
  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  return { middle, upper, lower, bandwidthPct: middle !== 0 ? ((upper - lower) / middle) * 100 : 0 };
}

export interface StochasticResult {
  /** Where the close sits within the trailing high-low range, 0-100. */
  k: number;
  /** 3-period SMA of %K — the signal line. */
  d: number;
}

/** %K over every bar from `period - 1` onward, oldest-first — needed to build %D. */
function stochasticKSeries(candles: Candle[], period: number): number[] {
  const out: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const highestHigh = Math.max(...window.map((c) => c.high));
    const lowestLow = Math.min(...window.map((c) => c.low));
    const range = highestHigh - lowestLow;
    // A flat range has no "position within the range" — 50 is the honest
    // midpoint reading, not an overbought or oversold claim.
    out.push(range === 0 ? 50 : ((candles[i].close - lowestLow) / range) * 100);
  }
  return out;
}

/** 14-period stochastic oscillator with a 3-period %D signal line. */
export function stochastic(candles: Candle[], period = 14, dPeriod = 3): StochasticResult | null {
  if (candles.length < period) return null;
  const kSeries = stochasticKSeries(candles, period);
  if (kSeries.length === 0) return null;
  return { k: kSeries[kSeries.length - 1], d: mean(kSeries.slice(-dPeriod)) };
}

/**
 * On-Balance Volume — cumulative volume, signed by the day's close
 * direction. Returns the FULL series rather than one number: OBV only
 * means something relative to its own recent trend (is it rising or
 * falling), never as a single absolute value.
 */
export function obv(candles: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[out.length - 1];
    if (candles[i].close > candles[i - 1].close) out.push(prev + candles[i].volumeUsd);
    else if (candles[i].close < candles[i - 1].close) out.push(prev - candles[i].volumeUsd);
    else out.push(prev);
  }
  return out;
}

/** Whether OBV has risen or fallen over the trailing `lookback` bars — the confirmation read. */
export function obvTrend(candles: Candle[], lookback = 20): "up" | "down" | null {
  const series = obv(candles);
  if (series.length <= lookback) return null;
  const now = series[series.length - 1];
  const then = series[series.length - 1 - lookback];
  if (now === then) return null;
  return now > then ? "up" : "down";
}

/** Full Wilder-smoothed ATR series (unlike `atr`, which returns only the latest value). */
function atrSeries(candles: Candle[], period: number): number[] {
  return wilderSmooth(trueRanges(candles), period);
}

export interface SupertrendResult {
  value: number;
  direction: "up" | "down";
}

/**
 * ATR-band flip system: price crossing the current band flips the trend,
 * and the opposite band becomes the new stop. Standard 10-period ATR, 3x
 * multiplier.
 *
 * Genuinely iterative — unlike every other indicator in this file, a given
 * day's value depends on the accumulated state of every prior day, not
 * just a fixed lookback window. Verified against behavioral identities
 * (a monotonic trend never flips; a hand-built reversal flips at the
 * expected bar) rather than a single published numeric table, since none
 * of the commonly cited worked examples specify their exact OHLC inputs
 * precisely enough to reproduce bit-for-bit.
 */
export function supertrend(candles: Candle[], period = 10, multiplier = 3): SupertrendResult | null {
  const atrValues = atrSeries(candles, period);
  if (atrValues.length < 2) return null;

  const offset = candles.length - atrValues.length; // atrValues[j] <-> candles[j + offset]
  let prevFinalUpper: number | null = null;
  let prevFinalLower: number | null = null;
  let prevValue: number | null = null;
  let direction: "up" | "down" = "up";

  for (let j = 0; j < atrValues.length; j++) {
    const i = j + offset;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + multiplier * atrValues[j];
    const basicLower = mid - multiplier * atrValues[j];

    let finalUpper = basicUpper;
    let finalLower = basicLower;

    if (prevFinalUpper !== null && prevFinalLower !== null) {
      const prevClose = candles[i - 1].close;
      finalUpper = basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
      finalLower = basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;
    }

    let value: number;
    if (prevValue === null) {
      direction = c.close > mid ? "up" : "down";
      value = direction === "up" ? finalLower : finalUpper;
    } else if (direction === "down") {
      if (c.close > finalUpper) {
        direction = "up";
        value = finalLower;
      } else {
        value = finalUpper;
      }
    } else {
      if (c.close < finalLower) {
        direction = "down";
        value = finalUpper;
      } else {
        value = finalLower;
      }
    }

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevValue = value;
  }

  return { value: prevValue!, direction };
}

export interface ParabolicSarResult {
  value: number;
  direction: "up" | "down";
}

const SAR_AF_STEP = 0.02;
const SAR_AF_MAX = 0.2;

/**
 * Standard Parabolic SAR: an accelerating stop-and-reverse level that
 * trails price, flipping sides when price crosses it.
 *
 * Same caveat as `supertrend` — genuinely iterative, verified against
 * structural invariants the algorithm guarantees by construction (SAR
 * never sits above price during an uptrend, never below it during a
 * downtrend, and a clean reversal flips direction) rather than a
 * bit-for-bit published table.
 */
export function parabolicSar(candles: Candle[]): ParabolicSarResult | null {
  if (candles.length < 3) return null;

  let uptrend = candles[1].close >= candles[0].close;
  let sar = uptrend ? Math.min(candles[0].low, candles[1].low) : Math.max(candles[0].high, candles[1].high);
  let ep = uptrend ? Math.max(candles[0].high, candles[1].high) : Math.min(candles[0].low, candles[1].low);
  let af = SAR_AF_STEP;

  for (let i = 2; i < candles.length; i++) {
    let next = sar + af * (ep - sar);

    if (uptrend) {
      next = Math.min(next, candles[i - 1].low, candles[i - 2].low);
      if (candles[i].low < next) {
        uptrend = false;
        sar = ep;
        ep = candles[i].low;
        af = SAR_AF_STEP;
      } else {
        sar = next;
        if (candles[i].high > ep) {
          ep = candles[i].high;
          af = Math.min(af + SAR_AF_STEP, SAR_AF_MAX);
        }
      }
    } else {
      next = Math.max(next, candles[i - 1].high, candles[i - 2].high);
      if (candles[i].high > next) {
        uptrend = true;
        sar = ep;
        ep = candles[i].high;
        af = SAR_AF_STEP;
      } else {
        sar = next;
        if (candles[i].low < ep) {
          ep = candles[i].low;
          af = Math.min(af + SAR_AF_STEP, SAR_AF_MAX);
        }
      }
    }
  }

  return { value: sar, direction: uptrend ? "up" : "down" };
}

export interface IchimokuResult {
  tenkanSen: number;
  kijunSen: number;
  senkouSpanA: number;
  senkouSpanB: number;
  priceVsCloud: "above" | "below" | "inside";
  /** Whether today's close beats the price from 26 bars ago — the Chikou Span confirmation. */
  chikouConfirms: boolean | null;
}

function highLowMidpoint(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  return (Math.max(...window.map((c) => c.high)) + Math.min(...window.map((c) => c.low))) / 2;
}

const ICHIMOKU_CHIKOU_LAG = 26;

/**
 * Ichimoku Cloud: Tenkan-sen(9)/Kijun-sen(26)/Senkou Span A&B(52), standard
 * periods.
 *
 * Deliberately NOT forward-displaced. On a chart, Senkou Span A/B are
 * conventionally plotted 26 bars ahead — a drawing convention for where the
 * cloud will sit, not a different value. For a real-time "is price above
 * or below the cloud right now" read, the components computed as of today
 * ARE the relevant cloud; shifting them forward would test price against a
 * cloud that has not been reached yet.
 */
export function ichimoku(candles: Candle[]): IchimokuResult | null {
  const tenkanSen = highLowMidpoint(candles, 9);
  const kijunSen = highLowMidpoint(candles, 26);
  const senkouSpanB = highLowMidpoint(candles, 52);
  if (tenkanSen === null || kijunSen === null || senkouSpanB === null) return null;

  const senkouSpanA = (tenkanSen + kijunSen) / 2;
  const price = candles[candles.length - 1].close;
  const cloudTop = Math.max(senkouSpanA, senkouSpanB);
  const cloudBottom = Math.min(senkouSpanA, senkouSpanB);
  const priceVsCloud = price > cloudTop ? "above" : price < cloudBottom ? "below" : "inside";

  const chikouConfirms =
    candles.length > ICHIMOKU_CHIKOU_LAG
      ? price > candles[candles.length - 1 - ICHIMOKU_CHIKOU_LAG].close
      : null;

  return { tenkanSen, kijunSen, senkouSpanA, senkouSpanB, priceVsCloud, chikouConfirms };
}

export interface FibonacciResult {
  swingHigh: number;
  swingLow: number;
  levels: Array<{ ratio: number; price: number }>;
  /** The standard ratio price currently sits closest to, if within `FIB_PROXIMITY_PCT` of the range. */
  nearestLevel: number | null;
}

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** Trailing bars used to find the swing high/low — see this file's header note on why 50 was chosen. */
const FIB_WINDOW = 50;
/** How close price must sit to a level, as a fraction of the swing range, to count as "at" it. */
const FIB_PROXIMITY_PCT = 0.02;

/**
 * Fibonacci retracement — confirmed with the user as a disclosed, NOT a
 * settled, convention (same framing as FUNDING_BANDS' own thresholds):
 * swing high/low taken over the trailing 50 daily bars, since unlike every
 * other indicator here there is no single textbook definition of which
 * swing to measure. A different window would produce different levels;
 * this one is a defensible choice, not the only correct one.
 */
export function fibonacciRetracement(candles: Candle[], window = FIB_WINDOW): FibonacciResult | null {
  if (candles.length < window) return null;
  const recent = candles.slice(candles.length - window);
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const range = swingHigh - swingLow;
  if (range <= 0) return null;

  const levels = FIB_RATIOS.map((ratio) => ({ ratio, price: swingHigh - ratio * range }));
  const price = candles[candles.length - 1].close;
  const tolerance = range * FIB_PROXIMITY_PCT;

  let nearestLevel: number | null = null;
  let minDist = Infinity;
  for (const level of levels) {
    const dist = Math.abs(price - level.price);
    if (dist < tolerance && dist < minDist) {
      minDist = dist;
      nearestLevel = level.ratio;
    }
  }

  return { swingHigh, swingLow, levels, nearestLevel };
}
