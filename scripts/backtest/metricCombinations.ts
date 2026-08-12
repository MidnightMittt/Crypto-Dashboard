import { SIGNAL_HYPOTHESES, HOLDING_PERIODS, HoldingPeriod } from "../../src/lib/signals/hypothesis";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";
import { summarizeOccurrences, Occurrence, OccurrenceSummary } from "./metrics";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";

/**
 * Metric-level combination testing (plan Part 7) — structurally parallel to
 * the existing category-level `combinations.ts`, but different in an
 * important way: category-combinations test EXACT presence/absence across
 * all 5 categories at once (a full partition). Metric-combinations test a
 * CONJUNCTION on just the named subset ("both Funding AND OI fired
 * bullish"), ignoring what the other 13 metrics did that day — this
 * matches the user's plain-English phrasing ("Funding + OI") far more
 * directly than a full-15-metric partition would, and is why this needed
 * its own file rather than a parameter on combinations.ts.
 *
 * Two tiers, treated differently on purpose:
 *  - Named combos: pre-registered before seeing any data (the user
 *    specified these before this file was written), always computed,
 *    reported with their raw p-value — exempt from the FDR correction
 *    below, because correcting a hypothesis for a search it was never part
 *    of would itself be a statistical error.
 *  - Bounded automatic pairs: all C(15,2)=105 pairs, genuinely an
 *    exploratory scan, and therefore subject to Benjamini-Hochberg FDR
 *    correction (see multipleTesting.ts) — 105 pairs x 4 holding periods
 *    means ~22 false positives are statistically guaranteed at raw p<0.05
 *    even with zero real effect, so raw significance alone would be a
 *    misleading claim here in a way it isn't for a single pre-registered
 *    hypothesis. Triples are NOT exhaustively searched (C(15,3)=455, most
 *    cells thin even at this depth) — only the named triples above run at
 *    triple depth.
 */

const NAMED_COMBOS: Array<{ label: string; metricIds: string[] }> = [
  { label: "Funding + Open Interest", metricIds: ["funding", "openInterest"] },
  { label: "Funding + RSI (Technicals)", metricIds: ["funding", "technicals"] },
  { label: "Funding + Stablecoins", metricIds: ["funding", "stablecoins"] },
  { label: "Open Interest + Exchange Flow", metricIds: ["openInterest", "exchangeFlow"] },
  { label: "Funding + OI + Volume", metricIds: ["funding", "openInterest", "spotPerpVolume"] },
  { label: "Funding + OI + Stablecoins", metricIds: ["funding", "openInterest", "stablecoins"] },
  { label: "Funding + OI + Technical Confirmation", metricIds: ["funding", "openInterest", "technicals"] },
];

export interface MetricComboDayRecord {
  t: number;
  metrics: Array<{ id: string; verdict: string }>;
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn1d: number | null;
  forwardReturn7d: number | null;
}

export interface MetricComboStat {
  label: string;
  metricIds: string[];
  holdingPeriod: string;
  isNamed: boolean;
  stat: OccurrenceSummary;
  /** Only present for automatic pairs — named combos are exempt from FDR correction (see file doc comment). */
  fdr?: { rank: number; significant: boolean };
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

function labelFor(metricId: string): string {
  return SIGNAL_HYPOTHESES.find((h) => h.id === metricId)?.label ?? metricId;
}

/** All C(n,2) unordered pairs from a list of ids, in a fixed deterministic order. */
function allPairs(ids: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
  }
  return pairs;
}

/**
 * A day's occurrence is "bullish" (predicted positive) only if EVERY metric
 * in `metricIds` read bullish that day — a conjunction, not the full
 * presence/absence partition combinations.ts uses. Days where the
 * conjunction doesn't hold are "neutral" (not predicted), so
 * `summarizeOccurrences` still gets a full population for its confusion
 * matrix, matching the same convention combinations.ts/report.ts already
 * use.
 */
function testComboBullish(records: MetricComboDayRecord[], metricIds: string[], hp: HoldingPeriod): OccurrenceSummary {
  const field = holdingPeriodField(hp);
  const occurrences: Occurrence[] = records.map((r) => {
    const allBullish = metricIds.every((id) => r.metrics.find((m) => m.id === id)?.verdict === "bullish");
    return { t: r.t, verdict: allBullish ? "bullish" : "neutral", forwardReturnPct: r[field] };
  });
  return summarizeOccurrences(occurrences, MIN_SAMPLE_N);
}

export function buildMetricCombinations(records: MetricComboDayRecord[]): { markdown: string; results: MetricComboStat[] } {
  const allIds = SIGNAL_HYPOTHESES.map((h) => h.id);
  const pairs = allPairs(allIds);

  const namedResults: MetricComboStat[] = [];
  for (const combo of NAMED_COMBOS) {
    for (const hp of HOLDING_PERIODS) {
      const stat = testComboBullish(records, combo.metricIds, hp);
      namedResults.push({ label: combo.label, metricIds: combo.metricIds, holdingPeriod: hp, isNamed: true, stat });
    }
  }

  const automaticResults: MetricComboStat[] = [];
  for (const hp of HOLDING_PERIODS) {
    const hpPairs = pairs.map(([a, b]) => ({
      label: `${labelFor(a)} + ${labelFor(b)}`,
      metricIds: [a, b],
      stat: testComboBullish(records, [a, b], hp),
    }));

    // FDR is computed only over pairs with an actual significance result
    // (N >= MIN_SAMPLE_N) — a pair with insufficient data has no p-value to
    // correct, and folding a null into the family would misstate `m`.
    const withSignificance = hpPairs.filter((r) => r.stat.significance !== null);
    const fdrResults = benjaminiHochberg(withSignificance.map((r) => r.stat.significance!.pValue));

    let fdrIdx = 0;
    for (const r of hpPairs) {
      const hasSignificance = r.stat.significance !== null;
      const fdr = hasSignificance ? fdrResults[fdrIdx++] : undefined;
      automaticResults.push({
        label: r.label,
        metricIds: r.metricIds,
        holdingPeriod: hp,
        isNamed: false,
        stat: r.stat,
        fdr: fdr ? { rank: fdr.rank, significant: fdr.significant } : undefined,
      });
    }
  }

  const namedRows: string[] = ["| Combo | Holding | N | Win rate | Mean | p-value |", "|---|---|---|---|---|---|"];
  for (const r of namedResults) {
    if (r.stat.n < MIN_SAMPLE_N) {
      namedRows.push(`| ${r.label} | ${r.holdingPeriod} | ${r.stat.n} | insufficient data | | |`);
      continue;
    }
    namedRows.push(
      `| ${r.label} | ${r.holdingPeriod} | ${r.stat.n} | ${r.stat.winRate === null ? "—" : `${(r.stat.winRate * 100).toFixed(0)}%`} | ${r.stat.meanReturnPct === null ? "—" : `${r.stat.meanReturnPct >= 0 ? "+" : ""}${r.stat.meanReturnPct.toFixed(2)}%`} | ${r.stat.significance ? r.stat.significance.pValue.toFixed(4) : "—"} |`
    );
  }

  const bhSignificant = automaticResults.filter((r) => r.fdr?.significant);
  const autoRows: string[] = ["| Pair | Holding | N | Win rate | Mean | p-value | FDR rank |", "|---|---|---|---|---|---|---|"];
  for (const r of bhSignificant.sort((a, b) => (a.stat.significance?.pValue ?? 1) - (b.stat.significance?.pValue ?? 1))) {
    autoRows.push(
      `| ${r.label} | ${r.holdingPeriod} | ${r.stat.n} | ${r.stat.winRate === null ? "—" : `${(r.stat.winRate * 100).toFixed(0)}%`} | ${r.stat.meanReturnPct === null ? "—" : `${r.stat.meanReturnPct >= 0 ? "+" : ""}${r.stat.meanReturnPct.toFixed(2)}%`} | ${r.stat.significance!.pValue.toFixed(4)} | ${r.fdr!.rank} |`
    );
  }

  const markdown = `### Named combinations (pre-registered, no correction applied)

${namedRows.join("\n")}

### Bounded automatic pairs (105 pairs x 4 holding periods = 420 tests; FDR-corrected)

105 combinations tested per holding period; expect roughly 5 false positives at raw p<0.05 by
chance alone even with zero real effect. Only the ${bhSignificant.length} row(s) below cleared the
Benjamini-Hochberg correction (q=0.05) — everything else, significant-looking or not at the raw
p-value, is omitted from this table because raw significance alone is not a meaningful claim at
this scale. Full results (all 420, corrected and uncorrected) are in backtestResearch.json's
\`metricCombinations\` field.

${bhSignificant.length > 0 ? autoRows.join("\n") : "*(none cleared the correction this run)*"}
`;

  return { markdown, results: [...namedResults, ...automaticResults] };
}
