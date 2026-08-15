import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LabSeries, runHypothesis, HypothesisResult, resolveDependencies } from "../../src/lib/research/signalLab";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";
import { FAMILY } from "./hypotheses";

/**
 * Runs the declared family and corrects across it.
 *
 *   npm run study:signals
 *
 * Writes src/data/signalValidation.json so the verdicts leave the script and
 * can reach the dossier, per the architecture rule that nothing lives only in
 * research code.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "signalValidation.json");

function load(): LabSeries[] {
  const out: LabSeries[] = [];
  for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as {
      bars?: Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }>;
    };
    const bars = (raw.bars ?? []).filter((b) => Number.isFinite(b.close) && b.close > 0);
    if (bars.length < 300) continue;
    out.push({
      symbol: f.split(".")[0],
      t: bars.map((b) => b.t),
      close: bars.map((b) => b.close),
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      volume: bars.map((b) => b.volume),
    });
  }
  return out;
}

function main(): void {
  const series = load();
  console.log(`Signal lab — ${series.length} instruments, ${FAMILY.length} declared hypotheses\n`);

  const results: HypothesisResult[] = FAMILY.map((h) => {
    const r = runHypothesis(series, h);
    console.log(
      `${r.id.padEnd(24)} n=${String(r.n).padStart(4)}  win=${(r.winRate * 100).toFixed(1)}%  ` +
        `LB=${r.assessment.lowerBound === null ? "--" : (r.assessment.lowerBound * 100).toFixed(1) + "%"}  ` +
        `mean=${(r.meanSpread * 100).toFixed(2)}%  med=${(r.medianSpread * 100).toFixed(2)}%  ` +
        `p=${r.pValue.toExponential(1)}  ${r.assessment.verdict}`
    );
    return r;
  });

  const fdr = benjaminiHochberg(results.map((r) => r.pValue), 0.05);
  results.forEach((r, i) => (r.survivesFdr = fdr[i]?.significant ?? false));
  resolveDependencies(results, FAMILY);

  console.log(`\n${"─".repeat(76)}`);
  console.log(`FDR across ${results.length} hypotheses, q = 0.05`);
  for (const r of results) {
    console.log(`  ${r.id.padEnd(24)} ${r.survivesFdr ? "survives" : "does not survive"}`);
  }

  const retired = results.filter((r) => r.retiredBy !== null);
  if (retired.length) {
    console.log(`\nRETIRED by a failed robustness test:`);
    for (const r of retired) {
      console.log(`  ${r.id} — cleared the gate itself, but ${r.retiredBy} did not`);
    }
  }

  const earned = results.filter((r) => r.earnsEdge);
  console.log(`\n${"─".repeat(76)}`);
  console.log(`EARNS EDGE (clears gate AND survives FDR): ${earned.length}`);
  for (const r of earned) console.log(`  ${r.id} — ${r.assessment.sentence}`);

  const detectable = results.filter((r) => r.survivesFdr && r.assessment.verdict !== "edge");
  if (detectable.length) {
    console.log(`\nSignificant but NOT tradeable after costs: ${detectable.map((r) => r.id).join(", ")}`);
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        instruments: series.length,
        familySize: FAMILY.length,
        costPp: FAMILY[0].costPp,
        results: results.map((r) => {
          const h = FAMILY.find((x) => x.id === r.id)!;
          return {
            id: r.id,
            statement: r.statement,
            rationale: h.rationale,
            holdSessions: h.hold,
            killCriteria: h.killCriteria,
            n: r.n,
            winRate: r.winRate,
            meanSpread: r.meanSpread,
            medianSpread: r.medianSpread,
            lowerBound: r.assessment.lowerBound,
            pValue: r.pValue,
            survivesFdr: r.survivesFdr,
            verdict: r.assessment.verdict,
            earnsEdge: r.earnsEdge,
            retiredBy: r.retiredBy,
            sentence: r.assessment.sentence,
          };
        }),
      },
      null,
      2
    )
  );
  console.log(`\n[lab] wrote ${OUT}`);
}

main();
