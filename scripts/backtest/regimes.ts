import { Candle } from "../../src/lib/technicals/indicators";

/**
 * Classifies each daily candle into independent regime flags — trend,
 * volatility, and range-boundedness are NOT mutually exclusive (a day can
 * genuinely be both "Bull" and "High-Vol" during a sharp rally), so this
 * intentionally returns three separate reads rather than one label,
 * matching the same "which subset of tags is true" pattern
 * combinations.ts already uses for categories.
 *
 * Pure function over the SAME daily candles run.ts already builds via
 * `rollUpToDaily` — no new data source. Purely descriptive: nothing here
 * predicts anything, it only labels what already happened, then report.ts
 * slices existing win-rate/significance stats by these labels the same way
 * it already slices by category or holding period.
 */

// ── Trend ────────────────────────────────────────────────────────────────

const TREND_LOOKBACK_DAYS = 20;
/**
 * Checked against real data, not guessed: BTC's own trailing-20d-return
 * distribution (1,736 daily bars) has its 30th/70th percentile at roughly
 * -4.5%/+5.5%; ETH's at roughly -7.4%/+6.0%. 7% sits close to both assets'
 * observed 30th/70th percentile rather than an arbitrary round number —
 * the "checked against the first real backtest run" discipline
 * MIN_SAMPLE_N's own doc comment already uses, applied here too.
 */
const TREND_THRESHOLD_PCT = 7;

// ── Volatility / range-bound ────────────────────────────────────────────

const VOL_LOOKBACK_DAYS = 14;
const RANGE_LOOKBACK_DAYS = 14;
/**
 * Both volatility and range-compression are ranked as a PERCENTILE against
 * their own trailing 180-day history, not a fixed number — "high vol" is
 * regime-relative, and BTC's absolute volatility level has structurally
 * declined since 2019; a fixed threshold picked from recent data would
 * misclassify calmer-by-comparison older stretches. Requires this many
 * PRIOR days of the underlying measure before a percentile means anything.
 */
const PERCENTILE_WINDOW_DAYS = 180;
const MIN_PERCENTILE_HISTORY = 30; // below this, report "normal"/not-range-bound rather than a shaky reading

export interface RegimeTags {
  trend: "bull" | "bear" | "neutral";
  volatility: "high" | "low" | "normal";
  rangeBound: boolean;
}

/** Trailing N-day return ending at index i, or null without enough history. */
function trailingReturn(candles: Candle[], i: number, days: number): number | null {
  if (i < days) return null;
  const start = candles[i - days].close;
  if (start <= 0) return null;
  return ((candles[i].close - start) / start) * 100;
}

/** Realized volatility: stdev of daily log returns over the trailing `days` bars ending at index i (inclusive). */
function trailingRealizedVol(candles: Candle[], i: number, days: number): number | null {
  if (i < days) return null;
  const logRets: number[] = [];
  for (let j = i - days + 1; j <= i; j++) {
    if (candles[j - 1].close <= 0 || candles[j].close <= 0) return null;
    logRets.push(Math.log(candles[j].close / candles[j - 1].close));
  }
  const mean = logRets.reduce((a, b) => a + b, 0) / logRets.length;
  const variance = logRets.reduce((a, b) => a + (b - mean) ** 2, 0) / logRets.length;
  return Math.sqrt(variance);
}

/** Trailing N-day (high-low)/mid price compression ending at index i (inclusive). */
function trailingRangeCompression(candles: Candle[], i: number, days: number): number | null {
  if (i < days - 1) return null;
  const window = candles.slice(i - days + 1, i + 1);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const mid = (high + low) / 2;
  if (mid <= 0) return null;
  return (high - low) / mid;
}

/** Fraction of `priorValues` strictly below `value` — a percentile rank with no lookahead, since callers only ever pass values from STRICTLY earlier days. */
function percentileRank(value: number, priorValues: number[]): number {
  if (priorValues.length === 0) return 0.5;
  const below = priorValues.filter((v) => v < value).length;
  return below / priorValues.length;
}

/**
 * Classifies the day at `candles[i]`. Returns null only when there isn't
 * even enough history for the trend read (the cheapest of the three) —
 * volatility/range-bound degrade gracefully to "normal"/false (the honest
 * default, not a fabricated read) when the 180-day percentile baseline
 * hasn't built up MIN_PERCENTILE_HISTORY points yet, rather than the whole
 * function refusing to classify a day at all over a secondary measure.
 */
export function classifyRegime(candles: Candle[], i: number): RegimeTags | null {
  const trendRet = trailingReturn(candles, i, TREND_LOOKBACK_DAYS);
  if (trendRet === null) return null;
  const trend: RegimeTags["trend"] =
    trendRet > TREND_THRESHOLD_PCT ? "bull" : trendRet < -TREND_THRESHOLD_PCT ? "bear" : "neutral";

  const historyStart = Math.max(VOL_LOOKBACK_DAYS, RANGE_LOOKBACK_DAYS, i - PERCENTILE_WINDOW_DAYS);
  const volHistory: number[] = [];
  const rangeHistory: number[] = [];
  for (let j = historyStart; j < i; j++) {
    const v = trailingRealizedVol(candles, j, VOL_LOOKBACK_DAYS);
    if (v !== null) volHistory.push(v);
    const r = trailingRangeCompression(candles, j, RANGE_LOOKBACK_DAYS);
    if (r !== null) rangeHistory.push(r);
  }

  const currentVol = trailingRealizedVol(candles, i, VOL_LOOKBACK_DAYS);
  const currentRange = trailingRangeCompression(candles, i, RANGE_LOOKBACK_DAYS);

  if (currentVol === null || currentRange === null || volHistory.length < MIN_PERCENTILE_HISTORY || rangeHistory.length < MIN_PERCENTILE_HISTORY) {
    return { trend, volatility: "normal", rangeBound: false };
  }

  const volPct = percentileRank(currentVol, volHistory);
  const volatility: RegimeTags["volatility"] = volPct >= 2 / 3 ? "high" : volPct <= 1 / 3 ? "low" : "normal";
  const rangeBound = percentileRank(currentRange, rangeHistory) <= 1 / 3;

  return { trend, volatility, rangeBound };
}

/** Flattens a RegimeTags object into the string[] shape DayRecord.regimeTags stores, e.g. ["bull", "high-vol", "range-bound"]. */
export function regimeTagsToStrings(tags: RegimeTags): string[] {
  const out: string[] = [tags.trend, `${tags.volatility}-vol`];
  if (tags.rangeBound) out.push("range-bound");
  return out;
}
