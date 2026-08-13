import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord } from "./run";
import { buildNullLookup, Occurrence, summarizeOccurrences } from "./metrics";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

/**
 * PER-VOTER ABLATION — each current Edge voter's marginal contribution to
 * the composite, measured by removing it entirely (as if it never
 * reported; the engine's renormalization handles absence by
 * specification) and replaying the full history.
 *
 * Inputs are the leave-one-out replays produced by
 * `npx tsx run.ts --ablate=<id> --out=ablate-<id>.json` — see ablation
 * batches in the session log — plus the baseline results.json. Everything
 * here is measured against the DRIFT NULL, the same standard as every
 * other cell in the census: a voter only "helped" if the composite beat
 * blind exposure MORE with it than without it.
 *
 * Research artifact: writes scripts/backtest/ablationReport.md, changes no
 * production file. The intended consumer is the weight-earning mechanism
 * (redesign §6, "weights stop being constants") — this table is the first
 * measured input a re-derived weight table would use.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

const EDGE_VOTERS = [
  "funding",
  "squeezeRisk",
  "openInterest",
  "basis",
  "longShort",
  "etfFlows",
  "spotPerpVolume",
  "stablecoins",
  "macroLiquidity",
];

interface DirectionalPerf {
  n: number;
  winRate: number | null;
  nullWinRate: number | null;
  edgePP: number | null;
}

interface EnginePerf {
  bullish: DirectionalPerf;
  bearish: DirectionalPerf;
  directionalDays: number;
}

/** The composite's directional performance vs the drift null — biasVerdictSection's question, minimally. */
function perfOf(records: DayRecord[]): EnginePerf {
  const nullFor = buildNullLookup(records, (r) => r.forwardReturn1d);

  const side = (verdict: "bullish" | "bearish"): DirectionalPerf => {
    const occ: Occurrence[] = records
      .filter((r) => r.biasVerdict === verdict && r.forwardReturn1d !== null)
      .map((r) => ({ t: r.t, verdict, forwardReturnPct: r.forwardReturn1d, asset: r.asset }));
    const s = summarizeOccurrences(occ, MIN_SAMPLE_N, nullFor);
    const nullWinRate = (s.significance as { nullWinRate?: number } | null)?.nullWinRate ?? null;
    return {
      n: s.n,
      winRate: s.winRate,
      nullWinRate,
      edgePP: s.winRate !== null && nullWinRate !== null ? (s.winRate - nullWinRate) * 100 : null,
    };
  };

  return {
    bullish: side("bullish"),
    bearish: side("bearish"),
    directionalDays: records.filter((r) => r.biasVerdict === "bullish" || r.biasVerdict === "bearish").length,
  };
}

const f = (x: number | null, d = 1) => (x === null ? "—" : x.toFixed(d));
const pct = (x: number | null) => (x === null ? "—" : `${(100 * x).toFixed(1)}%`);

function main() {
  const baseline: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8"));
  const base = perfOf(baseline);

  const lines: string[] = [];
  const say = (l = "") => {
    lines.push(l);
    console.log(l);
  };

  say("# Per-voter ablation — marginal contribution of each Edge voter");
  say("");
  say(
    "Each row removes ONE voter entirely and replays the full history. Edge is win rate minus the " +
      "drift null, in percentage points; Δedge is (baseline − ablated): POSITIVE means the composite " +
      "was BETTER with the voter present (it contributes), NEGATIVE means the composite improved when " +
      "the voter was removed (it detracts). All in-sample, descriptive, uncorrected for the 9-way scan — " +
      "an input to weight re-derivation, not a verdict on its own."
  );
  say("");
  say(
    `Baseline: bullish n=${base.bullish.n} win ${pct(base.bullish.winRate)} vs null ${pct(base.bullish.nullWinRate)} ` +
      `(edge ${f(base.bullish.edgePP)}pp) · bearish n=${base.bearish.n} win ${pct(base.bearish.winRate)} vs null ` +
      `${pct(base.bearish.nullWinRate)} (edge ${f(base.bearish.edgePP)}pp) · directional days ${base.directionalDays}.`
  );
  say("");
  say("| Removed voter | Bull n | Bull edge (pp) | Δ bull edge | Bear n | Bear edge (pp) | Δ bear edge | Directional days |");
  say("|---|---|---|---|---|---|---|---|");

  for (const id of EDGE_VOTERS) {
    const file = path.join(DATA_DIR, `ablate-${id}.json`);
    if (!fs.existsSync(file)) {
      say(`| ${id} | — | — | — | — | — | — | MISSING RUN |`);
      continue;
    }
    const ablated = perfOf(JSON.parse(fs.readFileSync(file, "utf8")));
    const dBull =
      base.bullish.edgePP !== null && ablated.bullish.edgePP !== null
        ? base.bullish.edgePP - ablated.bullish.edgePP
        : null;
    const dBear =
      base.bearish.edgePP !== null && ablated.bearish.edgePP !== null
        ? base.bearish.edgePP - ablated.bearish.edgePP
        : null;
    say(
      `| ${id} | ${ablated.bullish.n} | ${f(ablated.bullish.edgePP)} | ${dBull === null ? "—" : (dBull >= 0 ? "+" : "") + f(dBull)} | ` +
        `${ablated.bearish.n} | ${f(ablated.bearish.edgePP)} | ${dBear === null ? "—" : (dBear >= 0 ? "+" : "") + f(dBear)} | ${ablated.directionalDays} |`
    );
  }

  say("");
  say(
    "Reading guide: a voter whose removal RAISES the composite's edge on both sides is a candidate " +
      "for weight reduction at the next re-derivation; one whose removal collapses an edge is doing " +
      "real work. Small deltas (<1pp) are noise at these sample sizes — do not rank on them."
  );

  const outPath = path.join(__dirname, "ablationReport.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[ablation] wrote ${outPath}`);
}

main();
