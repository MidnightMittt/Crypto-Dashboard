import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Bar, InstrumentMeta } from "../../src/lib/research/types";
import { UNIVERSE } from "../../src/lib/research/universe";
import { sessionPeriodKey } from "../../src/lib/research/session";
import { analyzePanel } from "../../src/lib/research/panelStatistics";
import { PanelObservation } from "../../src/lib/research/panelBootstrap";
import { detectableDifference } from "../../src/lib/research/panelStatistics";

/**
 * UNIVERSE POWER REPORT — does each asset class actually add information?
 *
 * The brief's instruction is the whole point of this script: "Do not assume
 * the new assets improve research. Measure it." Instrument count is not the
 * objective; effective sample size is, and the two diverge sharply once
 * correlation is accounted for.
 *
 * Run: npx tsx scripts/ingest/universePower.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HORIZON = 5;

interface Loaded {
  meta: InstrumentMeta;
  bars: Bar[];
}

function load(): Loaded[] {
  const out: Loaded[] = [];
  for (const c of UNIVERSE) {
    const f = path.join(DATA_DIR, `${c.meta.id}.json`);
    if (!fs.existsSync(f)) continue;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as { bars: Bar[] };
    out.push({ meta: c.meta, bars: parsed.bars });
  }
  return out;
}

/** Daily log-ish returns keyed by session, so correlation is computed on aligned observations. */
function returnsBySession(l: Loaded, from: number): Map<number, number> {
  const m = new Map<number, number>();
  const bars = l.bars.filter((b) => b.t >= from);
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].close <= 0) continue;
    m.set(sessionPeriodKey(bars[i].t, l.meta.sessionModel), (bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  }
  return m;
}

function correlation(a: Map<number, number>, b: Map<number, number>): number | null {
  const keys = [...a.keys()].filter((k) => b.has(k));
  if (keys.length < 100) return null;
  const xs = keys.map((k) => a.get(k)!);
  const ys = keys.map((k) => b.get(k)!);
  const mx = xs.reduce((p, q) => p + q, 0) / xs.length;
  const my = ys.reduce((p, q) => p + q, 0) / ys.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
}

const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  say("# Universe Power Report");
  say("");
  say("Measures whether each asset class adds INDEPENDENT information, rather than assuming it. Instrument count is not the objective; effective sample size is.");
  say("");

  const loaded = load();
  // Common window: every measurement uses the same start so class
  // comparisons are not confounded by differing history lengths.
  const START = Date.UTC(2008, 0, 1);
  const returns = new Map(loaded.map((l) => [l.meta.id, returnsBySession(l, START)]));

  say("## Ingested and validated");
  say("");
  say("| Class | Instruments |");
  say("|---|---|");
  const byClass = new Map<string, Loaded[]>();
  for (const l of loaded) {
    const k = l.meta.assetClass;
    byClass.set(k, [...(byClass.get(k) ?? []), l]);
  }
  for (const [k, v] of [...byClass.entries()].sort()) {
    say(`| ${k} | ${v.map((x) => x.meta.displaySymbol).join(", ")} |`);
  }
  say("");
  const missing = UNIVERSE.filter((c) => !loaded.some((l) => l.meta.id === c.meta.id));
  if (missing.length > 0) {
    say(`**Not ingested (${missing.length}):** ${missing.map((c) => c.meta.id).join(", ")} — see the rejection note in the phase report.`);
    say("");
  }

  // ── Pairwise correlation, within and across class ─────────────────────
  say("## Mean pairwise correlation");
  say("");
  const classes = [...byClass.keys()].sort();
  say("| | " + classes.join(" | ") + " |");
  say("|---|" + classes.map(() => "---").join("|") + "|");
  const crossClass = new Map<string, number>();
  for (const a of classes) {
    const row: string[] = [];
    for (const b of classes) {
      const rs: number[] = [];
      for (const x of byClass.get(a)!) {
        for (const y of byClass.get(b)!) {
          if (x.meta.id === y.meta.id) continue;
          const r = correlation(returns.get(x.meta.id)!, returns.get(y.meta.id)!);
          if (r !== null) rs.push(r);
        }
      }
      const mean = rs.length > 0 ? rs.reduce((p, q) => p + q, 0) / rs.length : NaN;
      crossClass.set(`${a}|${b}`, mean);
      row.push(Number.isNaN(mean) ? "—" : f2(mean));
    }
    say(`| **${a}** | ${row.join(" | ")} |`);
  }
  say("");

  // ── Cumulative effective sample size ──────────────────────────────────
  say("## Cumulative effective sample size, by tier");
  say("");
  say("Each tier ADDS to the previous. The question at every step is not how many instruments were added but how much independent information they carried.");
  say("");

  const tiers: Array<{ name: string; ids: string[] }> = [];
  const pick = (cls: string) => (byClass.get(cls) ?? []).map((l) => l.meta.id);
  const indices = pick("equity-etf");
  const bonds = pick("bond");
  const commodities = pick("commodity");
  const crypto = pick("crypto");

  tiers.push({ name: "Crypto only (prior baseline)", ids: crypto });
  tiers.push({ name: "+ US equity indices", ids: [...crypto, ...indices] });
  tiers.push({ name: "+ Treasuries & credit", ids: [...crypto, ...indices, ...bonds] });
  tiers.push({ name: "+ Commodities (full universe)", ids: [...crypto, ...indices, ...bonds, ...commodities] });

  say("| Tier | Instruments | Raw n | Sessions | Effective N | n_eff/n | Detectable effect | vs baseline |");
  say("|---|---|---|---|---|---|---|---|");

  let baselineEff = 0;
  let baselineDet = 0;
  for (const tier of tiers) {
    const obs: PanelObservation[] = [];
    for (const id of tier.ids) {
      const l = loaded.find((x) => x.meta.id === id)!;
      const bars = l.bars.filter((b) => b.t >= START);
      for (let i = 0; i + HORIZON < bars.length; i++) {
        obs.push({
          period: sessionPeriodKey(bars[i].t, l.meta.sessionModel),
          unitId: id,
          value: ((bars[i + HORIZON].close - bars[i].close) / bars[i].close) * 100,
        });
      }
    }
    const est = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, HORIZON, 1500, 7);
    if (!est) continue;
    const det = detectableDifference(est.standardError);
    if (baselineEff === 0) { baselineEff = est.effectiveN; baselineDet = det; }
    say(`| ${tier.name} | ${tier.ids.length} | ${est.n} | ${est.periods} | ${f2(est.effectiveN)} | ` +
        `${f3(est.effectiveN / est.n)} | ${f3(det)}% | ${f2(est.effectiveN / baselineEff)}x |`);
  }
  say("");

  // ── Marginal contribution of each class ───────────────────────────────
  say("## Marginal contribution of each class");
  say("");
  say("Effective N of the full universe, minus the effective N with that class REMOVED. This is the honest measure of what a class is worth: what is lost by deleting it.");
  say("");
  const allIds = [...crypto, ...indices, ...bonds, ...commodities];
  const effOf = (ids: string[]) => {
    const obs: PanelObservation[] = [];
    for (const id of ids) {
      const l = loaded.find((x) => x.meta.id === id)!;
      const bars = l.bars.filter((b) => b.t >= START);
      for (let i = 0; i + HORIZON < bars.length; i++) {
        obs.push({
          period: sessionPeriodKey(bars[i].t, l.meta.sessionModel),
          unitId: id,
          value: ((bars[i + HORIZON].close - bars[i].close) / bars[i].close) * 100,
        });
      }
    }
    return analyzePanel(obs, { statistic: "mean", nullValue: 0 }, HORIZON, 1500, 7)?.effectiveN ?? 0;
  };
  const full = effOf(allIds);
  say("| Class removed | Instruments dropped | Effective N without it | Information lost |");
  say("|---|---|---|---|");
  for (const [name, ids] of [["Crypto", crypto], ["Equity indices", indices], ["Bonds & credit", bonds], ["Commodities", commodities]] as const) {
    const without = effOf(allIds.filter((id) => !ids.includes(id)));
    say(`| ${name} | ${ids.length} | ${f2(without)} | **${f2(full - without)}** (${f2((100 * (full - without)) / full)}%) |`);
  }
  say("");
  say(`Full-universe effective N: **${f2(full)}**.`);

  const out = path.join(__dirname, "..", "..", "docs", "UNIVERSE_POWER.md");
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`\n[power] wrote ${out}`);
}

main();
