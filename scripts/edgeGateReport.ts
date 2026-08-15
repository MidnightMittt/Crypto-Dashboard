import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assessEdge, EdgeAssessment, EdgeRecord } from "../src/lib/research/edgeGate";
import { METRIC_ROLES, METRIC_WEIGHTS } from "../src/lib/signals/scoring";

/**
 * APPLIES THE ROADMAP'S OWN EDGE GATE TO THE MODULES THAT ARE SHIPPING.
 *
 * Standing rule 1 says a signal ships as Edge only if its Wilson lower bound
 * clears the null, and that failures ship too as published negative results.
 * Nothing had ever run that gate against the modules already voting, so the
 * Edge roster was inherited rather than earned — scoring.ts says as much:
 * "re-earning weights from measured performance is a later step".
 *
 * This is that measurement, reproducible on demand:
 *
 *   npm run edge-gate
 *
 * It CHANGES NOTHING. It reads the committed backtest artifact and prints
 * what the gate says. Re-weighting the composite on the strength of one
 * artifact read would be the same error the gate exists to catch, and is a
 * decision for a human with the numbers in front of them.
 *
 * ── Reading the output ────────────────────────────────────────────────
 *
 * Each module is judged at ITS OWN best holding period, not a fixed 24h.
 * Judging a 7-day signal on next-day returns measures the wrong thing, and
 * `funding` is exactly that case: 30% at 24h, 58% at 7d.
 *
 * The honest limit, stated because it bounds every 7d verdict below: the
 * artifact carries an effective sample for the 24h horizon only. Where a
 * module's best period is not 24h, the gate reports `unmeasured` rather than
 * borrowing the 24h effective n — a different horizon has a different
 * overlap structure, and reusing the number would manufacture a verdict.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(__dirname, "..", "src", "data", "backtestMetricStats.json");

interface MetricSnapshot {
  metricId: string;
  label: string;
  n24h?: number;
  effectiveN24h?: number;
  baseRate24h?: number;
  winRate24h?: number;
  winRate7d?: number;
  bestHoldingPeriod?: { holdingPeriod: string; winRate: number } | null;
  stableAcrossWindows?: boolean | null;
  sampleSizeLabel?: string;
}

/**
 * Round-trip costs in percentage points of win rate the signal must clear on
 * top of the null. Deliberately conservative and deliberately visible: at
 * zero, a 50.4% signal reads as an edge, and no one can trade a 50.4% signal.
 */
const COST_PP = 2;

function toRecord(m: MetricSnapshot): EdgeRecord | null {
  const best = m.bestHoldingPeriod?.holdingPeriod ?? "24h";
  if (m.winRate24h === undefined || m.baseRate24h === undefined) return null;

  // See the header: only the 24h horizon has an overlap-corrected sample.
  if (best !== "24h") {
    return {
      winRate: m.bestHoldingPeriod?.winRate ?? m.winRate24h,
      baseRate: m.baseRate24h,
      effectiveN: null,
      holdingPeriod: best,
    };
  }
  return {
    winRate: m.winRate24h,
    baseRate: m.baseRate24h,
    effectiveN: m.effectiveN24h ?? null,
    holdingPeriod: "24h",
  };
}

const SYMBOL: Record<EdgeAssessment["verdict"], string> = {
  edge: "EDGE",
  "not-distinguishable": "coin flip",
  "below-base-rate": "below null",
  unmeasured: "unmeasured",
};

function main(): void {
  const raw = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")) as {
    coverageStart: string;
    coverageEnd: string;
    metrics: MetricSnapshot[] | Record<string, MetricSnapshot>;
  };
  const metrics = Array.isArray(raw.metrics) ? raw.metrics : Object.values(raw.metrics);

  console.log(`Edge gate — coverage ${raw.coverageStart} to ${raw.coverageEnd}, costs ${COST_PP}pp\n`);
  console.log(
    `${"module".padEnd(17)}${"role".padEnd(9)}${"weight".padStart(7)}${"HP".padStart(5)}` +
      `${"win".padStart(8)}${"null".padStart(7)}${"LB".padStart(8)}  verdict`
  );
  console.log("-".repeat(78));

  const voting: Array<{ id: string; a: EdgeAssessment; weight: number }> = [];

  for (const m of [...metrics].sort((a, b) => {
    const ra = METRIC_ROLES[a.metricId] ?? "zz";
    const rb = METRIC_ROLES[b.metricId] ?? "zz";
    return ra === rb ? a.metricId.localeCompare(b.metricId) : ra.localeCompare(rb);
  })) {
    const role = METRIC_ROLES[m.metricId] ?? "?";
    const weight = METRIC_WEIGHTS[m.metricId] ?? 0;
    const rec = toRecord(m);
    const a = assessEdge(rec, COST_PP);
    if (role === "edge") voting.push({ id: m.metricId, a, weight });

    const win = rec ? `${(rec.winRate * 100).toFixed(1)}%` : "--";
    const nul = rec ? `${(rec.baseRate * 100).toFixed(1)}%` : "--";
    const lb = a.lowerBound === null ? "--" : `${(a.lowerBound * 100).toFixed(1)}%`;
    console.log(
      `${m.metricId.padEnd(17)}${role.padEnd(9)}${(weight || "").toString().padStart(7)}` +
        `${(rec?.holdingPeriod ?? "-").padStart(5)}${win.padStart(8)}${nul.padStart(7)}` +
        `${lb.padStart(8)}  ${SYMBOL[a.verdict]}`
    );
  }

  const cleared = voting.filter((v) => v.a.verdict === "edge");
  const totalWeight = voting.reduce((s, v) => s + v.weight, 0);
  const clearedWeight = cleared.reduce((s, v) => s + v.weight, 0);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`Modules voting as Edge: ${voting.length}`);
  console.log(`  clearing the gate:    ${cleared.length}  (${cleared.map((c) => c.id).join(", ") || "none"})`);
  console.log(
    `  share of voting weight that clears: ` +
      `${totalWeight > 0 ? ((clearedWeight / totalWeight) * 100).toFixed(0) : "0"}%`
  );
  console.log(
    `\nThis report changes nothing. It is the evidence for a re-weighting\n` +
      `decision, not the decision.`
  );
}

main();
