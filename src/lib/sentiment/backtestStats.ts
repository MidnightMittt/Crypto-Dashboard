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
  /** Sign-match rate between the bucket's own direction and next-day return, i.e. metrics.ts's winRate() over 1d occurrences. Only biasVerdictSection populates this (Entry Quality's historical win-rate figure reads it); other producers leave it null the same way fadeHitRatePct is null where "fade" doesn't apply. */
  winRatePct: number | null;
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
   * Bare regime-tag breakdown (src/lib/technicals/regimes.ts): how price
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

/**
 * The small, live-bundled per-metric performance snapshot —
 * `src/data/backtestMetricStats.json`. A trimmed projection of
 * `SignalResearchReport`/`HypothesisStat` (both `BacktestResearch`-only,
 * never client-bundled) down to exactly what a "Historical Performance"
 * panel needs. Deliberately excludes the full `interactions` array, the
 * full regime crosstab, and the full 6-window rolling breakdown — those
 * stay research-only, same split rationale as `BacktestStats` vs.
 * `BacktestResearch` above.
 */
/**
 * One metric's directional record at one holding period, with the overlap
 * correction that horizon actually requires.
 *
 * `effectiveN` is the only count that should reach a significance test.
 * `n` is kept beside it so the gap is visible rather than implied — a reader
 * seeing 1,762 raw and 881 effective learns something about the replay that
 * either number alone hides.
 */
export interface HorizonRecord {
  /** Scored occurrences at this horizon. */
  n: number;
  /** How many independent observations `n` is worth, after overlap. */
  effectiveN: number;
  /** The block length used, so the correction is auditable, not asserted. */
  blockLength: number;
  winRate: number | null;
  /** The drift-matched null this horizon must beat, never a bare 50%. */
  baseRate: number | null;
  significant: boolean | null;
  /**
   * Tested against the DRIFT null, not a fair coin. Carried so the family of
   * candidate modules can be FDR-corrected — nine modules each tested at four
   * horizons is thirty-six looks, and an uncorrected "one of them cleared" is
   * roughly what chance alone produces.
   */
  pValue: number | null;
}

export interface MetricPerformanceSummary {
  metricId: string;
  label: string;
  hasHistoricalSource: boolean;
  n24h: number | null;
  /**
   * How many INDEPENDENT observations `n24h` is worth.
   *
   * The replay evaluates several correlated assets on the same calendar day,
   * so two rows from one day are not two days of evidence — BTC and ETH move
   * together at rho around 0.82. `n24h` is literally correct and was being
   * read as independent evidence; this is the number that actually backs a
   * claim about how well-sampled a metric is.
   *
   * 24h windows sampled daily do not overlap each other in TIME (one ends
   * where the next begins), so the cross-sectional dependence is the only one
   * at this horizon. The 7d bucket suffers both — see `byHoldingPeriod`,
   * which publishes every horizon with its own block length.
   */
  effectiveN24h: number | null;
  /**
   * THE SAME EVIDENCE AT EVERY HORIZON, each with its own overlap correction.
   *
   * Publishing 24h alone made every other horizon unjudgeable, and a metric
   * does not owe its edge to the horizon we happened to publish. `funding`
   * is the case that forced this: 30.3% at 24h and 57.6% at 7d, carrying the
   * engine's largest weight, with no way to tell which number was real
   * because only the 24h sample had been corrected for overlap.
   *
   * The block length differs by horizon and is carried alongside so a reader
   * can see why the same raw n yields different independent counts — 7d
   * windows sampled daily share six of seven days, the shorter horizons are
   * back-to-back and share nothing in time.
   */
  byHoldingPeriod: Partial<Record<HoldingPeriod, HorizonRecord>>;
  /**
   * What firing blindly would have won at 24h — the number `winRate24h`
   * must BEAT, not 50%. The asset drifts; a bullish 53% against a 54%
   * up-day base rate is value subtracted. Null when the headline lacks
   * sample.
   */
  baseRate24h: number | null;
  winRate24h: number | null;
  /** Looked up separately from the 24h headline — the panel wants both explicitly, not just whichever holding period happens to be best/worst. */
  winRate7d: number | null;
  significant24h: boolean | null;
  bestRegime: { tag: string; winRate: number } | null;
  worstRegime: { tag: string; winRate: number } | null;
  bestHoldingPeriod: { holdingPeriod: string; winRate: number } | null;
  worstHoldingPeriod: { holdingPeriod: string; winRate: number } | null;
  sampleSizeLabel: "Small" | "Medium" | "Large" | null;
  confidenceLabel: "Low" | "Medium" | "High" | null;
  /**
   * Does the 24h win-rate's direction (above/below 50%) agree across a
   * majority of the 6 rolling windows (scripts/backtest/rolling.ts)? Null
   * when fewer than 3 windows have enough of their own sample to judge —
   * an honest "can't tell yet" rather than a shaky true/false from 1-2
   * windows.
   */
  stableAcrossWindows: boolean | null;
}

/**
 * Per-module validation verdicts, computed once by the harness where the
 * WHOLE candidate family is in scope, and committed.
 *
 * The multiple-testing correction is only meaningful across every test in the
 * family, so it cannot be derived at request time from whatever a page
 * happens to load. Shape mirrors `ModuleGrade` in research/edgeGate.ts, which
 * is the module that produces it.
 */
export interface ModuleGradeSnapshot {
  metricId: string;
  verdict: "edge" | "not-distinguishable" | "below-base-rate" | "unmeasured";
  holdingPeriod: string | null;
  lowerBound: number | null;
  effectiveN: number | null;
  survivesFdr: boolean;
  sentence: string;
}

export interface BacktestMetricStats {
  generatedAt: number;
  coverageStart: string;
  coverageEnd: string;
  metrics: Record<string, MetricPerformanceSummary>;
  /**
   * Which modules earned the right to move a decision, keyed by metric id.
   * Read at runtime by evidenceGrade.ts to state what share of a verdict's
   * weight is actually validated.
   */
  moduleGrades: Record<string, ModuleGradeSnapshot>;
  /**
   * Does the composite bias score's own "agreement" figure (how much the
   * metrics concur, src/lib/signals/confidence.ts's agreementOf) historically
   * correlate with a better hit rate — one bucket per agreement quartile,
   * tests whether `bias.agreement` is doing real predictive work or is
   * cosmetic. Same MIN_SAMPLE_N-gated shape as everything else here.
   */
  agreementBuckets: AgreementBucketStat[];
  /**
   * The "Calibrated Probability" source (redesign §9): empirical 24h hit
   * rate of composite reads sharing today's direction, score strength, and
   * trend regime, each cell carrying the regime-conditional drift null it
   * must beat, a Wilson interval, and the effective sample. Keyed
   * `${direction}:${strength}:${trendRegime}` — see scoreCellKey in
   * scripts/backtest/calibration.ts, the single source of the cell
   * definition. Cells with `calibrated: false` exist so a lookup can say
   * "uncalibrated" WITH the n that made it so.
   */
  scoreCalibration: Record<string, ScoreCalibrationCellSnapshot>;
}

export interface ScoreCalibrationCellSnapshot {
  key: string;
  n: number;
  effectiveN: number;
  hitRatePct: number;
  interval: { point: number; lower: number; upper: number };
  nullRatePct: number;
  edgePP: number;
  calibrated: boolean;
}

/**
 * The cell today's live read falls into, or null when there is nothing an
 * honest surface may quote: a neutral verdict (no direction to calibrate),
 * a cell the replay never produced, or one below MIN_SAMPLE_N — the §9
 * rule is that a thin bucket says "uncalibrated", never borrows the global
 * rate. Duplicates scoreCellKey's boundary (15, intensityLabel's own) via
 * the same arithmetic rather than importing the backtest script into the
 * client bundle.
 */
export function lookupScoreCalibration(
  stats: BacktestMetricStats,
  score: number,
  verdict: string,
  regimeTags: string[]
): ScoreCalibrationCellSnapshot | null {
  if (verdict !== "bullish" && verdict !== "bearish") return null;
  const strength = Math.abs(score - 50) >= 15 ? "clear" : "leaning";
  const trend = regimeTags.includes("bull") ? "bull" : regimeTags.includes("bear") ? "bear" : "neutral";
  const cell = stats.scoreCalibration?.[`${verdict}:${strength}:${trend}`];
  return cell && cell.calibrated ? cell : null;
}

export interface AgreementBucketStat {
  bucketLabel: string;
  n: number;
  winRate: number | null;
  meanReturnPct: number | null;
  significant: boolean | null;
}

/**
 * Bucket definitions for `sampleSizeLabel`.
 *
 * TAKES THE EFFECTIVE SAMPLE, NOT THE RAW COUNT. This label is a claim about
 * how much independent evidence stands behind a win rate, and the raw count
 * overstates that roughly two-fold because the replay scores two correlated
 * assets on every calendar day. Feeding it the raw count made "Large" mean
 * "large in rows", which is not what a reader takes it to mean.
 *
 * ── The cut points, and an honest note about one of them ──────────────
 *
 * 200 and 1000 were chosen against the RAW distribution of ten metrics, where
 * the two widest gaps sat at 33→536 and 806→1269, so both landed in real gaps
 * rather than being round numbers picked without looking.
 *
 * That distribution no longer exists — the roster is twelve now, and the
 * values are effective rather than raw. Measured, not assumed, the current
 * one is:
 *
 *   17, 271, 324, 403, 636, 881, 1033, 1098, 1131, 1170, 1175, 1353
 *
 * **200 still lands in the widest gap (17→271). 1000 does not.** It falls in
 * 881→1033, which is a genuine gap but only the sixth widest; 403→636 and
 * 636→881 are both wider and sit below it. Chosen fresh on this data, a
 * Medium/Large boundary would plausibly land nearer 750.
 *
 * The cut points are deliberately NOT being moved. 1000 was fixed before
 * anyone knew which metrics would land where, and re-drawing it now — after
 * seeing that it demotes market structure from Large to Medium at 881 — would
 * be choosing a threshold to obtain a label. That is the same
 * after-the-fact-tuning this codebase corrects for everywhere else.
 *
 * What this does mean: the Large/Medium boundary is SENSITIVE right now, with
 * a metric sitting 12% below it. Read "Medium" at 881 as "near the boundary",
 * not as a verdict. If the roster or the replay universe changes materially,
 * re-derive both cut points from scratch — before looking at which metric
 * lands where.
 */
export function deriveSampleSizeLabel(effectiveN: number): "Small" | "Medium" | "Large" {
  return effectiveN < 200 ? "Small" : effectiveN < 1000 ? "Medium" : "Large";
}

/**
 * Confidence is deliberately a JOINT function of sample size AND
 * significance, never size alone — a large sample that doesn't clear
 * significance is not "High" confidence just because N is big. This is
 * the concrete mechanism behind "do not create... unsupported confidence
 * scores": a metric can only reach High by being both well-sampled and
 * statistically real.
 */
export function deriveConfidenceLabel(
  size: "Small" | "Medium" | "Large",
  significant: boolean
): "Low" | "Medium" | "High" {
  if (size === "Large" && significant) return "High";
  if ((size === "Large" && !significant) || (size === "Medium" && significant)) return "Medium";
  return "Low";
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
  /**
   * Drift-adjusted fields, present on every stat generated after the H1
   * correction (design doc): `nullWinRate` is what firing blindly in the
   * same directions would have won — each occurrence's null is the base
   * rate of ITS direction for ITS asset — and `pValue` above is tested
   * against THAT, not against a fair coin. Optional only so stats
   * serialized before the correction still typecheck.
   */
  nullWinRate?: number;
  /** winRate − nullWinRate, proportion points. The honest size of the edge. */
  edgeVsNull?: number;
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

/** Quartiles of `bias.agreement` (0-100 scale) — shared by report.ts's generator and the live lookup below so they can never bucket a given agreement value differently. */
export const AGREEMENT_BUCKETS: Array<{ label: string; test: (agreement: number) => boolean }> = [
  { label: "0-25%", test: (a) => a < 25 },
  { label: "25-50%", test: (a) => a >= 25 && a < 50 },
  { label: "50-75%", test: (a) => a >= 50 && a < 75 },
  { label: "75-100%", test: (a) => a >= 75 },
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
 * Reads from `BacktestMetricStats` (the small live-bundled file) — unlike
 * `lookupHypothesisStat`/`lookupRegimeStat`/`lookupMetricRegimeStat` below,
 * this one IS wired into live components (`HistoricalPerformancePanel`).
 * Same universal rule as every other lookup in this file: renders nothing
 * below MIN_SAMPLE_N rather than a number with false confidence — checked
 * here in addition to the generator's own gating in report.ts, since a
 * stat with no historical source at all (n24h === null) must never render
 * either, even though it technically fails the ">=" comparison the same way.
 */
export function lookupMetricPerformance(
  stats: BacktestMetricStats,
  metricId: string
): MetricPerformanceSummary | null {
  const stat = stats.metrics[metricId];
  return stat && stat.hasHistoricalSource && stat.n24h !== null && stat.n24h >= MIN_SAMPLE_N ? stat : null;
}

/** Same MIN_SAMPLE_N gate as every other lookup here. `agreement` is bias.agreement (0-100), not a fraction. */
export function lookupAgreementBucket(stats: BacktestMetricStats, agreement: number): AgreementBucketStat | null {
  const bucket = AGREEMENT_BUCKETS.find((b) => b.test(agreement));
  if (!bucket) return null;
  const stat = stats.agreementBuckets.find((s) => s.bucketLabel === bucket.label);
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

// ── Execution-layer stats (src/data/executionStats.json) ────────────────

/**
 * The trade-level counterpart to the signal-level stats above. Kept as a
 * separate snapshot because it answers a different question — "would this
 * TRADE have made money" rather than "did price drift the right way" — and
 * because the two have genuinely different sample sizes (2,896 signal-days
 * vs 1,350 resolved trades).
 */
export interface TradeStatsSnapshot {
  n: number;
  winRatePct: number;
  targetHitRatePct: number;
  stopHitRatePct: number;
  timeoutRatePct: number;
  expectancyNetPct: number;
  mae: { p25: number; median: number; p75: number } | null;
  mfe: { p25: number; median: number; p75: number } | null;
}

export interface CalibrationBucketSnapshot {
  label: string;
  lowerBound: number;
  upperBound: number;
  n: number;
  observedRatePct: number;
  interval: { point: number; lower: number; upper: number };
  impliedRatePct: number;
  calibrationErrorPct: number;
}

export interface ExecutionStatsSnapshot {
  provenance: { engineVersion: string; featureVersion: string; coverageStart: string | null; coverageEnd: string | null };
  overall: TradeStatsSnapshot | null;
  bySide: Array<{ label: string; stats: TradeStatsSnapshot }>;
  calibration24h: {
    buckets: CalibrationBucketSnapshot[];
    monotonic: boolean | null;
    meanAbsoluteCalibrationErrorPct: number | null;
    interpretation: string;
  };
}

/**
 * Trade statistics for one direction. Direction matters enormously here —
 * measured over the backtest window longs and shorts differ by nearly a
 * full percentage point of expectancy per trade — so showing a blended
 * number next to a specific long or short setup would be actively
 * misleading.
 */
export function lookupTradeStatsBySide(
  stats: ExecutionStatsSnapshot,
  side: "long" | "short"
): TradeStatsSnapshot | null {
  const segment = stats.bySide.find((s) => s.label === side);
  if (!segment || segment.stats.n < MIN_SAMPLE_N) return null;
  return segment.stats;
}

/**
 * The calibration bucket a live confidence score falls into, so the UI can
 * report what that band has ACTUALLY produced rather than implying the
 * score is a probability. Returns null when the band was too thin to
 * measure — in which case the UI must say nothing rather than guess.
 */
export function lookupCalibrationBucket(
  stats: ExecutionStatsSnapshot,
  confidence: number
): CalibrationBucketSnapshot | null {
  return (
    stats.calibration24h.buckets.find(
      (b) => confidence >= b.lowerBound && (b.upperBound === 100 ? confidence <= 100 : confidence < b.upperBound)
    ) ?? null
  );
}
