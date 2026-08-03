import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../../src/lib/signals/categories";
import { Category } from "../../src/lib/signals/types";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";
import { summarizeOccurrences, Occurrence, OccurrenceSummary } from "./metrics";
import { HOLDING_PERIODS, HoldingPeriod } from "../../src/lib/signals/hypothesis";

/**
 * Category-level combination testing (plan Part 4): rather than asking
 * "does Liquidity alone predict anything," ask "does the SPECIFIC pattern
 * of which categories are bullish today predict anything" — 32 patterns,
 * one per subset of {liquidity, momentum, derivatives, onchain, sentiment}
 * (2^5), each meaning "exactly these categories read bullish, the rest did
 * not." Metric-level combination testing (15 metrics -> tens of thousands
 * of patterns) was explicitly ruled out when this phase was scoped: with a
 * ~125-day-per-asset window, almost every metric-level bucket would land
 * under MIN_SAMPLE_N, which is not honest statistics. Category-level still
 * rests on real N because there are only 32 patterns to spread ~250
 * evaluated days across.
 *
 * A RESEARCH ARTIFACT ONLY — not read by any live recommendation. Exported
 * for report.ts to fold into the SAME report.md / backtestStats.json every
 * other section writes to, rather than a separate file report.ts's reader
 * would have to know to also open. Also runnable standalone (`npx tsx
 * scripts/backtest/combinations.ts`) for iterating on this file alone.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

export interface CombinationDayRecord {
  t: number;
  categories: Array<{ category: string; score: number; verdict: string }>;
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn1d: number | null;
  forwardReturn7d: number | null;
}

export interface CombinationResult {
  subset: Category[];
  label: string;
  holdingPeriod: HoldingPeriod;
  stat: OccurrenceSummary;
}

function holdingPeriodField(hp: HoldingPeriod): "forwardReturn1h" | "forwardReturn4h" | "forwardReturn1d" | "forwardReturn7d" {
  switch (hp) {
    case "1h":
      return "forwardReturn1h";
    case "4h":
      return "forwardReturn4h";
    case "24h":
      return "forwardReturn1d";
    case "7d":
      return "forwardReturn7d";
  }
}

/** All 32 subsets of the 5 categories, as bitmasks over CATEGORY_ORDER's own index order. */
function allSubsets(): Category[][] {
  const subsets: Category[][] = [];
  for (let mask = 0; mask < 1 << CATEGORY_ORDER.length; mask++) {
    subsets.push(CATEGORY_ORDER.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets;
}

function subsetLabel(subset: Category[]): string {
  if (subset.length === 0) return "None bullish";
  if (subset.length === CATEGORY_ORDER.length) return "All bullish";
  return subset.map((c) => CATEGORY_LABELS[c]).join(" + ") + " bullish";
}

/**
 * This day's own pattern: which categories read bullish. Bearish and
 * neutral are deliberately collapsed into "not bullish" — the same
 * presence/absence simplification that keeps 32 patterns tractable instead
 * of 3^5=243, which was the whole reason category-level (not metric-level)
 * combinations were in scope for this pass.
 */
function bullishSetFor(record: CombinationDayRecord): Set<string> {
  return new Set(record.categories.filter((c) => c.verdict === "bullish").map((c) => c.category));
}

function setsEqual(a: Set<string>, b: string[]): boolean {
  if (a.size !== b.length) return false;
  return b.every((x) => a.has(x));
}

/**
 * Every day is scored against every subset: verdict is "bullish" if that
 * day's own bullish pattern exactly matches the subset (a bet that this
 * exact pattern predicts a price rise), "neutral" otherwise (excluded from
 * winRate/mean/median/drawdown, but still counted in the confusion
 * matrix's denominator — a day that matched a DIFFERENT pattern while price
 * still rose is a real false negative for this one).
 */
function testCombination(records: CombinationDayRecord[], subset: Category[], hp: HoldingPeriod): OccurrenceSummary {
  const field = holdingPeriodField(hp);
  const subsetKeys = subset as string[];
  const occurrences: Occurrence[] = records.map((r) => ({
    t: r.t,
    verdict: setsEqual(bullishSetFor(r), subsetKeys) ? "bullish" : "neutral",
    forwardReturnPct: r[field],
  }));
  return summarizeOccurrences(occurrences, MIN_SAMPLE_N);
}

export function buildCombinations(records: CombinationDayRecord[]): { markdown: string; results: CombinationResult[] } {
  const results: CombinationResult[] = [];
  for (const subset of allSubsets()) {
    for (const hp of HOLDING_PERIODS) {
      results.push({ subset, label: subsetLabel(subset), holdingPeriod: hp, stat: testCombination(records, subset, hp) });
    }
  }

  // Ranked: statistically significant first, then by win rate — a "real
  // edge, however small" is ranked above a large but unsignificant win rate
  // from a thin bucket, since the latter is more likely to be noise.
  const ranked = results
    .filter((r) => r.stat.n >= MIN_SAMPLE_N && r.stat.winRate !== null)
    .sort((a, b) => {
      const aSig = a.stat.significance?.significant ? 1 : 0;
      const bSig = b.stat.significance?.significant ? 1 : 0;
      if (aSig !== bSig) return bSig - aSig;
      return (b.stat.winRate ?? 0) - (a.stat.winRate ?? 0);
    })
    .slice(0, 20);

  const rows: string[] = [
    "| Pattern | Holding | N | Win rate | Mean | Max DD | p-value | Significant |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of ranked) {
    rows.push(
      `| ${r.label} | ${r.holdingPeriod} | ${r.stat.n} | ${((r.stat.winRate ?? 0) * 100).toFixed(0)}% | ${r.stat.meanReturnPct === null ? "—" : `${r.stat.meanReturnPct >= 0 ? "+" : ""}${r.stat.meanReturnPct.toFixed(2)}%`} | ${r.stat.maxDrawdownPct === null ? "—" : `${r.stat.maxDrawdownPct.toFixed(2)}%`} | ${r.stat.significance ? r.stat.significance.pValue.toFixed(4) : "—"} | ${r.stat.significance?.significant ? "yes" : "no"} |`
    );
  }

  const markdown = `Every one of the 32 presence/absence patterns across {${CATEGORY_ORDER.map((c) => CATEGORY_LABELS[c]).join(", ")}}
(2^5, since each category is simplified to "bullish" or "not bullish" for this test), evaluated
at all 4 holding periods, then ranked: statistically significant patterns first, then by win
rate. Top 20 shown below that clear N >= ${MIN_SAMPLE_N}; the full 128 (32 patterns x 4 holding
periods) are written to backtestStats.json's \`combinations\` field for anyone who wants the rest.
This is a research artifact only — nothing on the live site reads it.

${rows.join("\n")}
`;

  return { markdown, results };
}

/** Standalone entry point, for iterating on this file without re-running report.ts's other sections. */
function main() {
  const resultsPath = path.join(DATA_DIR, "results.json");
  if (!fs.existsSync(resultsPath)) {
    console.error(`Missing ${resultsPath} — run "npm run backtest" first.`);
    process.exit(1);
  }
  const records: CombinationDayRecord[] = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const { markdown } = buildCombinations(records);
  console.log(`## Category Combinations\n\n${markdown}`);
}

if (process.argv[1] && process.argv[1].endsWith("combinations.ts")) {
  main();
}
