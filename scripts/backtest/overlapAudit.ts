import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord } from "./run";
import { SIGNAL_HYPOTHESES, HOLDING_PERIODS, HoldingPeriod } from "../../src/lib/signals/hypothesis";
import { signTestPValue } from "./metrics";
import { blockBootstrapProportion } from "../../src/lib/research/overlap";
import { assetsPerDay, blockLengthFor } from "./metrics";
import { deriveSampleSizeLabel, MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";
import { effectiveSampleSize } from "../../src/lib/research/overlap";

/**
 * Audit of every published backtest statistic against the overlap flaw that
 * `overlap.ts` exists to correct. Research only — reads results.json, writes
 * a markdown report, and changes no production file.
 *
 * The question is narrow and practical: WHICH shipped numbers are wrong, and
 * does any of them reach a user? Point estimates (win rates) are unaffected
 * by overlap — it inflates confidence, not the estimate — so this is
 * specifically about significance claims and sample-size labelling.
 *
 * Run: npx tsx scripts/backtest/overlapAudit.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
/** The committed per-metric snapshot the live site reads — checked against, never written by this audit. */
const SHIPPED_STATS_PATH = path.join(__dirname, "..", "..", "src", "data", "backtestMetricStats.json");

/*
 * Block lengths come from `blockLengthFor` in metrics.ts, derived from the
 * replay's own asset count rather than written here as a literal.
 *
 * This file used to hold its own `BLOCK_BY_PERIOD = { 24h: 2, 7d: 14 }`. Once
 * report.ts needed the same numbers to label sample sizes honestly, a second
 * copy would have been two places to update the day a third asset joins the
 * replay — and a stale copy understates the block, which OVERSTATES
 * independent evidence. That is the direction that flatters results, so it is
 * the copy worth removing.
 */

function fieldFor(hp: HoldingPeriod): keyof DayRecord {
  switch (hp) {
    case "1h": return "forwardReturn1h";
    case "4h": return "forwardReturn4h";
    case "24h": return "forwardReturn1d"; // mirrors report.ts's holdingPeriodField
    case "7d": return "forwardReturn7d";
  }
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  say("# Overlap Audit — which published backtest statistics are affected");
  say("");
  say("Point estimates are NOT affected by overlap; it inflates confidence, not the estimate. So no win rate anywhere in the app changes. What changes is which of those win rates may be called significant, and how large the sample behind them honestly is.");
  say("");

  const records: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8"))
    .sort((a: DayRecord, b: DayRecord) => a.t - b.t);

  const perDay = assetsPerDay(records);

  say("## Per-metric hypothesis stats (report.ts's core table)");
  say("");
  say("| Metric | Holding | N | Eff. N | Win rate | naive p | corrected p | Verdict change |");
  say("|---|---|---|---|---|---|---|---|");

  let flipped = 0;
  let tested = 0;
  const flippedRows: string[] = [];

  for (const h of SIGNAL_HYPOTHESES) {
    if (!h.hasHistoricalSource) continue;
    for (const hp of HOLDING_PERIODS) {
      const field = fieldFor(hp);
      const scored = records
        .filter((r) => {
          const m = r.metrics.find((x) => x.id === h.id);
          return m && m.verdict !== "neutral" && r[field] !== null;
        })
        .map((r): number => {
          const verdict = r.metrics.find((x) => x.id === h.id)!.verdict;
          const ret = r[field] as number;
          return (verdict === "bullish" ? ret > 0 : ret < 0) ? 1 : 0;
        });

      if (scored.length < MIN_SAMPLE_N) continue;
      tested++;

      const wins = scored.reduce((a, b) => a + b, 0);
      const naiveP = signTestPValue(scored.length, wins);
      const corrected = blockBootstrapProportion(scored, blockLengthFor(hp, perDay))!;

      const wasSig = naiveP < 0.05;
      const isSig = corrected.pValue < 0.05;
      const change = wasSig && !isSig ? "**LOST significance**" : !wasSig && isSig ? "gained" : "no change";
      if (wasSig && !isSig) {
        flipped++;
        flippedRows.push(`${h.label} @ ${hp}`);
      }

      say(`| ${h.label} | ${hp} | ${scored.length} | ${corrected.effectiveN.toFixed(0)} | ` +
          `${f1((100 * wins) / scored.length)}% | ${naiveP.toFixed(4)} | ${corrected.pValue.toFixed(4)} | ${change} |`);
    }
  }
  say("");
  say(`**${flipped} of ${tested}** metric x holding-period cells lose significance under correction.`);
  if (flippedRows.length) {
    say("");
    say("Cells that were significant and are not: " + flippedRows.map((r) => `\`${r}\``).join(", ") + ".");
  }
  say("");

  say("## Does any of this reach a user?");
  say("");
  say("Four lookups feed the UI (`lookupMetricPerformance`, `lookupBiasVerdictStat`, `lookupCategoryStat`, `lookupCalibrationBucket`). Taking each field the panels actually render:");
  say("");
  say("| Rendered field | Where | Affected? |");
  say("|---|---|---|");
  say("| `winRate24h` | HistoricalPerformancePanel | **No** — point estimate, and 24h windows do not overlap in time |");
  say("| `winRate7d` | HistoricalPerformancePanel | **Point estimate fine**; but it is one of two win rates shown side by side with no uncertainty attached, and its honest sample is 1/7 of the printed occurrence count |");
  say("| `n24h` (\"Occurrences\") | HistoricalPerformancePanel | Literally correct, but overstates independent evidence ~2x (BTC+ETH same day) |");
  say("| `sampleSizeLabel` | HistoricalPerformancePanel | **Yes** — derived from raw n against 200/1000 cut points; see below |");
  say("| Category / bias verdict win rates | CategoryCard, AiMarketSummary | Point estimates, all at 24h — unaffected |");
  say("| Calibration buckets | AiMarketSummary | Point estimates — unaffected |");
  say("");

  say("### sampleSizeLabel — now a standing check, not a finding");
  say("");
  say("This section originally reported that the shipped label was computed on the RAW occurrence count and would change tier for two metrics if computed honestly. That has been applied: `deriveSampleSizeLabel` now takes the effective sample, and report.ts feeds it one.");
  say("");
  say("So the table below no longer recomputes what the label *would* be. It reads the label actually shipped in `src/data/backtestMetricStats.json` and checks it against what this audit derives independently. A DRIFT row means the published file and this audit disagree about how much evidence a metric has — which is the failure this section now exists to catch.");
  say("");
  say("| Metric | n (24h) | Effective n | Shipped label | Audit's label | |");
  say("|---|---|---|---|---|---|");

  const shipped: Record<string, { effectiveN24h: number | null; sampleSizeLabel: string | null }> =
    JSON.parse(fs.readFileSync(SHIPPED_STATS_PATH, "utf8")).metrics ?? {};

  let drift = 0;
  for (const h of SIGNAL_HYPOTHESES) {
    if (!h.hasHistoricalSource) continue;
    const n = records.filter((r) => {
      const m = r.metrics.find((x) => x.id === h.id);
      return m && m.verdict !== "neutral" && r.forwardReturn1d !== null;
    }).length;
    if (n < MIN_SAMPLE_N) continue;

    const effN = Math.round(effectiveSampleSize(n, blockLengthFor("24h", perDay)));
    const auditLabel = deriveSampleSizeLabel(effN);
    const ship = shipped[h.id];
    const shipLabel = ship?.sampleSizeLabel ?? "—";
    const agrees = shipLabel === auditLabel && ship?.effectiveN24h === effN;
    if (!agrees) drift++;
    say(`| ${h.label} | ${n} | ${effN} | ${shipLabel} | ${auditLabel} | ${agrees ? "ok" : "**DRIFT**"} |`);
  }
  say("");
  say(
    drift === 0
      ? "**No drift.** Every shipped label matches what this audit derives from the replay independently."
      : `**${drift} metric(s) DRIFT.** The published file and this audit disagree; regenerate the report.`
  );
  say("");

  say("## Conclusion");
  say("");
  say(`The blast radius is smaller than feared, for one structural reason: the UI's headline horizon is 24h, and 24-hour windows sampled daily do not overlap each other. The badly affected horizon — 7d, which shares six days in seven — is used in research reports and shown as a bare win rate, never as a significance claim.`);
  say("");
  say("So: **no win rate displayed anywhere in the app is wrong, and none needs to change.** What was wrong was the confidence attached to research conclusions drawn from overlapping horizons — most consequentially the harmonic study's 30-day headline, which has been restated (see harmonicIncrementalStudy.md).");
  say("");
  say("Recommended follow-ups, in value order:");
  say("");
  say("1. Route report.ts's hypothesis section through `blockBootstrapProportion` so future reports cannot repeat the error. This is the durable fix.");
  say("2. ~~Recompute `sampleSizeLabel` on the effective count.~~ **DONE.** `deriveSampleSizeLabel` takes the effective sample and report.ts feeds it one; the section above is now a standing drift check rather than a finding. Long/Short Positioning and Market Structure both moved Large -> Medium, and their `confidenceLabel` moved with them.");
  say("3. Leave every displayed win rate exactly as it is. Overlap inflates confidence, never the point estimate — this remains true and nothing about item 2 changed a single win rate.");
  say("");
  say("One caveat worth carrying forward: the Medium/Large cut point of 1000 was fixed against the OLD raw distribution and was not re-drawn for the effective one, deliberately — re-drawing a threshold after seeing which metrics it demotes would be choosing a cut to obtain a label. But it does mean the boundary is currently sensitive: Market Structure sits at 881, 12% below it. Read that \"Medium\" as near-the-boundary rather than as a verdict. See `deriveSampleSizeLabel`\'s own note.");

  const outPath = path.join(__dirname, "overlapAudit.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[overlapAudit] wrote ${outPath}`);
}

main();
