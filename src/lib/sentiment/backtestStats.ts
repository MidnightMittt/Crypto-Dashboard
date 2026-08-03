import { MarketRegime } from "@/types/market";
import { Category, Verdict } from "@/lib/signals/types";

/**
 * Lookup layer for `scripts/backtest/`'s output. Deliberately separate from
 * `positioning.ts`/`marketThesis.ts`: those are the pure functions the
 * backtest exists to evaluate, so they must not reference their own
 * evaluation. This module only reads the static, committed
 * `src/data/backtestStats.json` snapshot and answers "does a stat exist for
 * this reading, and is it thick enough to state."
 *
 * The bucket definitions live here, not duplicated in report.ts, so the
 * live lookup and the report generator can never drift apart — report.ts
 * imports this same file when it runs (via tsx, same as run.ts).
 */

export interface RegimeStat {
  n: number;
  mean1dPct: number;
  mean3dPct: number;
  mean7dPct: number;
  /** % of occurrences where price moved opposite the crowded side over 7d. Null for buckets where "fade" isn't a meaningful frame (thesis regimes). */
  fadeHitRatePct: number | null;
}

export interface BacktestStats {
  generatedAt: number;
  coverageStart: string;
  coverageEnd: string;
  squeeze: Record<string, RegimeStat>;
  thesis: Partial<Record<MarketRegime, RegimeStat>>;
  /**
   * The decision engine's five category rollups (lib/signals/categories.ts),
   * bucketed by each category's own verdict — e.g. how did price move after
   * days where Liquidity specifically read bullish vs. bearish. A SEPARATE
   * question from the thesis regime stats above: those describe the older
   * marketThesis engine, these describe the newer category-weighted
   * marketBias engine. Neither replaces the other.
   */
  categories: Partial<Record<`${Category}:${Verdict}`, RegimeStat>>;
  /** The overall marketBias verdict (not marketThesis's regime), bucketed the same way. */
  biasVerdict: Partial<Record<Verdict, RegimeStat>>;
}

/**
 * Below this many occurrences, a mean/hit-rate is more likely to be sample
 * noise than signal — hidden rather than stated with false confidence.
 * Checked against the first real backtest run: this excludes exactly the
 * two thinnest squeeze buckets (short side, N=6 and N=7) and the thinnest
 * thesis regime (Squeeze Setup — Shorts Exposed, N=6), while keeping every
 * bucket that had real weight behind it.
 */
export const MIN_SAMPLE_N = 10;

export const SQUEEZE_SCORE_BUCKETS: Array<{ label: string; test: (score: number) => boolean }> = [
  { label: "0-30 (quiet)", test: (s) => s < 30 },
  { label: "30-50", test: (s) => s >= 30 && s < 50 },
  { label: "50-70", test: (s) => s >= 50 && s < 70 },
  { label: "70-100 (crowded)", test: (s) => s >= 70 },
];

/** Same key scheme used when building the stats file — keep in sync with buildSqueezeKey callers. */
export function squeezeBucketKey(score: number, side: "long" | "short" | "balanced"): string | null {
  if (side === "balanced") return null;
  const bucket = SQUEEZE_SCORE_BUCKETS.find((b) => b.test(score));
  return bucket ? `${bucket.label}:${side}` : null;
}

export function lookupSqueezeStat(
  stats: BacktestStats,
  score: number,
  side: "long" | "short" | "balanced"
): RegimeStat | null {
  const key = squeezeBucketKey(score, side);
  if (!key) return null;
  const stat = stats.squeeze[key];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

export function lookupThesisStat(stats: BacktestStats, regime: MarketRegime): RegimeStat | null {
  const stat = stats.thesis[regime];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

/**
 * Not yet wired into any UI component — this backtest pass only establishes
 * that the category engine CAN be validated, and produces the first real
 * numbers. Whether/how to surface them is a separate decision, same
 * discipline the original squeeze/thesis backtest was built under.
 */
export function lookupCategoryStat(stats: BacktestStats, category: Category, verdict: Verdict): RegimeStat | null {
  const stat = stats.categories[`${category}:${verdict}`];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

export function lookupBiasVerdictStat(stats: BacktestStats, verdict: Verdict): RegimeStat | null {
  const stat = stats.biasVerdict[verdict];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}
