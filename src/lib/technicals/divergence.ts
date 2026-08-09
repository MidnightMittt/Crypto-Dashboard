/**
 * RSI/MACD divergence detection — compares where PRICE made its most recent
 * two comparable swing points to what the oscillator (RSI, or MACD's
 * histogram) was doing at those same two points in time.
 *
 * Uses a centered-fractal swing-point detector, which is a deliberate,
 * narrow exception to `trendStructure()`'s documented stance in
 * indicators.ts against precise swing-point detection. That stance is about
 * classifying overall trend SHAPE (recent-half vs. older-half), a summary
 * judgment with genuinely no single correct definition. Divergence is a
 * different problem: it structurally requires two discrete, comparable
 * pivots to compare price against the oscillator at — there is no
 * "coarser" version of that comparison that still means anything.
 *
 * Four cases, the standard textbook definitions:
 *   - REGULAR BULLISH: price makes a LOWER low, oscillator makes a HIGHER
 *     low. Momentum isn't confirming the new price low — a reversal-up
 *     warning.
 *   - REGULAR BEARISH: price makes a HIGHER high, oscillator makes a LOWER
 *     high. Momentum isn't confirming the new price high — a reversal-down
 *     warning.
 *   - HIDDEN BULLISH: price makes a HIGHER low (an uptrend pullback),
 *     oscillator makes a LOWER low. A trend-continuation-up signal.
 *   - HIDDEN BEARISH: price makes a LOWER high (a downtrend pullback),
 *     oscillator makes a HIGHER high. A trend-continuation-down signal.
 *
 * Only regular divergence is a reversal warning; hidden divergence argues
 * the existing trend keeps going. `technicals.ts` treats them differently
 * for exactly this reason — a hidden divergence should never undercut an
 * agreeing technical read, only a regular one should.
 */

/** A local extreme in a series: `series[index]` is the max/min within its `[index - lookback, index + lookback]` window. */
export interface SwingPoint {
  index: number;
  value: number;
  kind: "high" | "low";
}

/**
 * Minimum bars between the two swings being compared. With a 3-bar fractal
 * (each swing already a 7-bar local extreme) over ~300 daily bars of
 * history, 5 bars keeps the comparison to genuinely separate structural
 * pivots — not two lobes of what's really one extended swing — while still
 * catching divergences that build over as little as a week or two of daily
 * bars.
 */
const MIN_SWING_GAP = 5;

/**
 * Centered-fractal pivot detector. `series[i]` is a swing high/low only if
 * it is the STRICT max/min of its full `[i - lookback, i + lookback]`
 * window — a tie produces no swing point there, rather than guessing which
 * side of a plateau "really" was the pivot.
 */
export function findSwingPoints(series: number[], lookback = 3): SwingPoint[] {
  const points: SwingPoint[] = [];
  if (series.length < lookback * 2 + 1) return points;

  for (let i = lookback; i < series.length - lookback; i++) {
    const window = series.slice(i - lookback, i + lookback + 1);
    const v = series[i];
    if (v === Math.max(...window) && window.filter((x) => x === v).length === 1) {
      points.push({ index: i, value: v, kind: "high" });
    } else if (v === Math.min(...window) && window.filter((x) => x === v).length === 1) {
      points.push({ index: i, value: v, kind: "low" });
    }
  }
  return points;
}

export type DivergenceKind = "regular-bullish" | "regular-bearish" | "hidden-bullish" | "hidden-bearish";

export interface DivergenceResult {
  kind: DivergenceKind;
  /** Index into the (tail-aligned) series passed to classifyDivergence. */
  priorIndex: number;
  recentIndex: number;
  pricePrior: number;
  priceRecent: number;
  indicatorPrior: number;
  indicatorRecent: number;
}

/** Most recent pair of same-kind swings at least `minGap` bars apart, oldest first. */
function lastComparablePair(swings: SwingPoint[], kind: "high" | "low", minGap: number): [SwingPoint, SwingPoint] | null {
  const filtered = swings.filter((s) => s.kind === kind);
  if (filtered.length < 2) return null;
  const recent = filtered[filtered.length - 1];
  for (let i = filtered.length - 2; i >= 0; i--) {
    if (recent.index - filtered[i].index >= minGap) {
      return [filtered[i], recent];
    }
  }
  return null;
}

/**
 * Classifies the most recent RSI/MACD-histogram divergence against price,
 * if any. `priceCloses` and `indicatorSeries` are right-aligned (the same
 * tail-alignment convention `macd()` uses internally in indicators.ts) since
 * the indicator series is always shorter than the raw close series after its
 * own warmup period.
 *
 * Returns null when there aren't two comparable swings yet, or when the two
 * swings simply don't diverge (both series moved the same way, or tied
 * exactly — a tie is treated as "not diverging," never guessed).
 *
 * When both a low-based and a high-based divergence are found at once
 * (rare), the more recent one wins — it's the live, current-state signal.
 */
export function classifyDivergence(priceCloses: number[], indicatorSeries: number[], lookback = 3): DivergenceResult | null {
  const n = Math.min(priceCloses.length, indicatorSeries.length);
  if (n === 0) return null;

  const priceTail = priceCloses.slice(priceCloses.length - n);
  const indicatorTail = indicatorSeries.slice(indicatorSeries.length - n);
  const priceSwings = findSwingPoints(priceTail, lookback);

  const fromLows = (() => {
    const pair = lastComparablePair(priceSwings, "low", MIN_SWING_GAP);
    if (!pair) return null;
    const [prior, recent] = pair;
    const indicatorPrior = indicatorTail[prior.index];
    const indicatorRecent = indicatorTail[recent.index];
    const base = {
      priorIndex: prior.index,
      recentIndex: recent.index,
      pricePrior: prior.value,
      priceRecent: recent.value,
      indicatorPrior,
      indicatorRecent,
    };
    if (recent.value < prior.value && indicatorRecent > indicatorPrior) {
      return { kind: "regular-bullish" as const, ...base };
    }
    if (recent.value > prior.value && indicatorRecent < indicatorPrior) {
      return { kind: "hidden-bullish" as const, ...base };
    }
    return null;
  })();

  const fromHighs = (() => {
    const pair = lastComparablePair(priceSwings, "high", MIN_SWING_GAP);
    if (!pair) return null;
    const [prior, recent] = pair;
    const indicatorPrior = indicatorTail[prior.index];
    const indicatorRecent = indicatorTail[recent.index];
    const base = {
      priorIndex: prior.index,
      recentIndex: recent.index,
      pricePrior: prior.value,
      priceRecent: recent.value,
      indicatorPrior,
      indicatorRecent,
    };
    if (recent.value > prior.value && indicatorRecent < indicatorPrior) {
      return { kind: "regular-bearish" as const, ...base };
    }
    if (recent.value < prior.value && indicatorRecent > indicatorPrior) {
      return { kind: "hidden-bearish" as const, ...base };
    }
    return null;
  })();

  if (fromLows && fromHighs) {
    return fromLows.recentIndex >= fromHighs.recentIndex ? fromLows : fromHighs;
  }
  return fromLows ?? fromHighs ?? null;
}
