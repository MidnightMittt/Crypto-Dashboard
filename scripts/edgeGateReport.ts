import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assessEdge, EdgeAssessment, EdgeRecord, wilsonLowerBound } from "../src/lib/research/edgeGate";
import { METRIC_ROLES, METRIC_WEIGHTS } from "../src/lib/signals/scoring";
import { benjaminiHochberg } from "../src/lib/research/multipleTesting";

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
 * Judging a 7-day signal on next-day returns measures the wrong thing.
 *
 * The first version of this report could not do that: the artifact carried
 * an effective sample for 24h only, so eight of nine modules came back
 * `unmeasured` and `funding`'s 57.6% at 7d sat unresolved against its 30.3%
 * at 24h, on the engine's largest weight. `byHoldingPeriod` now publishes
 * every horizon with its own block length, and the answer that unlocked is
 * the reason it was worth doing: funding's 33 rows at 7d are worth an
 * EFFECTIVE 2 — seven days of overlap across two correlated assets — so the
 * flattering number was never a signal at all.
 *
 * n_eff is printed beside n for exactly that reason. The gap between them is
 * where the misleading confidence lives.
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
  byHoldingPeriod?: Record<
    string,
    {
      n: number;
      effectiveN: number;
      blockLength: number;
      winRate: number | null;
      baseRate: number | null;
      pValue?: number | null;
    }
  >;
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

/**
 * The module's BEST honest case: whichever horizon gives it the highest
 * Wilson lower bound against its own null.
 *
 * Best-of-four is a multiple-comparison, and picking the flattering horizon
 * after the fact is how a coin flip becomes a strategy. It is deliberate
 * here for one reason: the question this report answers is "does anything
 * survive?", and a module that fails at its most favourable horizon fails
 * everywhere. That inference is safe in the negative direction only — an
 * `EDGE` verdict below is a CANDIDATE, owed the FDR correction across the
 * candidate family before it earns a vote.
 */
function bestRecord(m: MetricSnapshot): EdgeRecord | null {
  const by = m.byHoldingPeriod ?? {};
  let best: EdgeRecord | null = null;
  let bestBound = -Infinity;

  for (const [hp, r] of Object.entries(by)) {
    if (!r || r.winRate === null || r.baseRate === null || r.effectiveN <= 0) continue;
    const bound = wilsonLowerBound(r.winRate, r.effectiveN) - r.baseRate;
    if (bound > bestBound) {
      bestBound = bound;
      best = { winRate: r.winRate, baseRate: r.baseRate, effectiveN: r.effectiveN, holdingPeriod: hp };
    }
  }
  return best;
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
      `${"n".padStart(7)}${"n_eff".padStart(7)}${"win".padStart(8)}${"null".padStart(7)}` +
      `${"LB".padStart(8)}  verdict`
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
    const rec = bestRecord(m);
    const a = assessEdge(rec, COST_PP);
    if (role === "edge") voting.push({ id: m.metricId, a, weight });

    const win = rec ? `${(rec.winRate * 100).toFixed(1)}%` : "--";
    const nul = rec ? `${(rec.baseRate * 100).toFixed(1)}%` : "--";
    const lb = a.lowerBound === null ? "--" : `${(a.lowerBound * 100).toFixed(1)}%`;
    const hp = rec?.holdingPeriod ?? null;
    const raw = hp ? (m.byHoldingPeriod?.[hp]?.n ?? null) : null;
    console.log(
      `${m.metricId.padEnd(17)}${role.padEnd(9)}${(weight || "").toString().padStart(7)}` +
        `${(hp ?? "-").padStart(5)}${(raw ?? "--").toString().padStart(7)}` +
        `${(rec?.effectiveN ?? "--").toString().padStart(7)}` +
        `${win.padStart(8)}${nul.padStart(7)}${lb.padStart(8)}  ${SYMBOL[a.verdict]}`
    );
  }

  /*
   * FDR ACROSS THE WHOLE CANDIDATE FAMILY.
   *
   * Nine modules tested at four horizons each is up to thirty-six looks at
   * the same replay. At q = 0.05 an uncorrected "one of them cleared" is
   * roughly what pure chance hands you, so the single surviving Edge verdict
   * is not evidence until it survives this. Benjamini-Hochberg rather than
   * Bonferroni: these tests are positively dependent (same tape, overlapping
   * horizons), which is exactly the regime BH is built for, and Bonferroni
   * would be so conservative here it could not detect a real edge either.
   *
   * The family is every (module, horizon) cell that produced a p-value —
   * including the ones that failed. Correcting only over the survivors would
   * be the selection this is meant to undo.
   */
  const family: Array<{ id: string; hp: string; p: number }> = [];
  for (const m of metrics) {
    for (const [hp, r] of Object.entries(m.byHoldingPeriod ?? {})) {
      if (r && typeof r.pValue === "number" && Number.isFinite(r.pValue)) {
        family.push({ id: m.metricId, hp, p: r.pValue });
      }
    }
  }
  const fdr = benjaminiHochberg(family.map((f) => f.p), 0.05);
  const survives = new Set(
    family.filter((_, i) => fdr[i]?.significant).map((f) => `${f.id}:${f.hp}`)
  );

  console.log(`\n${"─".repeat(78)}`);
  console.log(`FDR across the candidate family — ${family.length} (module, horizon) tests, q = 0.05`);
  const survivors = family.filter((f) => survives.has(`${f.id}:${f.hp}`));
  console.log(
    `  surviving cells: ${survivors.length}` +
      (survivors.length ? ` — ${survivors.map((s) => `${s.id}@${s.hp}`).join(", ")}` : " — none")
  );

  const cleared = voting.filter((v) => v.a.verdict === "edge");
  const totalWeight = voting.reduce((s, v) => s + v.weight, 0);
  const clearedWeight = cleared.reduce((s, v) => s + v.weight, 0);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`Modules voting as Edge: ${voting.length}`);
  console.log(`  clearing the gate:    ${cleared.length}  (${cleared.map((c) => c.id).join(", ") || "none"})`);
  const clearedAndCorrected = cleared.filter((c) => survives.has(`${c.id}:${c.a.holdingPeriod}`));
  console.log(
    `  ...AND surviving FDR: ${clearedAndCorrected.length}  ` +
      `(${clearedAndCorrected.map((c) => c.id).join(", ") || "none"})`
  );
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
