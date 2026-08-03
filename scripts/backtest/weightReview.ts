import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { METRIC_WEIGHTS } from "../../src/lib/signals/scoring";
import { CATEGORY_WEIGHTS, CATEGORY_ORDER, CATEGORY_LABELS } from "../../src/lib/signals/categories";
import { SIGNAL_HYPOTHESES } from "../../src/lib/signals/hypothesis";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";
import { summarizeOccurrences, Occurrence, OccurrenceSummary } from "./metrics";

/**
 * Plan Part 5 — the proposal-only weight review. Compares each metric's and
 * category's CURRENT weight (scoring.ts / categories.ts) against how it
 * actually performed in the backtest, and says plainly whether the weight
 * looks too heavy, too light, or unproven for its evidence.
 *
 * PROPOSAL-ONLY, per the explicit decision made before this phase was
 * scoped: this file WRITES TO report.md ONLY. It imports METRIC_WEIGHTS and
 * CATEGORY_WEIGHTS to read them, and touches neither file. A human reads
 * this report and edits scoring.ts/categories.ts by hand if they agree —
 * see the plan doc's own resolved-before-writing note.
 *
 * Reviewed at the 24h holding period specifically: it's the horizon every
 * other section of this report already treats as the headline figure
 * (mean1dPct throughout squeeze/thesis/category/bias sections), so a
 * weight review that used a different horizon than the rest of the report
 * would be comparing against a number nothing else on the page shows.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

export interface WeightReviewDayRecord {
  t: number;
  metrics: Array<{ id: string; verdict: string }>;
  categories: Array<{ category: string; score: number; verdict: string }>;
  forwardReturn1d: number | null;
}

interface RankedItem {
  id: string;
  label: string;
  weight: number;
  weightRank: number; // 1 = heaviest
  stat: OccurrenceSummary;
  performanceRank: number | null; // 1 = best evidence; null when insufficient data
  verdict: "outperforms its weight" | "underperforms its weight" | "matches its weight" | "insufficient data";
}

function metricOccurrences(records: WeightReviewDayRecord[], metricId: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const r of records) {
    const m = r.metrics.find((x) => x.id === metricId);
    if (!m) continue;
    occurrences.push({ t: r.t, verdict: m.verdict as Occurrence["verdict"], forwardReturnPct: r.forwardReturn1d });
  }
  return occurrences;
}

function categoryOccurrences(records: WeightReviewDayRecord[], category: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const r of records) {
    const c = r.categories.find((x) => x.category === category);
    if (!c) continue;
    occurrences.push({ t: r.t, verdict: c.verdict as Occurrence["verdict"], forwardReturnPct: r.forwardReturn1d });
  }
  return occurrences;
}

/**
 * Ranks items by weight (heaviest first) and, separately, by backtested
 * evidence quality (significant results first, then win rate descending —
 * the same rule combinations.ts uses to rank patterns). Then compares the
 * two ranks: a metric ranked much better on evidence than on weight is
 * "outperforming its weight" (the backtest thinks it deserves more say than
 * it currently gets), and vice versa. Comparing RANKS rather than raw
 * numbers avoids inventing a magnitude threshold for "how much better
 * counts" — ranks are already scale-free.
 */
function buildRanked(items: Array<{ id: string; label: string; weight: number; occurrences: Occurrence[] }>): RankedItem[] {
  const withStats = items.map((it) => ({ ...it, stat: summarizeOccurrences(it.occurrences, MIN_SAMPLE_N) }));

  const weightRanked = [...withStats].sort((a, b) => b.weight - a.weight);
  const weightRank = new Map(weightRanked.map((it, i) => [it.id, i + 1]));

  const withEvidence = withStats.filter((it) => it.stat.n >= MIN_SAMPLE_N && it.stat.winRate !== null);
  const performanceRanked = [...withEvidence].sort((a, b) => {
    const aSig = a.stat.significance?.significant ? 1 : 0;
    const bSig = b.stat.significance?.significant ? 1 : 0;
    if (aSig !== bSig) return bSig - aSig;
    return (b.stat.winRate ?? 0) - (a.stat.winRate ?? 0);
  });
  const performanceRank = new Map(performanceRanked.map((it, i) => [it.id, i + 1]));

  return withStats.map((it) => {
    const wRank = weightRank.get(it.id)!;
    const pRank = performanceRank.get(it.id) ?? null;
    let verdict: RankedItem["verdict"];
    if (pRank === null) verdict = "insufficient data";
    else if (pRank < wRank) verdict = "outperforms its weight";
    else if (pRank > wRank) verdict = "underperforms its weight";
    else verdict = "matches its weight";
    return { id: it.id, label: it.label, weight: it.weight, weightRank: wRank, stat: it.stat, performanceRank: pRank, verdict };
  });
}

function renderTable(ranked: RankedItem[]): string {
  const rows: string[] = [
    "| | Weight | Weight rank | N (24h) | Win rate | Significant | Evidence rank | Verdict |",
    "|---|---|---|---|---|---|---|---|",
  ];
  // Sort for readability: heaviest weight first, matching scoring.ts's own listed order intent.
  for (const it of [...ranked].sort((a, b) => a.weightRank - b.weightRank)) {
    const winRateStr = it.stat.winRate === null ? "—" : `${(it.stat.winRate * 100).toFixed(0)}%`;
    const significantStr = it.stat.significance ? (it.stat.significance.significant ? "yes" : "no") : "—";
    rows.push(
      `| ${it.label} | ${it.weight} | ${it.weightRank} | ${it.stat.n} | ${winRateStr} | ${significantStr} | ${it.performanceRank ?? "—"} | ${it.verdict} |`
    );
  }
  return rows.join("\n");
}

export function buildWeightReview(records: WeightReviewDayRecord[]): { markdown: string } {
  const metricItems = Object.entries(METRIC_WEIGHTS).map(([id, weight]) => ({
    id,
    label: SIGNAL_HYPOTHESES.find((h) => h.id === id)?.label ?? id,
    weight,
    occurrences: metricOccurrences(records, id),
  }));
  const metricRanked = buildRanked(metricItems);

  const categoryItems = CATEGORY_ORDER.map((category) => ({
    id: category,
    label: CATEGORY_LABELS[category],
    weight: CATEGORY_WEIGHTS[category],
    occurrences: categoryOccurrences(records, category),
  }));
  const categoryRanked = buildRanked(categoryItems);

  const markdown = `PROPOSAL ONLY — nothing here writes to scoring.ts or categories.ts. Weight and
evidence rank are compared at the 24h holding period, the same horizon every other section of
this report treats as its headline figure. "Outperforms its weight" means the backtest ranks this
item's evidence better than its current weight rank; "underperforms its weight" means the
opposite; "insufficient data" means N < ${MIN_SAMPLE_N} at 24h, so no comparison is made at all.

### Metrics (current METRIC_WEIGHTS in src/lib/signals/scoring.ts)

${renderTable(metricRanked)}

### Categories (current CATEGORY_WEIGHTS in src/lib/signals/categories.ts)

${renderTable(categoryRanked)}
`;

  return { markdown };
}

/** Standalone entry point, for iterating on this file without re-running report.ts's other sections. */
function main() {
  const resultsPath = path.join(DATA_DIR, "results.json");
  if (!fs.existsSync(resultsPath)) {
    console.error(`Missing ${resultsPath} — run "npm run backtest" first.`);
    process.exit(1);
  }
  const records: WeightReviewDayRecord[] = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const { markdown } = buildWeightReview(records);
  console.log(`## Weight Review (proposal only)\n\n${markdown}`);
}

if (process.argv[1] && process.argv[1].endsWith("weightReview.ts")) {
  main();
}
