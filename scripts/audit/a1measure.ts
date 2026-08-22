import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import marketContextJson from "../../src/data/marketContext.json";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { Bar } from "../../src/lib/research/types";

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const LOOKBACK_MS = 5 * 365 * 24 * 3600 * 1000;
const ctx = marketContextJson as any;

const rows: string[] = [];
const full = { bullish: 0, bearish: 0, neutral: 0 };
const chart = { bullish: 0, bearish: 0, neutral: 0 };
let differ = 0, total = 0;

for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  if ((raw.meta?.assetClass ?? "") !== "equity-etf") continue;
  const symbol = raw.meta?.displaySymbol ?? f.replace(".US.json", "");
  const barsAll: Bar[] = raw.bars ?? [];
  if (barsAll.length === 0) continue;
  const end = barsAll[barsAll.length - 1].t;
  const bars = barsAll.filter((b) => b.t >= end - LOOKBACK_MS);
  if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;

  const base = { symbol, name: symbol, assetClass: "equity" as const, bars, earningsCalendar: null, hasDerivatives: false, now: end };
  const withCtx = buildLiveAnalysis({ ...base, benchmarkCloses: ctx.benchmarkCloses, benchmarkSymbol: ctx.benchmarkSymbol, marketWide: ctx.marketWide });
  const chartOnly = buildLiveAnalysis({ ...base, benchmarkCloses: null, benchmarkSymbol: "SPY", marketWide: [] });
  if (!withCtx.ok || !chartOnly.ok) continue;
  total++;
  const a = withCtx.analysis.bias.verdict, b = chartOnly.analysis.bias.verdict;
  (full as any)[a]++; (chart as any)[b]++;
  if (a !== b) { differ++; rows.push(`${symbol}: published=${a}(${withCtx.analysis.bias.score}) chart-only=${b}(${chartOnly.analysis.bias.score})`); }
}
console.log(`total equities: ${total}`);
console.log(`published engine:  bullish=${full.bullish} bearish=${full.bearish} neutral=${full.neutral}`);
console.log(`chart-only engine: bullish=${chart.bullish} bearish=${chart.bearish} neutral=${chart.neutral}`);
console.log(`verdicts differing: ${differ}`);
console.log(rows.slice(0, 30).join("\n"));
