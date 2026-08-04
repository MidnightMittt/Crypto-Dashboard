import { MarketRegime } from "@/types/market";
import { Category, Verdict } from "@/lib/signals/types";
import { HoldingPeriod } from "@/lib/signals/hypothesis";

/**
 * Lookup layer for `scripts/backtest/`'s output. Deliberately separate from
 * `positioning.ts`/`marketThesis.ts`: those are the pure functions the
 * backtest exists to evaluate, so they must not reference their own
 * evaluation.
 *
 * TWO SEPARATE FILES, ON PURPOSE — not two views of one blob:
 *  - `src/data/backtestStats.json` (typed `BacktestStats` below) is small
 *    (squeeze/thesis/categories/biasVerdict only, a few KB) and is the ONE
 *    live components import directly, so it ships in the client bundle.
 *  - `src/data/backtestResearch.json` (typed `BacktestResearch` below) holds
 *    everything else — hypotheses, combinations, regime crosstabs, rolling
 *    windows — which is genuinely large (400+ KB) and, as of this writing,
 *    read by NOTHING live. Before this split, both lived in one file and
 *    that whole 630KB blob was shipped to every visitor's browser via the
 *    3 live components' `import backtestStats from "@/data/backtestStats.json"`
 *    even though they only ever read a few KB of it — confirmed directly:
 *    the production bundle's First Load JS jumped from 246KB to 309KB the
 *    moment rollingWindows/metricRegimeCrosstab were added to the single
 *    file. Splitting isn't just tidiness, it fixes a real regression.
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

/**
 * The small, live-bundled snapshot — `src/data/backtestStats.json`.
 * Every field here is read by at least one live component today
 * (`lookupSqueezeStat`/`lookupCategoryStat`/`lookupBiasVerdictStat`); keep
 * it that way. Anything not read live belongs in `BacktestResearch` below,
 * not here.
 */
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
 * The large, research-only snapshot — `src/data/backtestResearch.json`.
 * NOT imported by any live component; reserved for the internal-only
 * Signal Research Center page (a future server-rendered `/internal/*`
 * route, never a client bundle import) to read directly. Committed to the
 * repo the same way `backtestStats.json` is, just via a separate file so
 * its size never touches what ships to a normal visitor's browser.
 */
export interface BacktestResearch {
  generatedAt: number;
  coverageStart: string;
  coverageEnd: string;
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
  /**
   * Bare regime-tag breakdown (scripts/backtest/regimes.ts): how price
   * moved on days carrying each independent trend/volatility/range-bound
   * tag, with NO metric crossed in — e.g. "on Bull-tagged days, mean 7d
   * return was X%". A separate, coarser question from metricRegimeCrosstab
   * below, which asks "how did THIS metric specifically perform when this
   * tag was present."
   */
  regimes: Partial<Record<string, RegimeStat>>;
  /**
   * Per-metric, per-regime-tag, per-holding-period stats — the same
   * HypothesisStat shape `hypotheses` already uses, just sliced by an
   * additional regime-tag filter before scoring (regimeOccurrencesFor in
   * report.ts; no new statistics code, purely a pre-filter on the same
   * summarizeOccurrences()). Key: `${metricId}:${regimeTag}:${HoldingPeriod}`,
   * e.g. "funding:bull:24h". Only populated for metrics with a real
   * historical source, same restriction `hypotheses` already has.
   */
  metricRegimeCrosstab: Partial<Record<`${string}:${string}:${HoldingPeriod}`, HypothesisStat>>;
  /**
   * The SAME top-level {squeeze, thesis, categories, biasVerdict,
   * hypotheses} stat shapes, recomputed separately per overlapping
   * historical window (scripts/backtest/rolling.ts) — the direct answer to
   * "is this edge real across market cycles, or was it one lucky/unlucky
   * stretch." Optional: only present when `npm run backtest:rolling` has
   * been run; the standard `npm run backtest` doesn't populate it, since
   * it's a slower, opt-in deeper pass, not part of the default flow.
   */
  rollingWindows?: Record<string, RollingWindowStats>;
  /**
   * Metric-level combination testing (scripts/backtest/metricCombinations.ts):
   * 7 named, pre-registered combos (no correction) plus all C(15,2)=105
   * automatic pairs at each holding period (Benjamini-Hochberg FDR
   * corrected — see multipleTesting.ts). A RESEARCH ARTIFACT, same status
   * as `combinations` above; nothing on the live site reads this field.
   */
  metricCombinations: MetricComboStat[];
  /**
   * One assembled report per metric — every field here is read straight
   * from `hypotheses`/`metricRegimeCrosstab`/`metricCombinations` above,
   * nothing new computed. Answers "what's the single most useful summary
   * of this signal" without a human having to cross-reference three
   * different sections by hand.
   */
  signalResearch: Record<string, SignalResearchReport>;
}

export interface SignalResearchReport {
  metricId: string;
  label: string;
  hasHistoricalSource: boolean;
  /** The metric's own headline stat at 24h — the horizon every other section treats as primary. Null if N < MIN_SAMPLE_N. */
  headline: HypothesisStat | null;
  bestHoldingPeriod: { holdingPeriod: string; winRate: number } | null;
  worstHoldingPeriod: { holdingPeriod: string; winRate: number } | null;
  bestRegime: { tag: string; winRate: number } | null;
  worstRegime: { tag: string; winRate: number } | null;
  /** Combo entries (named + BH-significant automatic) that include this metric, at 24h, most significant first. */
  interactions: MetricComboStat[];
}

export interface MetricComboStat {
  label: string;
  metricIds: string[];
  /** Always one of HOLDING_PERIODS; typed `string` for the same JSON-round-trip reason `CombinationStat.holdingPeriod` is. */
  holdingPeriod: string;
  isNamed: boolean;
  stat: HypothesisStat;
  /** Only present for automatic pairs (see file doc comment on metricCombinations.ts for why named combos are exempt). */
  fdr?: { rank: number; significant: boolean };
}

export interface RollingWindowStats {
  windowStart: string;
  windowEnd: string;
  squeeze: Record<string, RegimeStat>;
  thesis: Partial<Record<MarketRegime, RegimeStat>>;
  categories: Partial<Record<`${Category}:${Verdict}`, RegimeStat>>;
  biasVerdict: Partial<Record<Verdict, RegimeStat>>;
  hypotheses: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>>;
}

export interface CombinationStat {
  /**
   * Category ids in the subset. Typed as `string[]`, not `Category[]`: this
   * gets read back from committed JSON, and a literal union can't survive a
   * JSON round-trip — the values ARE always valid Category ids, this just
   * doesn't ask the type system to take that on faith.
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

export function lookupCategoryStat(stats: BacktestStats, category: Category, verdict: Verdict): RegimeStat | null {
  const stat = stats.categories[`${category}:${verdict}`];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

export function lookupBiasVerdictStat(stats: BacktestStats, verdict: Verdict): RegimeStat | null {
  const stat = stats.biasVerdict[verdict];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

/**
 * Reads from `BacktestResearch`, not `BacktestStats` — not yet wired into
 * any UI component. Metric-level cards are the natural place for this
 * ("historically, when this metric read bullish over the next 24h...") but
 * that wiring is a separate decision from building the stat itself, and
 * when it happens it should go through a server component reading
 * `backtestResearch.json` directly, never a client-bundled import.
 */
export function lookupHypothesisStat(
  research: BacktestResearch,
  metricId: string,
  holdingPeriod: HoldingPeriod
): HypothesisStat | null {
  const stat = research.hypotheses[`${metricId}:${holdingPeriod}`];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

/** Reads from `BacktestResearch` — same not-yet-wired status as lookupHypothesisStat. */
export function lookupRegimeStat(research: BacktestResearch, tag: string): RegimeStat | null {
  const stat = research.regimes[tag];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}

/** Reads from `BacktestResearch` — same not-yet-wired status as lookupHypothesisStat. */
export function lookupMetricRegimeStat(
  research: BacktestResearch,
  metricId: string,
  tag: string,
  holdingPeriod: HoldingPeriod
): HypothesisStat | null {
  const stat = research.metricRegimeCrosstab[`${metricId}:${tag}:${holdingPeriod}`];
  return stat && stat.n >= MIN_SAMPLE_N ? stat : null;
}
