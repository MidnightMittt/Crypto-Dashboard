import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runHypothesis, HypothesisResult, resolveDependencies, excludeCorruptSeries } from "../../src/lib/research/signalLab";
import { describeLoad, loadEquityPanel, loadOne } from "./loadPanel";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";
import { BENCHMARK_SYMBOL, benchmarkDecomposition } from "../../src/lib/research/benchmark";
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
const OUT = path.join(__dirname_, "..", "..", "src", "data", "signalValidation.json");


function main(): void {
  const load = loadEquityPanel();
  const { clean: series, excluded } = excludeCorruptSeries(load.series);
  console.log(`Signal lab — ${describeLoad(load)}`);
  console.log(`${series.length} usable after integrity exclusions, ${FAMILY.length} declared hypotheses`);
  if (excluded.length) {
    console.log(
      `Excluded ${excluded.length} for impossible sessions (corporate-action artifacts):\n  ` +
        excluded
          .sort((a, b) => b.worstMovePct - a.worstMovePct)
          .map((e) => `${e.symbol} ${e.worstMovePct.toFixed(0)}% on ${e.date}`)
          .join("\n  ")
    );
  }
  console.log();

  const results: HypothesisResult[] = FAMILY.map((h) => {
    const r = runHypothesis(series, h);
    console.log(
      `${r.id.padEnd(24)} n=${String(r.n).padStart(4)}  win=${(r.winRate * 100).toFixed(1)}%  ` +
        `LB=${r.assessment.lowerBound === null ? "--" : (r.assessment.lowerBound * 100).toFixed(1) + "%"}  ` +
        `mean=${(r.meanSpread * 100).toFixed(2)}%  med=${(r.medianSpread * 100).toFixed(2)}%  ` +
        `worst=${(r.worstSpread * 100).toFixed(1)}%  p05=${(r.p05Spread * 100).toFixed(2)}%  ` +
        `p=${r.pValue.toExponential(1)}  ${r.assessment.verdict}`
    );
    return r;
  });

  /*
   * THE BENCHMARK CONTROL.
   *
   * Only long-only hypotheses get it. A dollar-neutral long-short spread has
   * roughly no market exposure by construction, so "spread minus QQQ" is not
   * a question anyone asks and publishing it would be a number in search of a
   * meaning.
   */
  const bench = loadOne(BENCHMARK_SYMBOL);
  if (!bench) {
    console.log(`\n[benchmark] ${BENCHMARK_SYMBOL} not in the ingest — no decomposition this run.`);
  }
  const decompositions = new Map<string, ReturnType<typeof benchmarkDecomposition>>();
  if (bench) {
    console.log(`\n${"─".repeat(76)}`);
    console.log(`DECOMPOSITION vs ${BENCHMARK_SYMBOL}, long-only hypotheses only`);
    for (const r of results) {
      const h = FAMILY.find((x) => x.id === r.id)!;
      if ((h.leg ?? "long-short") !== "long-vs-panel") continue;
      const d = benchmarkDecomposition(r.periods, bench);
      decompositions.set(r.id, d);
      if (!d) {
        console.log(`  ${r.id.padEnd(34)} refused — benchmark covers too few periods`);
        continue;
      }
      const c = d.decomposition;
      console.log(`  ${r.id}  (n=${c.signalMinusIndex.n})`);
      for (const col of [c.signalMinusUniverse, c.universeMinusIndex, c.signalMinusIndex]) {
        console.log(
          `      ${col.label.padEnd(20)} ${col.meanPct >= 0 ? "+" : ""}${col.meanPct.toFixed(3)}%  ` +
            `t=${col.t.toFixed(2).padStart(6)}   detectable at t=3: ${col.detectablePctAtT3.toFixed(3)}%`
        );
      }
    }
  }

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
            /*
             * WHAT THE SPREAD NUMBERS DESCRIBE. Without this a consumer
             * cannot tell whether `meanSpread` belongs to a four-legged
             * portfolio or to a single long position, and those two readings
             * differ by more than any statistic in the file.
             */
            leg: h.leg ?? "long-short",
            holdSessions: h.hold,
            killCriteria: h.killCriteria,
            n: r.n,
            winRate: r.winRate,
            meanSpread: r.meanSpread,
            medianSpread: r.medianSpread,
            worstSpread: r.worstSpread,
            p05Spread: r.p05Spread,
            p95Spread: r.p95Spread,
            periodsGatedOut: r.periodsGatedOut,
            lowerBound: r.assessment.lowerBound,
            pValue: r.pValue,
            survivesFdr: r.survivesFdr,
            verdict: r.assessment.verdict,
            earnsEdge: r.earnsEdge,
            retiredBy: r.retiredBy,
            sentence: r.assessment.sentence,
            /*
             * Null on long-short by design, not by omission — see the
             * decomposition block above. The page must render the absence as
             * "does not apply" rather than as missing data.
             */
            decomposition: decompositions.get(r.id) ?? null,
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
