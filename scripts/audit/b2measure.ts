import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import marketContextJson from "../../src/data/marketContext.json";
import statsJson from "../../src/data/equityExecutionStats.json";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { equityPlanConstraints } from "../../src/lib/dossier/equityExpectations";
import { Bar } from "../../src/lib/research/types";

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const LOOKBACK_MS = 5 * 365 * 24 * 3600 * 1000;
const ctx = marketContextJson as any;
const snapshot = statsJson as any;
const NAMES = ["BTDR","CIFR","MARA","RIOT","IREN","CLSK","CORZ","HUT","WULF","APLD","IONQ","OKLO"];

for (const symbol of NAMES) {
  const f = path.join(DATA_DIR, `${symbol}.US.json`);
  if (!fs.existsSync(f)) { console.log(`${symbol}: no data`); continue; }
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  const barsAll: Bar[] = raw.bars ?? [];
  const end = barsAll[barsAll.length - 1].t;
  const bars = barsAll.filter((b) => b.t >= end - LOOKBACK_MS);
  if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;
  const base = { symbol, name: symbol, assetClass: "equity" as const, bars, earningsCalendar: null, hasDerivatives: false, now: end,
    benchmarkCloses: ctx.benchmarkCloses, benchmarkSymbol: ctx.benchmarkSymbol, marketWide: ctx.marketWide };
  const probe = buildLiveAnalysis(base);
  if (!probe.ok) { console.log(`${symbol}: ${probe.reason.slice(0,60)}`); continue; }
  const side = probe.analysis.bias.verdict === "bullish" ? "long" : probe.analysis.bias.verdict === "bearish" ? "short" : null;
  const constraints = side ? equityPlanConstraints(side, probe.analysis.bias.metrics, snapshot) : null;
  const final = buildLiveAnalysis({ ...base, planConstraints: constraints });
  if (!final.ok) continue;
  const a = final.analysis;
  console.log(
    `${symbol.padEnd(5)} verdict=${a.bias.verdict.padEnd(8)}(${a.bias.score}) side=${side ?? "-"} ` +
    `cell=${constraints?.cellKey ?? "-"} mfeP75=${constraints?.winnersMfeP75Pct?.toFixed(1) ?? "-"} ` +
    `evLower=${constraints?.evLowerPct?.toFixed(2) ?? "-"} refusal=${a.planRefusal ?? "PLAN"}`
  );
}
