import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SQUEEZE_SCORE_BUCKETS, RegimeStat, BacktestStats, HypothesisStat, MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";
import { MarketRegime } from "../../src/types/market";
import { SIGNAL_HYPOTHESES, HOLDING_PERIODS, HoldingPeriod } from "../../src/lib/signals/hypothesis";
import { summarizeOccurrences, Occurrence } from "./metrics";
import { buildCombinations, CombinationDayRecord } from "./combinations";
import { buildWeightReview, WeightReviewDayRecord } from "./weightReview";

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

interface DayRecord {
  asset: string;
  date: string;
  t: number;
  squeezeScore: number | null;
  squeezeSide: string | null;
  thesisRegime: string | null;
  biasVerdict: string | null;
  categories: Array<{ category: string; score: number; verdict: string }>;
  metrics: Array<{ id: string; verdict: string }>;
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn1d: number | null;
  forwardReturn3d: number | null;
  forwardReturn7d: number | null;
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

  const header = `# Backtest Report

Generated ${new Date().toISOString()}

**Coverage:** ${assets.join(", ")}, ${coverageStart} to ${coverageEnd} (${records.length} evaluated days total).
Window length is bounded by OKX's open-interest and long/short history, which is hard-capped at
180 daily points with no pagination — this covers roughly one market stretch, not multiple
cycles. Treat everything below as descriptive statistics over that one window, not a validated,
out-of-sample probability.

**Evidence included:** funding rate, funding percentile, open interest percentile/change,
long/short ratio, price change, basis vs. spot — all of squeezeRisk's inputs, and 0.62 of
marketThesis's raw evidence weight (funding 0.20 + long/short 0.12 + squeezeRisk 0.18 + basis
0.12).

**Evidence excluded (no historical source available):** order flow/CVD, Deribit options,
exchange-flow wallet netflow, Coinbase premium — 0.38 of marketThesis's raw weight, dropped and
renormalized (the same "missing source" behavior buildMarketThesis already has for live data).

**Methodology note:** funding rate is Binance's own rate, used as a single-venue proxy — the
live dashboard's OI-weighted composite across many venues isn't reconstructable historically.
Open interest and long/short ratio are daily-resolution (OKX's native granularity for this
endpoint); the live dashboard samples roughly every 5 minutes. All inputs for day *t* are built
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
`;

  const report = header + body;
  fs.writeFileSync(path.join(DATA_DIR, "..", "report.md"), report);
  console.log(report);
  console.log(`[report] wrote scripts/backtest/report.md`);

  const statsOut: BacktestStats = {
    generatedAt: Date.now(),
    coverageStart,
    coverageEnd,
    squeeze: squeeze.stats,
    thesis: thesis.stats,
    categories: categories.stats,
    biasVerdict: biasVerdict.stats,
    hypotheses: hypotheses.stats,
    combinations: combinations.results,
  };
  fs.mkdirSync(path.dirname(STATS_OUT_PATH), { recursive: true });
  fs.writeFileSync(STATS_OUT_PATH, JSON.stringify(statsOut, null, 2));
  console.log(`[report] wrote src/data/backtestStats.json`);
}

main();
