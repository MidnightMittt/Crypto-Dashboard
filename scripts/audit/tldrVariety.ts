import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import marketContextJson from "../../src/data/marketContext.json";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { composeTldr } from "../../src/lib/dossier/narrative";
import { Bar } from "../../src/lib/research/types";

/**
 * HOW MANY DIFFERENT THINGS CAN THE TEN-SECOND READ ACTUALLY SAY?
 *
 * A distinct-string count says 101 of 101 and is the wrong test: it counts
 * "STX falls 6.50%" and "MU falls 21.40%" as two different sentences when a
 * reader sees one sentence twice. The right unit is the SKELETON — the
 * sentence with every number, symbol and metric label removed. That is what
 * a human actually compares.
 *
 * Reported per clause, because the fix depends on WHICH clause is the
 * template. A clause with two possible skeletons is a coin flip wearing
 * prose; a clause with sixty is doing real work.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const LOOKBACK_MS = 5 * 365 * 24 * 3600 * 1000;
const ctx = marketContextJson as never as { benchmarkCloses: Array<{ t: number; close: number }>; benchmarkSymbol: string; marketWide: [] };

/** Strip everything symbol-specific, leaving the sentence a reader compares. */
function skeleton(s: string | null): string {
  if (!s) return "(none)";
  return s
    .replace(/\b[A-Z]{1,6}\d*\b/g, "SYM")
    .replace(/-?\$?\d[\d,]*\.?\d*%?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

const clauses = ["state", "support", "tension", "options", "invalidation", "full"] as const;
const seen: Record<string, Map<string, number>> = Object.fromEntries(
  clauses.map((c) => [c, new Map<string, number>()])
);
let n = 0;

for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  if ((raw.meta?.assetClass ?? "") !== "equity-etf") continue;
  const symbol = raw.meta?.displaySymbol ?? f.replace(".US.json", "");
  const all: Bar[] = raw.bars ?? [];
  if (all.length === 0) continue;
  const end = all[all.length - 1].t;
  const bars = all.filter((b) => b.t >= end - LOOKBACK_MS);
  if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;

  const res = buildLiveAnalysis({
    symbol, name: symbol, assetClass: "equity", bars,
    benchmarkCloses: ctx.benchmarkCloses, benchmarkSymbol: ctx.benchmarkSymbol,
    marketWide: [], earningsCalendar: null, hasDerivatives: false, now: end,
  });
  if (!res.ok) continue;
  const t = composeTldr({
    bias: res.analysis.bias, plan: res.analysis.plan, symbol, name: symbol,
  });
  n++;
  for (const c of clauses) {
    const k = skeleton(t[c]);
    seen[c].set(k, (seen[c].get(k) ?? 0) + 1);
  }
}

console.log(`tickers measured: ${n}\n`);
console.log("clause          distinct skeletons   largest shared group   share on the top 2");
for (const c of clauses) {
  const m = [...seen[c].entries()].sort((a, b) => b[1] - a[1]);
  const top2 = (m[0]?.[1] ?? 0) + (m[1]?.[1] ?? 0);
  console.log(
    `${c.padEnd(15)} ${String(m.length).padStart(8)}   ${String(m[0]?.[1] ?? 0).padStart(18)}   ${((top2 / n) * 100).toFixed(0).padStart(15)}%`
  );
}

for (const c of clauses) {
  const m = [...seen[c].entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n── ${c}: top skeletons ──`);
  for (const [k, count] of m.slice(0, 3)) {
    console.log(`  x${String(count).padStart(3)}  ${k.slice(0, 150)}`);
  }
}
