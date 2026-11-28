import { Candle } from "./indicators";

/**
 * Daily → weekly / monthly candle construction.
 *
 * Higher-timeframe structure is built by RESAMPLING the daily series rather
 * than fetching separate weekly and monthly series, so all three timeframes
 * are guaranteed to agree about what a given period contained. Two independent
 * fetches can disagree — different venue conventions about where a week
 * starts, a vendor revising a bar — and a zone engine that sees a weekly high
 * the daily series does not contain produces levels nobody can trade.
 *
 * ── THE LOOK-AHEAD RULE, WHICH IS THE WHOLE POINT OF THIS FILE ───────────
 *
 * A forming period is NOT a completed candle. If today is Wednesday, the
 * current week's "high" is the high of three days, and treating it as a
 * weekly bar means a backtest standing on Wednesday can see a level derived
 * from Wednesday's own price. That is look-ahead, and it is the single
 * easiest way to leak the future into a resample.
 *
 * So a period is emitted ONLY when it is provably complete, and completeness
 * is decided FROM THE DATA, never from the wall clock:
 *
 *     a period is complete iff a later bar exists outside it
 *
 * The final bucket therefore never qualifies — there is by definition no bar
 * after it — so the forming week/month is always dropped. That is conservative
 * by one period and correct by construction. It also means this function
 * behaves identically live and in backtest, which is the other half of the
 * requirement: the same definition must hold in both.
 *
 * (Note the subtle alternative that does NOT work: "complete iff periodEnd <
 * Date.now()". That reads the clock, so a backtest replaying 2019 would mark
 * every period complete including ones whose data it was not yet entitled to.)
 *
 * ── PERIOD KEYS ──────────────────────────────────────────────────────────
 *
 * Weekly buckets are keyed to MONDAY 00:00 UTC, monthly to the 1st 00:00 UTC.
 * Getting this wrong turns a bar into a rolling window: bucket by "every 7th
 * bar" and the boundaries drift with whatever day the series happens to start
 * on, so the same week yields different highs depending on history length.
 */

/** Monday 00:00 UTC of the week containing `t`. */
export function weekStartUtc(t: number): number {
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

/** 1st 00:00 UTC of the month containing `t`. */
export function monthStartUtc(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Exclusive end of the week beginning at `weekStart`. */
function weekEnd(weekStart: number): number {
  return weekStart + 7 * 86_400_000;
}

/** Exclusive end of the month beginning at `monthStart`. */
function monthEnd(monthStart: number): number {
  const d = new Date(monthStart);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface ResampleReport {
  /** Completed higher-timeframe candles, oldest first. */
  candles: Candle[];
  /** Buckets dropped for being still open. Always 0 or 1 in practice. */
  droppedIncomplete: number;
  /** Duplicate daily timestamps collapsed before bucketing. */
  deduped: number;
  /** Periods with no daily data at all, between the first and last period present. */
  missingPeriods: number;
  /**
   * Completed periods that contain fewer daily bars than the period can hold.
   * Not an error — crypto trades every day but equities do not, and a holiday
   * week is genuinely 4 bars. Surfaced so a caller can tell a short week from
   * a gap in the feed rather than silently averaging over the difference.
   */
  partialPeriods: number;
}

type Keyer = (t: number) => number;
type Ender = (periodStart: number) => number;

function resample(daily: Candle[], keyOf: Keyer, endOf: Ender): ResampleReport {
  const empty: ResampleReport = { candles: [], droppedIncomplete: 0, deduped: 0, missingPeriods: 0, partialPeriods: 0 };
  if (!daily.length) return empty;

  // SORT AND DEDUPE FIRST. Providers can return out-of-order or repeated
  // timestamps; bucketing an unsorted series silently produces wrong
  // open/close values, because open is "first bar seen" and close is "last".
  const byT = new Map<number, Candle>();
  let deduped = 0;
  for (const c of daily) {
    if (byT.has(c.t)) deduped++;
    byT.set(c.t, c); // later wins — a revised bar supersedes the earlier copy
  }
  const sorted = [...byT.values()].sort((a, b) => a.t - b.t);

  const buckets = new Map<number, { c: Candle; n: number }>();
  for (const bar of sorted) {
    const k = keyOf(bar.t);
    const g = buckets.get(k);
    if (!g) {
      buckets.set(k, {
        c: { t: k, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volumeUsd: bar.volumeUsd },
        n: 1,
      });
    } else {
      g.c.high = Math.max(g.c.high, bar.high);
      g.c.low = Math.min(g.c.low, bar.low);
      g.c.close = bar.close; // sorted, so the last bar seen is the period close
      g.c.volumeUsd += bar.volumeUsd;
      g.n++;
    }
  }

  const lastBarT = sorted[sorted.length - 1].t;
  const keys = [...buckets.keys()].sort((a, b) => a - b);

  const out: Candle[] = [];
  let droppedIncomplete = 0;
  let partialPeriods = 0;
  for (const k of keys) {
    // COMPLETE IFF A LATER BAR EXISTS OUTSIDE THIS PERIOD. Derived from the
    // data, not the clock — see this file's header.
    if (lastBarT < endOf(k)) {
      droppedIncomplete++;
      continue;
    }
    const g = buckets.get(k)!;
    const spanDays = Math.round((endOf(k) - k) / 86_400_000);
    if (g.n < spanDays) partialPeriods++;
    out.push(g.c);
  }

  // Missing periods: gaps in the sequence between the first and last bucket.
  let missingPeriods = 0;
  for (let i = 1; i < keys.length; i++) {
    let expected = endOf(keys[i - 1]);
    while (expected < keys[i]) {
      missingPeriods++;
      expected = endOf(expected);
    }
  }

  return { candles: out, droppedIncomplete, deduped, missingPeriods, partialPeriods };
}

/** Completed weekly candles (Monday-anchored, UTC) built from daily bars. */
export function resampleToWeekly(daily: Candle[]): ResampleReport {
  return resample(daily, weekStartUtc, weekEnd);
}

/** Completed monthly candles (1st-anchored, UTC) built from daily bars. */
export function resampleToMonthly(daily: Candle[]): ResampleReport {
  return resample(daily, monthStartUtc, monthEnd);
}
