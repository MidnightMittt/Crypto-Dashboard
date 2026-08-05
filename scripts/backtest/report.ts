import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  SQUEEZE_SCORE_BUCKETS,
  AGREEMENT_BUCKETS,
  RegimeStat,
  BacktestStats,
  BacktestResearch,
  BacktestMetricStats,
  MetricPerformanceSummary,
  AgreementBucketStat,
  HypothesisStat,
  MIN_SAMPLE_N,
  RollingWindowStats,
  MetricComboStat,
  SignalResearchReport,
  deriveSampleSizeLabel,
  deriveConfidenceLabel,
} from "../../src/lib/sentiment/backtestStats";
import { MarketRegime } from "../../src/types/market";
import { SIGNAL_HYPOTHESES, HOLDING_PERIODS, HoldingPeriod } from "../../src/lib/signals/hypothesis";
import { summarizeOccurrences, Occurrence } from "./metrics";
import { buildCombinations, CombinationDayRecord } from "./combinations";
import { buildWeightReview, WeightReviewDayRecord } from "./weightReview";
import { buildMetricCombinations, MetricComboDayRecord } from "./metricCombinations";

/**
 * Aggregates run.ts's per-day output into descriptive statistics. These are
 * NOT calibrated probabilities — one ~130-day window covering one stretch of
 * market conditions, not multiple cycles. Treat as a first, honest look at
 * whether these scores' own internal logic ("fade the crowded side") lines
 * up with what actually happened, not a validated edge.
 *
 * Writes two things:
 *   - scripts/backtest/report.md — human-readable, gitignored, regenerated
 *     each run.
 *   - src/data/backtestStats.json — the small, committed snapshot the live
 *     site reads via src/lib/sentiment/backtestStats.ts's lookup functions.
 *     Bucket definitions live in that shared module so this generator and
 *     the live lookup can never disagree on what a bucket means.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const STATS_OUT_PATH = path.join(__dirname, "..", "..", "src", "data", "backtestStats.json");
const RESEARCH_OUT_PATH = path.join(__dirname, "..", "..", "src", "data", "backtestResearch.json");
const METRIC_STATS_OUT_PATH = path.join(__dirname, "..", "..", "src", "data", "backtestMetricStats.json");

export interface DayRecord {
  asset: string;
  date: string;
  t: number;
  squeezeScore: number | null;
  squeezeSide: string | null;
  thesisRegime: string | null;
  biasVerdict: string | null;
  /** 0-100, run.ts's bias?.confidence — evidence QUALITY, not concurrence. */
  biasConfidence: number | null;
  /** 0-100, run.ts's bias?.agreement — how much the metrics concur with each other, a DIFFERENT axis from confidence. */
  biasAgreement: number | null;
  categories: Array<{ category: string; score: number; verdict: string }>;
  metrics: Array<{ id: string; verdict: string }>;
  regimeTags: string[];
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn1d: number | null;
  forwardReturn3d: number | null;
  forwardReturn7d: number | null;
}

interface RollingDayRecord extends DayRecord {
  windowLabel: string;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const fmt = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const nums = (xs: Array<number | null>): number[] => xs.filter((v): v is number => v !== null);

function buildRegimeStat(bucket: DayRecord[]): RegimeStat {
  const r1 = nums(bucket.map((r) => r.forwardReturn1d));
  const r3 = nums(bucket.map((r) => r.forwardReturn3d));
  const r7 = nums(bucket.map((r) => r.forwardReturn7d));
  return {
    n: bucket.length,
    mean1dPct: mean(r1) ?? 0,
    mean3dPct: mean(r3) ?? 0,
    mean7dPct: mean(r7) ?? 0,
    fadeHitRatePct: null, // filled in by callers that have a "side" to fade against
  };
}

function squeezeSection(records: DayRecord[]): { markdown: string; stats: Record<string, RegimeStat> } {
  const rows: string[] = [
    "| Score bucket | Side | N | Mean 1d | Mean 3d | Mean 7d | Fade hit-rate* |",
    "|---|---|---|---|---|---|---|",
  ];
  const stats: Record<string, RegimeStat> = {};

  for (const { label, test } of SQUEEZE_SCORE_BUCKETS) {
    for (const side of ["long", "short"] as const) {
      const bucket = records.filter((r) => r.squeezeScore !== null && test(r.squeezeScore) && r.squeezeSide === side);
      if (bucket.length === 0) continue;

      const r7WithValue = bucket.filter((r) => r.forwardReturn7d !== null);
      const fadeHits = r7WithValue.filter((r) =>
        side === "long" ? (r.forwardReturn7d as number) < 0 : (r.forwardReturn7d as number) > 0
      ).length;
      const fadeHitRatePct = r7WithValue.length ? (fadeHits / r7WithValue.length) * 100 : null;

      const stat = buildRegimeStat(bucket);
      stat.fadeHitRatePct = fadeHitRatePct;
      stats[`${label}:${side}`] = stat;

      rows.push(
        `| ${label} | ${side} | ${bucket.length} | ${fmt(stat.mean1dPct)} | ${fmt(stat.mean3dPct)} | ${fmt(stat.mean7dPct)} | ${fadeHitRatePct === null ? "—" : `${fadeHitRatePct.toFixed(0)}%`} |`
      );
    }
  }
  rows.push("");
  rows.push('*Fade hit-rate: how often price moved opposite the crowded side over the next 7 days — the behavior squeezeRisk\'s own "fade the extreme" framing predicts.');
  return { markdown: rows.join("\n"), stats };
}

function thesisSection(records: DayRecord[]): { markdown: string; stats: Partial<Record<MarketRegime, RegimeStat>> } {
  const regimes = Array.from(new Set(records.map((r) => r.thesisRegime).filter((r): r is string => r !== null)));
  const rows: string[] = ["| Regime | N | Mean 1d | Median 1d | Mean 3d | Mean 7d |", "|---|---|---|---|---|---|"];
  const stats: Partial<Record<MarketRegime, RegimeStat>> = {};

  for (const regime of regimes) {
    const bucket = records.filter((r) => r.thesisRegime === regime);
    const r1 = nums(bucket.map((r) => r.forwardReturn1d));
    const stat = buildRegimeStat(bucket);
    stats[regime as MarketRegime] = stat;
    rows.push(`| ${regime} | ${bucket.length} | ${fmt(stat.mean1dPct)} | ${fmt(median(r1))} | ${fmt(stat.mean3dPct)} | ${fmt(stat.mean7dPct)} |`);
  }
  return { markdown: rows.join("\n"), stats };
}

/**
 * Buckets the decision engine's five category rollups by their own verdict —
 * a separate question from the marketThesis regime table above, since
 * categories.ts is a different engine (category-weighted, not
 * marketThesis's flat-evidence scheme).
 */
function categoriesSection(records: DayRecord[]): {
  markdown: string;
  stats: Partial<Record<`${string}:${string}`, RegimeStat>>;
} {
  const rows: string[] = ["| Category | Verdict | N | Mean 1d | Mean 3d | Mean 7d |", "|---|---|---|---|---|---|"];
  const stats: Partial<Record<`${string}:${string}`, RegimeStat>> = {};

  const allCategories = Array.from(new Set(records.flatMap((r) => r.categories.map((c) => c.category)))).sort();

  for (const category of allCategories) {
    for (const verdict of ["bullish", "bearish", "neutral"] as const) {
      const bucket = records.filter((r) => r.categories.some((c) => c.category === category && c.verdict === verdict));
      if (bucket.length === 0) continue;
      const stat = buildRegimeStat(bucket);
      stats[`${category}:${verdict}`] = stat;
      rows.push(`| ${category} | ${verdict} | ${bucket.length} | ${fmt(stat.mean1dPct)} | ${fmt(stat.mean3dPct)} | ${fmt(stat.mean7dPct)} |`);
    }
  }

  return { markdown: rows.join("\n"), stats };
}

/** The overall marketBias verdict (category-weighted engine), bucketed the same simple way. */
function biasVerdictSection(records: DayRecord[]): { markdown: string; stats: Partial<Record<string, RegimeStat>> } {
  const rows: string[] = ["| Bias verdict | N | Mean 1d | Mean 3d | Mean 7d |", "|---|---|---|---|---|"];
  const stats: Partial<Record<string, RegimeStat>> = {};

  for (const verdict of ["bullish", "bearish", "neutral"] as const) {
    const bucket = records.filter((r) => r.biasVerdict === verdict);
    if (bucket.length === 0) continue;
    const stat = buildRegimeStat(bucket);
    stats[verdict] = stat;
    rows.push(`| ${verdict} | ${bucket.length} | ${fmt(stat.mean1dPct)} | ${fmt(stat.mean3dPct)} | ${fmt(stat.mean7dPct)} |`);
  }

  return { markdown: rows.join("\n"), stats };
}

/** Which raw field on a DayRecord holds the forward return for a given holding period. */
function holdingPeriodField(hp: HoldingPeriod): "forwardReturn1h" | "forwardReturn4h" | "forwardReturn1d" | "forwardReturn7d" {
  switch (hp) {
    case "1h":
      return "forwardReturn1h";
    case "4h":
      return "forwardReturn4h";
    case "24h":
      return "forwardReturn1d"; // DayRecord's 1d field IS the 24h forward return; "3d" isn't a hypothesis holding period.
    case "7d":
      return "forwardReturn7d";
  }
}

function occurrencesFor(records: DayRecord[], metricId: string, hp: HoldingPeriod): Occurrence[] {
  const field = holdingPeriodField(hp);
  const occurrences: Occurrence[] = [];
  for (const r of records) {
    const m = r.metrics.find((x) => x.id === metricId);
    if (!m) continue;
    occurrences.push({ t: r.t, verdict: m.verdict as Occurrence["verdict"], forwardReturnPct: r[field] });
  }
  return occurrences;
}

/**
 * One row per (metric with a real historical source) x holding period —
 * the hypothesis-testing framework's core measurement. Rows below
 * MIN_SAMPLE_N print "insufficient data" rather than a number, the same
 * rule the live UI lookups already enforce, so the report and the site can
 * never disagree about what counts as enough evidence to state.
 */
function hypothesesSection(records: DayRecord[]): {
  markdown: string;
  stats: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>>;
} {
  const rows: string[] = [
    "| Metric | Holding | N | Win rate | Mean | Median | Max DD | Bull P/R | Bear P/R | p-value |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  const stats: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>> = {};

  const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);

  for (const h of SIGNAL_HYPOTHESES) {
    if (!h.hasHistoricalSource) continue;
    for (const hp of HOLDING_PERIODS) {
      const occurrences = occurrencesFor(records, h.id, hp);
      const stat = summarizeOccurrences(occurrences, MIN_SAMPLE_N);
      stats[`${h.id}:${hp}`] = stat;

      if (stat.n < MIN_SAMPLE_N) {
        rows.push(`| ${h.label} | ${hp} | ${stat.n} | insufficient data | | | | | | |`);
        continue;
      }

      rows.push(
        `| ${h.label} | ${hp} | ${stat.n} | ${stat.winRate === null ? "—" : `${(stat.winRate * 100).toFixed(0)}%`} | ${fmt(stat.meanReturnPct)} | ${fmt(stat.medianReturnPct)} | ${stat.maxDrawdownPct === null ? "—" : `${stat.maxDrawdownPct.toFixed(2)}%`} | ${pct(stat.bullish.precision)}/${pct(stat.bullish.recall)} | ${pct(stat.bearish.precision)}/${pct(stat.bearish.recall)} | ${stat.significance ? stat.significance.pValue.toFixed(4) : "—"} |`
      );
    }
  }

  rows.push("");
  rows.push(
    "*Bull/Bear P/R: one-vs-rest precision/recall for that class (e.g. Bull P = of the days this metric fired bullish, how often price actually rose; Bull R = of the days price actually rose, how often this metric had fired bullish). p-value is a two-sided exact sign test against a 50% null — small values mean the win rate is unlikely to be a coin flip, not that the effect is large."
  );
  return { markdown: rows.join("\n"), stats };
}

/** Every tag classifyRegime/regimeTagsToStrings can produce — see regimes.ts. Listed explicitly here rather than derived from the data, so a tag with zero occurrences this run still shows as "0" instead of silently vanishing from the table. */
const ALL_REGIME_TAGS = ["bull", "bear", "neutral", "high-vol", "low-vol", "normal-vol", "range-bound"];

/**
 * Bare regime-tag breakdown — no metric crossed in, just "how did price move
 * on days carrying this tag." Answers the coarsest version of item 5 in the
 * reprioritized backtesting spec: does the regime ITSELF carry information.
 */
function regimesSection(records: DayRecord[]): { markdown: string; stats: Partial<Record<string, RegimeStat>> } {
  const rows: string[] = ["| Regime tag | N | Mean 1d | Mean 3d | Mean 7d |", "|---|---|---|---|---|"];
  const stats: Partial<Record<string, RegimeStat>> = {};

  for (const tag of ALL_REGIME_TAGS) {
    const bucket = records.filter((r) => r.regimeTags.includes(tag));
    const stat = buildRegimeStat(bucket);
    stats[tag] = stat;
    rows.push(`| ${tag} | ${bucket.length} | ${fmt(stat.mean1dPct)} | ${fmt(stat.mean3dPct)} | ${fmt(stat.mean7dPct)} |`);
  }

  return { markdown: rows.join("\n"), stats };
}

/** Same shape as occurrencesFor, plus a regime-tag pre-filter — no new statistics code, `summarizeOccurrences` is still the only thing that scores anything. */
function regimeOccurrencesFor(records: DayRecord[], metricId: string, hp: HoldingPeriod, tag: string): Occurrence[] {
  const field = holdingPeriodField(hp);
  const occurrences: Occurrence[] = [];
  for (const r of records) {
    if (!r.regimeTags.includes(tag)) continue;
    const m = r.metrics.find((x) => x.id === metricId);
    if (!m) continue;
    occurrences.push({ t: r.t, verdict: m.verdict as Occurrence["verdict"], forwardReturnPct: r[field] });
  }
  return occurrences;
}

/**
 * Per-metric, per-regime-tag stats — item 5's actual ask ("report signal
 * performance separately for each regime"), not just the bare regime read
 * above. Every (metric x tag x holding period) combination is computed and
 * stored in `stats` regardless of sample size (so a future UI can decide
 * for itself), but the printed markdown table is limited to 24h — 10
 * metrics x 7 tags x 4 holding periods is 280 rows, unreadable in full; 24h
 * alone is still 70 and already makes the point.
 */
function metricRegimeCrosstabSection(records: DayRecord[]): {
  markdown: string;
  stats: Partial<Record<`${string}:${string}:${HoldingPeriod}`, HypothesisStat>>;
} {
  const rows: string[] = ["| Metric | Regime | N | Win rate | Mean | p-value |", "|---|---|---|---|---|---|"];
  const stats: Partial<Record<`${string}:${string}:${HoldingPeriod}`, HypothesisStat>> = {};

  for (const h of SIGNAL_HYPOTHESES) {
    if (!h.hasHistoricalSource) continue;
    for (const tag of ALL_REGIME_TAGS) {
      for (const hp of HOLDING_PERIODS) {
        const occurrences = regimeOccurrencesFor(records, h.id, hp, tag);
        const stat = summarizeOccurrences(occurrences, MIN_SAMPLE_N);
        stats[`${h.id}:${tag}:${hp}`] = stat;

        if (hp !== "24h") continue;
        if (stat.n < MIN_SAMPLE_N) {
          rows.push(`| ${h.label} | ${tag} | ${stat.n} | insufficient data | | |`);
          continue;
        }
        rows.push(
          `| ${h.label} | ${tag} | ${stat.n} | ${stat.winRate === null ? "—" : `${(stat.winRate * 100).toFixed(0)}%`} | ${fmt(stat.meanReturnPct)} | ${stat.significance ? stat.significance.pValue.toFixed(4) : "—"} |`
        );
      }
    }
  }

  return { markdown: rows.join("\n"), stats };
}

/**
 * Recomputes the SAME top-level sections (squeeze/thesis/categories/
 * biasVerdict/hypotheses — every function above, unmodified) separately per
 * overlapping historical window, so a signal's stats can be compared across
 * different stretches of history rather than reported as one number that
 * might just describe one lucky/unlucky period. Optional: returns null
 * when `npm run backtest:rolling` hasn't been run (resultsRolling.json
 * doesn't exist) — the standard `npm run backtest` doesn't require it.
 */
function rollingWindowsSection(): { markdown: string; stats: Record<string, RollingWindowStats> } | null {
  const rollingPath = path.join(DATA_DIR, "resultsRolling.json");
  if (!fs.existsSync(rollingPath)) return null;

  const rollingRecords: RollingDayRecord[] = JSON.parse(fs.readFileSync(rollingPath, "utf8"));
  const labels = Array.from(new Set(rollingRecords.map((r) => r.windowLabel)));

  const stats: Record<string, RollingWindowStats> = {};
  const sections: string[] = [];

  for (const label of labels) {
    const windowRecords = rollingRecords.filter((r) => r.windowLabel === label);
    const dates = windowRecords.map((r) => r.date).sort();

    const squeeze = squeezeSection(windowRecords);
    const thesis = thesisSection(windowRecords);
    const categories = categoriesSection(windowRecords);
    const biasVerdict = biasVerdictSection(windowRecords);
    const hypotheses = hypothesesSection(windowRecords);

    stats[label] = {
      windowStart: dates[0],
      windowEnd: dates[dates.length - 1],
      squeeze: squeeze.stats,
      thesis: thesis.stats,
      categories: categories.stats,
      biasVerdict: biasVerdict.stats,
      hypotheses: hypotheses.stats,
    };

    // Markdown stays lean (biasVerdict + hypotheses only) even though the
    // JSON carries the full stat set above — the point of printing this per
    // window is "does the headline read and the per-metric win rates hold
    // steady," not reproducing every squeeze/thesis/category table 6 times.
    sections.push(`### ${label} (${windowRecords.length} day-records)\n\n${biasVerdict.markdown}\n\n${hypotheses.markdown}`);
  }

  return { markdown: sections.join("\n\n"), stats };
}

/** Among a metric's 4 holding-period buckets (N >= MIN_SAMPLE_N, real win rate), which had the best/worst win rate. */
function bestWorstHoldingPeriod(
  hypothesesStats: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>>,
  metricId: string
): { best: { holdingPeriod: string; winRate: number } | null; worst: { holdingPeriod: string; winRate: number } | null } {
  const candidates = HOLDING_PERIODS.map((hp) => ({ hp, stat: hypothesesStats[`${metricId}:${hp}`] })).filter(
    (c): c is { hp: HoldingPeriod; stat: HypothesisStat } => !!c.stat && c.stat.n >= MIN_SAMPLE_N && c.stat.winRate !== null
  );
  if (candidates.length === 0) return { best: null, worst: null };
  const sorted = [...candidates].sort((a, b) => b.stat.winRate! - a.stat.winRate!);
  return {
    best: { holdingPeriod: sorted[0].hp, winRate: sorted[0].stat.winRate! },
    worst: { holdingPeriod: sorted[sorted.length - 1].hp, winRate: sorted[sorted.length - 1].stat.winRate! },
  };
}

/** Same idea as bestWorstHoldingPeriod, sliced across regime tags at 24h instead of holding periods. */
function bestWorstRegime(
  metricRegimeStats: Partial<Record<`${string}:${string}:${HoldingPeriod}`, HypothesisStat>>,
  metricId: string
): { best: { tag: string; winRate: number } | null; worst: { tag: string; winRate: number } | null } {
  const candidates = ALL_REGIME_TAGS.map((tag) => ({ tag, stat: metricRegimeStats[`${metricId}:${tag}:24h`] })).filter(
    (c): c is { tag: string; stat: HypothesisStat } => !!c.stat && c.stat.n >= MIN_SAMPLE_N && c.stat.winRate !== null
  );
  if (candidates.length === 0) return { best: null, worst: null };
  const sorted = [...candidates].sort((a, b) => b.stat.winRate! - a.stat.winRate!);
  return {
    best: { tag: sorted[0].tag, winRate: sorted[0].stat.winRate! },
    worst: { tag: sorted[sorted.length - 1].tag, winRate: sorted[sorted.length - 1].stat.winRate! },
  };
}

/** Combo entries (named, or automatic AND BH-significant) at 24h that include this metric, most significant first, capped at 5 so one metric's report can't balloon. */
function interactionsFor(combos: MetricComboStat[], metricId: string): MetricComboStat[] {
  return combos
    .filter((c) => c.holdingPeriod === "24h" && c.metricIds.includes(metricId) && (c.isNamed || c.fdr?.significant))
    .sort((a, b) => (a.stat.significance?.pValue ?? 1) - (b.stat.significance?.pValue ?? 1))
    .slice(0, 5);
}

/**
 * One assembled report per metric — pure aggregation of hypothesesSection,
 * metricRegimeCrosstabSection, and metricCombinations' already-computed
 * output. No new statistics anywhere in this function; it only reads
 * max/min out of stats built earlier in this same file.
 */
function signalResearchSection(
  hypothesesStats: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>>,
  metricRegimeStats: Partial<Record<`${string}:${string}:${HoldingPeriod}`, HypothesisStat>>,
  combos: MetricComboStat[]
): { markdown: string; stats: Record<string, SignalResearchReport> } {
  const stats: Record<string, SignalResearchReport> = {};
  const rows: string[] = [
    "| Metric | 24h N | 24h Win Rate | Best Holding | Worst Holding | Best Regime | Worst Regime | Interactions |",
    "|---|---|---|---|---|---|---|---|",
  ];

  for (const h of SIGNAL_HYPOTHESES) {
    const rawHeadline = hypothesesStats[`${h.id}:24h`] ?? null;
    const headline = rawHeadline && rawHeadline.n >= MIN_SAMPLE_N ? rawHeadline : null;
    const { best: bestHp, worst: worstHp } = bestWorstHoldingPeriod(hypothesesStats, h.id);
    const { best: bestRegime, worst: worstRegime } = bestWorstRegime(metricRegimeStats, h.id);
    const interactions = interactionsFor(combos, h.id);

    stats[h.id] = {
      metricId: h.id,
      label: h.label,
      hasHistoricalSource: h.hasHistoricalSource,
      headline,
      bestHoldingPeriod: bestHp,
      worstHoldingPeriod: worstHp,
      bestRegime,
      worstRegime,
      interactions,
    };

    if (!h.hasHistoricalSource) continue; // guaranteed-empty row, skip rather than print all dashes

    const pctStr = (v: { winRate: number } | null, extra: string) => (v ? `${extra} (${(v.winRate * 100).toFixed(0)}%)` : "—");
    rows.push(
      `| ${h.label} | ${rawHeadline?.n ?? 0} | ${headline?.winRate !== null && headline?.winRate !== undefined ? `${(headline.winRate * 100).toFixed(0)}%` : "—"} | ${pctStr(bestHp, bestHp?.holdingPeriod ?? "")} | ${pctStr(worstHp, worstHp?.holdingPeriod ?? "")} | ${pctStr(bestRegime, bestRegime?.tag ?? "")} | ${pctStr(worstRegime, worstRegime?.tag ?? "")} | ${interactions.length} |`
    );
  }

  return { markdown: rows.join("\n"), stats };
}

/**
 * Does the 24h win-rate's direction (above/below 50%) agree across a
 * majority of the rolling windows? Only counts windows whose OWN sample at
 * 24h clears MIN_SAMPLE_N — a window with too few occurrences to judge is
 * skipped rather than treated as disagreement. Requires at least 3
 * qualifying windows before making any claim at all; below that, "stable"
 * or "unstable" would itself be a thin-sample guess, so this returns null
 * (honest "can't tell yet") instead.
 */
/**
 * Tests whether the composite bias score's own "agreement" figure (how
 * much the 15 metrics concur, src/lib/signals/confidence.ts's agreementOf)
 * is doing real predictive work or is cosmetic — buckets every historical
 * day by its agreement quartile and checks whether the overall verdict's
 * sign-match rate against the next day's return actually differs across
 * buckets. Reuses summarizeOccurrences/testSignificance from metrics.ts,
 * the exact same machinery hypothesesSection above already uses — no new
 * statistics, only a new grouping of the same forward-return data.
 */
export function agreementValidationSection(records: DayRecord[]): {
  markdown: string;
  stats: AgreementBucketStat[];
} {
  const rows: string[] = [
    "| Agreement bucket | N | Win rate | Mean 1d | p-value |",
    "|---|---|---|---|---|",
  ];
  const stats: AgreementBucketStat[] = [];

  for (const bucket of AGREEMENT_BUCKETS) {
    const occurrences: Occurrence[] = records
      .filter((r) => r.biasAgreement !== null && bucket.test(r.biasAgreement) && r.biasVerdict !== null)
      .map((r) => ({ t: r.t, verdict: r.biasVerdict as Occurrence["verdict"], forwardReturnPct: r.forwardReturn1d }));
    const stat = summarizeOccurrences(occurrences, MIN_SAMPLE_N);

    stats.push({
      bucketLabel: bucket.label,
      n: stat.n,
      winRate: stat.n >= MIN_SAMPLE_N ? stat.winRate : null,
      meanReturnPct: stat.n >= MIN_SAMPLE_N ? stat.meanReturnPct : null,
      significant: stat.significance?.significant ?? null,
    });

    if (stat.n < MIN_SAMPLE_N) {
      rows.push(`| ${bucket.label} | ${stat.n} | insufficient data | | |`);
      continue;
    }
    rows.push(
      `| ${bucket.label} | ${stat.n} | ${stat.winRate === null ? "—" : `${(stat.winRate * 100).toFixed(0)}%`} | ${fmt(stat.meanReturnPct)} | ${stat.significance ? stat.significance.pValue.toFixed(4) : "—"} |`
    );
  }

  return { markdown: rows.join("\n"), stats };
}

export function computeStability(
  rollingStats: Record<string, RollingWindowStats> | undefined,
  metricId: string,
  headlineWinRate: number | null
): boolean | null {
  if (!rollingStats || headlineWinRate === null) return null;
  const headlineDirection = headlineWinRate > 0.5;

  let agree = 0;
  let qualifying = 0;
  for (const window of Object.values(rollingStats)) {
    const stat = window.hypotheses[`${metricId}:24h`];
    if (!stat || stat.n < MIN_SAMPLE_N || stat.winRate === null) continue;
    qualifying++;
    if ((stat.winRate > 0.5) === headlineDirection) agree++;
  }

  if (qualifying < 3) return null;
  return agree / qualifying >= 2 / 3;
}

/**
 * Trims signalResearchSection's already-computed output (plus one direct
 * 7d lookup and the rolling-window stability check above) down to the
 * small live-bundled shape `HistoricalPerformancePanel` reads. No new
 * statistics — pure projection, same "aggregation only" spirit as
 * signalResearchSection itself.
 */
export function metricPerformanceSection(
  signalResearch: Record<string, SignalResearchReport>,
  hypothesesStats: Partial<Record<`${string}:${HoldingPeriod}`, HypothesisStat>>,
  rollingStats: Record<string, RollingWindowStats> | undefined
): Record<string, MetricPerformanceSummary> {
  const out: Record<string, MetricPerformanceSummary> = {};

  for (const h of SIGNAL_HYPOTHESES) {
    const research = signalResearch[h.id];
    const headline = research?.headline ?? null; // already gated at N >= MIN_SAMPLE_N by signalResearchSection
    const raw7d = hypothesesStats[`${h.id}:7d`] ?? null;
    const winRate7d = raw7d && raw7d.n >= MIN_SAMPLE_N ? raw7d.winRate : null;

    const n24h = headline?.n ?? null;
    const significant24h = headline?.significance?.significant ?? null;
    const size = headline !== null ? deriveSampleSizeLabel(headline.n) : null;
    const confidence = size !== null && significant24h !== null ? deriveConfidenceLabel(size, significant24h) : null;

    out[h.id] = {
      metricId: h.id,
      label: h.label,
      hasHistoricalSource: h.hasHistoricalSource,
      n24h,
      winRate24h: headline?.winRate ?? null,
      winRate7d,
      significant24h,
      bestRegime: research?.bestRegime ?? null,
      worstRegime: research?.worstRegime ?? null,
      bestHoldingPeriod: research?.bestHoldingPeriod ?? null,
      worstHoldingPeriod: research?.worstHoldingPeriod ?? null,
      sampleSizeLabel: size,
      confidenceLabel: confidence,
      stableAcrossWindows: computeStability(rollingStats, h.id, headline?.winRate ?? null),
    };
  }

  return out;
}

function main() {
  const resultsPath = path.join(DATA_DIR, "results.json");
  if (!fs.existsSync(resultsPath)) {
    console.error(`Missing ${resultsPath} — run "npm run backtest" first.`);
    process.exit(1);
  }
  const records: DayRecord[] = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const assets = Array.from(new Set(records.map((r) => r.asset)));
  const dates = records.map((r) => r.date).sort();
  const coverageStart = dates[0];
  const coverageEnd = dates[dates.length - 1];

  const squeeze = squeezeSection(records);
  const thesis = thesisSection(records);
  const categories = categoriesSection(records);
  const biasVerdict = biasVerdictSection(records);
  const hypotheses = hypothesesSection(records);
  const combinations = buildCombinations(records as CombinationDayRecord[]);
  const weightReview = buildWeightReview(records as WeightReviewDayRecord[]);
  const regimes = regimesSection(records);
  const metricRegimeCrosstab = metricRegimeCrosstabSection(records);
  const rolling = rollingWindowsSection();
  const metricCombinations = buildMetricCombinations(records as MetricComboDayRecord[]);
  const signalResearch = signalResearchSection(hypotheses.stats, metricRegimeCrosstab.stats, metricCombinations.results);
  const metricPerformance = metricPerformanceSection(signalResearch.stats, hypotheses.stats, rolling?.stats);
  const agreementValidation = agreementValidationSection(records);

  const header = `# Backtest Report

Generated ${new Date().toISOString()}

**Coverage:** ${assets.join(", ")}, ${coverageStart} to ${coverageEnd} (${records.length} evaluated days total).
Open interest and long/short ratio now come from Coinalyze (migrated off OKX's rubik endpoint,
which was hard-capped at 180 daily points with no pagination) — OI reaches back to roughly
2022-06-25 and long/short to roughly 2020-05-31 as of the last fetch, both a rolling retention
window rather than a fixed archive, so the exact start date creeps forward on every future
re-fetch. Treat everything below as descriptive statistics over the window actually on disk right
now, not a validated, out-of-sample probability.

**Evidence included:** funding rate, funding percentile, open interest percentile/change,
long/short ratio, price change, basis vs. spot — all of squeezeRisk's inputs, and 0.62 of
marketThesis's raw evidence weight (funding 0.20 + long/short 0.12 + squeezeRisk 0.18 + basis
0.12).

**Evidence excluded (no historical source available):** order flow/CVD, Deribit options,
exchange-flow wallet netflow, Coinbase premium — 0.38 of marketThesis's raw weight, dropped and
renormalized (the same "missing source" behavior buildMarketThesis already has for live data).

**Methodology note:** funding rate is Binance's own rate, used as a single-venue proxy — the
live dashboard's OI-weighted composite across many venues isn't reconstructable historically.
Open interest and long/short ratio are daily-resolution (Coinalyze's native granularity for these
endpoints); the live dashboard samples roughly every 5 minutes. All inputs for day *t* are built
only from data strictly before *t*, matching this app's own live "prior series" convention — no
lookahead.

## Positioning Intelligence (squeezeRisk)
`;

  const body = `
${squeeze.markdown}

## Market Thesis (regime)

${thesis.markdown}

## Decision Engine — Category Rollups

The category-weighted engine (lib/signals/categories.ts), NOT the marketThesis regime table
above — a separate system, added and backtested for the first time in this pass. Order flow,
Coinbase premium, Deribit options, and exchange netflow are excluded from every category here for
the same reason as above (no historical source); Fear & Greed, stablecoin supply, and ETF flows
ARE included, newly backtestable this pass.

${categories.markdown}

## Decision Engine — Overall Bias Verdict

${biasVerdict.markdown}

## Hypothesis Testing — Per-Metric, Per-Holding-Period

Every metric with a real historical source (10 of 15 — see src/lib/signals/hypothesis.ts for the
full contract, including the 5 with no source yet), tested as an explicit hypothesis: entry =
verdict fires bullish/bearish, exit = time-based only (no stop-loss/take-profit), success/failure
= sign-only match with the forward return. Rows below N=${MIN_SAMPLE_N} report "insufficient
data" rather than a number, matching this app's standing rule that a thin sample is hidden, not
stated with false confidence.

${hypotheses.markdown}

## Category Combinations

${combinations.markdown}

## Weight Review (proposal only — no file below this line is touched by any script)

${weightReview.markdown}

## Market Regimes

Every day tagged with independent trend (bull/bear/neutral), volatility (high/low/normal), and
range-bound flags — see src/lib/technicals/regimes.ts for the exact thresholds, each checked
against this app's own real trailing-return/volatility distributions rather than guessed. A day
can carry more than one tag (e.g. bull + high-vol).

${regimes.markdown}

## Per-Metric, Per-Regime Performance (24h holding period)

The same hypothesis-testing measurement as the section above, sliced by regime tag — does this
metric perform differently in a bull market than a bear market, in high vol than low vol. Every
(metric x tag x holding period) combination is computed and stored in backtestStats.json
regardless of N; this table shows 24h only for readability.

${metricRegimeCrosstab.markdown}
${
  rolling
    ? `\n## Rolling Windows\n\nThe same overall-bias-verdict and per-metric hypothesis stats above, recomputed separately per overlapping historical window (run \`npm run backtest:rolling\` to regenerate) — the direct answer to "is this edge real across market cycles, or was it one lucky/unlucky stretch."\n\n${rolling.markdown}\n`
    : `\n## Rolling Windows\n\nNot generated this run — run \`npm run backtest:rolling\` to produce scripts/backtest/data/resultsRolling.json first, then re-run \`npm run backtest\`'s report step.\n`
}

## Metric Combinations

Named, pre-registered combinations (specified before this file was written, exempt from multiple-
testing correction), plus a bounded automatic scan of all C(15,2)=105 metric pairs with a real
Benjamini-Hochberg FDR correction — see scripts/backtest/metricCombinations.ts for exactly why
these two tiers are treated differently.

${metricCombinations.markdown}

## Per-Signal Research Report

One row per metric, entirely aggregated from the sections above — no new computation. "Best/Worst
Holding" and "Best/Worst Regime" only consider buckets that clear N >= ${MIN_SAMPLE_N};
"Interactions" counts named combos plus BH-significant automatic pairs at 24h that include this
metric (see backtestResearch.json's \`signalResearch\` field for the full per-metric detail,
including which specific combos).

${signalResearch.markdown}

## Agreement Validation

Does \`bias.agreement\` (how much the 15 metrics concur, NOT the same axis as confidence — see
marketBias.ts) historically correlate with a better hit rate? Every historical day bucketed into
an agreement quartile; within each bucket, does the overall bias verdict's direction match the
next day's return sign more often than chance. Same sign-test machinery every other section here
already uses.

${agreementValidation.markdown}
`;

  const report = header + body;
  fs.writeFileSync(path.join(DATA_DIR, "..", "report.md"), report);
  console.log(report);
  console.log(`[report] wrote scripts/backtest/report.md`);

  // Small, live-bundled snapshot — only what the 3 live components actually
  // read. Keep this file small on purpose; see backtestStats.ts's header
  // comment for why the split exists.
  const statsOut: BacktestStats = {
    generatedAt: Date.now(),
    coverageStart,
    coverageEnd,
    squeeze: squeeze.stats,
    thesis: thesis.stats,
    categories: categories.stats,
    biasVerdict: biasVerdict.stats,
  };
  fs.mkdirSync(path.dirname(STATS_OUT_PATH), { recursive: true });
  fs.writeFileSync(STATS_OUT_PATH, JSON.stringify(statsOut, null, 2));
  console.log(`[report] wrote src/data/backtestStats.json`);

  // Large, research-only snapshot — never imported by a live component.
  const researchOut: BacktestResearch = {
    generatedAt: Date.now(),
    coverageStart,
    coverageEnd,
    hypotheses: hypotheses.stats,
    combinations: combinations.results,
    regimes: regimes.stats,
    metricRegimeCrosstab: metricRegimeCrosstab.stats,
    ...(rolling ? { rollingWindows: rolling.stats } : {}),
    metricCombinations: metricCombinations.results,
    signalResearch: signalResearch.stats,
  };
  fs.mkdirSync(path.dirname(RESEARCH_OUT_PATH), { recursive: true });
  fs.writeFileSync(RESEARCH_OUT_PATH, JSON.stringify(researchOut, null, 2));
  console.log(`[report] wrote src/data/backtestResearch.json`);

  // Small, live-bundled per-metric performance snapshot — see
  // backtestStats.ts's MetricPerformanceSummary doc comment for what's
  // trimmed out and why.
  const metricStatsOut: BacktestMetricStats = {
    generatedAt: Date.now(),
    coverageStart,
    coverageEnd,
    metrics: metricPerformance,
    agreementBuckets: agreementValidation.stats,
  };
  fs.mkdirSync(path.dirname(METRIC_STATS_OUT_PATH), { recursive: true });
  fs.writeFileSync(METRIC_STATS_OUT_PATH, JSON.stringify(metricStatsOut, null, 2));
  console.log(`[report] wrote src/data/backtestMetricStats.json`);
}

// Guarded the same way run.ts's own main() is: importing this file for its
// pure functions (report.test.ts) must not trigger a full report
// regeneration as a side effect.
if (process.argv[1] && process.argv[1].endsWith("report.ts")) {
  main();
}
