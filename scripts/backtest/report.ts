import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SQUEEZE_SCORE_BUCKETS, RegimeStat, BacktestStats } from "../../src/lib/sentiment/backtestStats";
import { MarketRegime } from "../../src/types/market";

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
  squeezeScore: number | null;
  squeezeSide: string | null;
  thesisRegime: string | null;
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
  };
  fs.mkdirSync(path.dirname(STATS_OUT_PATH), { recursive: true });
  fs.writeFileSync(STATS_OUT_PATH, JSON.stringify(statsOut, null, 2));
  console.log(`[report] wrote src/data/backtestStats.json`);
}

main();
