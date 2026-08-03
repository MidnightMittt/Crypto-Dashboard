import { MarketRegime } from "@/types/market";
import { Category, Verdict } from "@/lib/signals/types";
import { HoldingPeriod } from "@/lib/signals/hypothesis";

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
  /**
   * The hypothesis-testing framework's per-metric, per-holding-period stats
   * (src/lib/signals/hypothesis.ts). Only populated for metric ids with a
   * real historical source (`SignalHypothesis.hasHistoricalSource`) — the
   * rest have a hypothesis contract but nothing here can measure it yet.
   */
  hypotheses: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>>;
  /**
   * Category-combination testing (scripts/backtest/combinations.ts): all 32
   * presence/absence patterns across the 5 categories, at each holding
   * period. A RESEARCH ARTIFACT — nothing on the live site reads this field;
   * it exists so a human reviewing the backtest report can see it without
   * opening a second file.
   */
  combinations: CombinationStat[];
}

export interface CombinationStat {
  /**
   * Category ids in the subset. Typed as `string[]`, not `Category[]`: this
   * gets read back from committed JSON (via `@/data/backtestStats.json`),
   * and a literal union can't survive a JSON round-trip — the values ARE
   * always valid Category ids, this just doesn't ask the type system to
   * take that on faith.
   */
  subset: string[];
  label: string;
  /** Same JSON-round-trip reasoning as `subset` above: always one of HOLDING_PERIODS, typed as `string` since a literal union can't survive JSON.parse. */
  holdingPeriod: string;
  stat: HypothesisStat;
}

/** One class's (bullish or bearish) one-vs-rest confusion matrix, mirroring scripts/backtest/metrics.ts's ConfusionMatrix. */
export interface HypothesisConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | null;
  recall: number | null;
}

/** Sign-test result against a 50% null, mirroring scripts/backtest/metrics.ts's SignificanceResult. Null when there are no scoreable occurrences at all. */
export interface HypothesisSignificance {
  n: number;
  wins: number;
  pValue: number;
  significant: boolean;
}

export interface HypothesisStat {
  /** Scored occurrences: verdict was bullish or bearish AND a forward return exists for this holding period. */
  n: number;
  winRate: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  maxDrawdownPct: number | null;
  bullish: HypothesisConfusionMatrix;
  bearish: HypothesisConfusionMatrix;
  significance: HypothesisSignificance | null;
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

/**
 * Not yet wired into any UI component — same status as lookupCategoryStat
 * when it was first built. Metric-level cards are the natural place for
 * this ("historically, when this metric read bullish over the next 24h...")
 * but that wiring is a separate decision from building the stat itself.
 */
export function lookupHypothesisStat(
  stats: BacktestStats,
  metricId: string,
  holdingPeriod: HoldingPeriod
): HypothesisStat | null {
  const stat = stats.hypotheses[`${metricId}:${holdingPeriod}`];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}
