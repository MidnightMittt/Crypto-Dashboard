import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Aggregates run.ts's per-day output into descriptive statistics. These are
 * NOT calibrated probabilities — one ~130-day window covering one stretch of
 * market conditions, not multiple cycles. Treat as a first, honest look at
 * whether these scores' own internal logic ("fade the crowded side") lines
 * up with what actually happened, not a validated edge.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

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

const SQUEEZE_BUCKETS: Array<[string, (s: number) => boolean]> = [
  ["0-30 (quiet)", (s) => s < 30],
  ["30-50", (s) => s >= 30 && s < 50],
  ["50-70", (s) => s >= 50 && s < 70],
  ["70-100 (crowded)", (s) => s >= 70],
];

function squeezeTable(records: DayRecord[]): string {
  const rows: string[] = [
    "| Score bucket | Side | N | Mean 1d | Mean 3d | Mean 7d | Fade hit-rate* |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [label, inBucket] of SQUEEZE_BUCKETS) {
    for (const side of ["long", "short"] as const) {
      const bucket = records.filter(
        (r) => r.squeezeScore !== null && inBucket(r.squeezeScore) && r.squeezeSide === side
      );
      if (bucket.length === 0) continue;
      const r7 = bucket.map((r) => r.forwardReturn7d).filter((v): v is number => v !== null);
      // "Fade the extreme" thesis: crowded longs -> expect price to fall; crowded shorts -> expect price to rise.
      const fadeHits = bucket.filter((r) => {
        if (r.forwardReturn7d === null) return false;
        return side === "long" ? r.forwardReturn7d < 0 : r.forwardReturn7d > 0;
      }).length;
      const withReturn = bucket.filter((r) => r.forwardReturn7d !== null).length;
      const hitRate = withReturn ? `${((fadeHits / withReturn) * 100).toFixed(0)}%` : "—";
      rows.push(
        `| ${label} | ${side} | ${bucket.length} | ${fmt(mean(bucket.map((r) => r.forwardReturn1d).filter((v): v is number => v !== null)))} | ${fmt(mean(bucket.map((r) => r.forwardReturn3d).filter((v): v is number => v !== null)))} | ${fmt(mean(r7))} | ${hitRate} |`
      );
    }
  }
  rows.push("");
  rows.push("*Fade hit-rate: how often price moved opposite the crowded side over the next 7 days — the behavior squeezeRisk's own \"fade the extreme\" framing predicts.");
  return rows.join("\n");
}

function thesisTable(records: DayRecord[]): string {
  const regimes = Array.from(new Set(records.map((r) => r.thesisRegime).filter((r): r is string => r !== null)));
  const rows: string[] = ["| Regime | N | Mean 1d | Median 1d | Mean 3d | Mean 7d |", "|---|---|---|---|---|---|"];
  for (const regime of regimes) {
    const bucket = records.filter((r) => r.thesisRegime === regime);
    const r1 = bucket.map((r) => r.forwardReturn1d).filter((v): v is number => v !== null);
    const r3 = bucket.map((r) => r.forwardReturn3d).filter((v): v is number => v !== null);
    const r7 = bucket.map((r) => r.forwardReturn7d).filter((v): v is number => v !== null);
    rows.push(`| ${regime} | ${bucket.length} | ${fmt(mean(r1))} | ${fmt(median(r1))} | ${fmt(mean(r3))} | ${fmt(mean(r7))} |`);
  }
  return rows.join("\n");
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

  const header = `# Backtest Report

Generated ${new Date().toISOString()}

**Coverage:** ${assets.join(", ")}, ${dates[0]} to ${dates[dates.length - 1]} (${records.length} evaluated days total).
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
${squeezeTable(records)}

## Market Thesis (regime)

${thesisTable(records)}
`;

  const report = header + body;
  fs.writeFileSync(path.join(DATA_DIR, "..", "report.md"), report);
  console.log(report);
  console.log(`\n[report] wrote scripts/backtest/report.md`);
}

main();
