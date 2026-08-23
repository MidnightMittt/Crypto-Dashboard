import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CURRENT_VERDICT_ENGINE,
  ForwardVerdictRecord,
  MIN_VERDICT_N,
  resolveVerdicts,
  summariseVerdicts,
} from "../../src/lib/research/forwardVerdict";

/**
 * THE 08-27 DRY RUN — what the scoring will actually print, run before the
 * date instead of discovered on it. Read-only: resolves against the bars on
 * disk exactly as the nightly job would, writes nothing.
 */
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const RECORD = path.join(__dirname_, "..", "..", "src", "data", "forwardVerdictRecord.json");

const record = JSON.parse(fs.readFileSync(RECORD, "utf8")) as ForwardVerdictRecord;

const bars = new Map<string, Array<{ t: number; close: number }>>();
for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  const symbol = raw.meta?.displaySymbol ?? f.replace(".US.json", "");
  bars.set(symbol, (raw.bars ?? []).map((b: { t: number; close: number }) => ({ t: b.t, close: b.close })));
}
const closesAfter = (symbol: string, dateIso: string) => {
  const b = bars.get(symbol);
  if (!b) return [];
  const c = Date.parse(`${dateIso}T23:59:59Z`);
  return b.filter((x) => x.t > c);
};

const entryCloseOf = (symbol: string, dateIso: string): number | null => {
  const b = bars.get(symbol);
  const bar = b?.find((x) => new Date(x.t).toISOString().slice(0, 10) === dateIso);
  return bar && bar.close > 0 ? bar.close : null;
};
const resolved = resolveVerdicts(record.predictions, closesAfter, entryCloseOf);

// The symbols-left-the-panel case: predictions that can NEVER resolve.
const orphans = resolved.filter((p) => p.forwardReturnPct === null && !bars.has(p.symbol));
const orphanSymbols = [...new Set(orphans.map((p) => p.symbol))];

const dist = new Map<string, number>();
for (const p of resolved) dist.set(p.verdict, (dist.get(p.verdict) ?? 0) + 1);

console.log(`record on disk: ${record.predictions.length} predictions, engine field: ${record.engine ?? "absent (pre-engine format)"}`);
console.log(`verdict distribution (whole cohort): ${JSON.stringify([...dist.entries()])}`);
console.log(`predictions that can NEVER resolve (symbol not in data dir): ${orphans.length} across ${orphanSymbols.length} symbols: ${orphanSymbols.slice(0, 12).join(" ")}`);
console.log("");

for (const engine of [1, CURRENT_VERDICT_ENGINE]) {
  const s = summariseVerdicts(resolved, engine);
  console.log(`── engine ${engine} ── resolved=${s.totals.resolved} open=${s.totals.open} baseline=${s.baselineReturnPct === null ? "null" : s.baselineReturnPct.toFixed(3) + "%"}`);
  if (s.cells.length === 0) console.log(`   cells: NONE published (MIN_VERDICT_N=${MIN_VERDICT_N} per verdict)`);
  for (const c of s.cells) {
    console.log(
      `   ${c.verdict.padEnd(8)} n=${c.n} hit=${c.hitRatePct === null ? "n/a" : c.hitRatePct.toFixed(1) + "%"} ` +
      `mean=${c.meanReturnPct.toFixed(2)}% median=${c.medianReturnPct.toFixed(2)}% ` +
      `edgeVsBaseline=${c.edgeVsBaselinePct === null ? "n/a" : c.edgeVsBaselinePct.toFixed(2) + "%"}`
    );
  }
  // Sub-threshold groups — what MIN_VERDICT_N is holding back.
  const mine = resolved.filter((p) => (p.engine ?? 1) === engine && p.forwardReturnPct !== null);
  const groups = new Map<string, number>();
  for (const p of mine) groups.set(p.verdict, (groups.get(p.verdict) ?? 0) + 1);
  console.log(`   resolved-by-verdict (incl. sub-threshold): ${JSON.stringify([...groups.entries()])}`);
}
