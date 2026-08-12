import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord } from "./run";
import { summarizeOccurrences, Occurrence } from "./metrics";
import { blockBootstrapProportion } from "./overlap";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

/**
 * Incremental-value study for the PRODUCTION harmonic engine
 * (src/lib/technicals/harmonics.ts + src/lib/signals/harmonicEvidence.ts).
 *
 * This replaces the earlier scripts/backtest/harmonicStudy.ts, which tested
 * a separate research-only retrospective detector. This script reads
 * `DayRecord.harmonic` directly off results.json — the SAME
 * buildHarmonicEvidence/selectBestHarmonic output the live engine and
 * scripts/backtest/pointInTime.test.ts already proved is point-in-time safe.
 * No pattern detection or PRZ math is reimplemented here.
 *
 * The question is NOT "do bullish harmonics win more than half the time" —
 * it is whether conditioning on harmonic evidence beats the baseline the
 * engine already has (Daily technical direction) on the SAME days, and
 * whether tighter evidence tiers (PRZ tested, confirmed, high-quality,
 * Daily/4H confluence, full "tradeable") add further lift. No threshold
 * below is fit to this data — 0.85 geometryQuality is the pre-existing top
 * quartile of the sample's own distribution, stated before results were
 * read, not searched for.
 *
 * Run: npx tsx scripts/backtest/harmonicIncrementalStudy.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

const HORIZONS = [1, 3, 7, 14, 30] as const;
type Horizon = (typeof HORIZONS)[number];
const FIELD: Record<Horizon, keyof DayRecord> = {
  1: "forwardReturn1d",
  3: "forwardReturn3d",
  7: "forwardReturn7d",
  14: "forwardReturn14d",
  30: "forwardReturn30d",
};

interface Tier {
  id: string;
  label: string;
  /** Verdict source and inclusion filter, applied to the same base population (records with harmonic present). */
  match: (r: DayRecord) => boolean;
  verdict: (r: DayRecord) => "bullish" | "bearish" | "neutral";
}

const TIERS: Tier[] = [
  {
    id: "baseline",
    label: "Baseline — Daily direction alone",
    match: () => true,
    verdict: (r) => (r.dailyDirection as "bullish" | "bearish" | "neutral" | null) ?? "neutral",
  },
  {
    id: "harmonic-any",
    label: "+ Harmonic present (any pattern, any status)",
    match: () => true,
    verdict: (r) => r.harmonic!.direction,
  },
  {
    id: "harmonic-przTested",
    label: "+ PRZ actually tested by price",
    match: (r) => r.harmonic!.przTested,
    verdict: (r) => r.harmonic!.direction,
  },
  {
    id: "harmonic-confirmed",
    label: "+ Confirmed (genuine rejection reaction at PRZ)",
    match: (r) => r.harmonic!.status === "confirmed" || r.harmonic!.status === "tradeable",
    verdict: (r) => r.harmonic!.direction,
  },
  {
    id: "harmonic-highQuality",
    label: "+ High geometric quality (>=0.85)",
    match: (r) => r.harmonic!.geometryQuality >= 0.85,
    verdict: (r) => r.harmonic!.direction,
  },
  {
    id: "harmonic-htfConfluence",
    label: "+ Daily/4H confluence (other timeframe agrees)",
    match: (r) => r.harmonic!.higherTimeframeConfluence,
    verdict: (r) => r.harmonic!.direction,
  },
  {
    id: "harmonic-tradeable",
    label: "+ Full production gate: TRADEABLE (confirmed + regime-aligned)",
    match: (r) => r.harmonic!.status === "tradeable",
    verdict: (r) => r.harmonic!.direction,
  },
  {
    id: "harmonic-counterTrend",
    label: "(diagnostic) Counter-trend harmonics only — must NOT be quietly good",
    match: (r) => r.harmonic!.regimeAlignment === "counter-trend",
    verdict: (r) => r.harmonic!.direction,
  },
];

function occurrencesFor(records: DayRecord[], tier: Tier, h: Horizon): Occurrence[] {
  const field = FIELD[h];
  return records
    .filter((r) => r.harmonic !== null && tier.match(r))
    .map((r) => ({ t: r.t, verdict: tier.verdict(r), forwardReturnPct: r[field] as number | null }))
    // Chronological order is REQUIRED by the block bootstrap below: the whole
    // method rests on adjacent entries being the dependent ones.
    .sort((a, b) => a.t - b.t);
}

/**
 * Block length for a horizon, in OBSERVATIONS rather than days.
 *
 * Two separate dependencies are being corrected at once. Serially, a
 * `h`-day forward return sampled daily overlaps its neighbour by h-1 days.
 * Cross-sectionally, BTC and ETH are two observations of the same day and
 * move together, so they are not independent of each other either. Since
 * the records are sorted by timestamp, each calendar day contributes two
 * adjacent rows — so a block spanning h days of BOTH assets is 2h rows, and
 * a block of that length absorbs both effects at once.
 */
const blockLengthFor = (h: Horizon) => 2 * h;

/** The 0/1 win series a proportion test needs, in the order `occurrencesFor` produced. */
function winSeries(occ: Occurrence[]): number[] {
  return occ
    .filter((o) => o.verdict !== "neutral" && o.forwardReturnPct !== null)
    .map((o) => ((o.verdict === "bullish" ? o.forwardReturnPct! > 0 : o.forwardReturnPct! < 0) ? 1 : 0));
}

const fmt = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);

function tableFor(records: DayRecord[], title: string, lines: string[]): void {
  lines.push(`### ${title}`, "");
  lines.push(
    "| Tier | Horizon | N | Eff. N | Win rate | Mean | Median | naive p | **corrected p** |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const tier of TIERS) {
    for (const h of HORIZONS) {
      const occ = occurrencesFor(records, tier, h);
      const stat = summarizeOccurrences(occ, MIN_SAMPLE_N);
      if (stat.n < MIN_SAMPLE_N) {
        lines.push(`| ${tier.label} | ${h}d | ${stat.n} | | insufficient data | | | | |`);
        continue;
      }
      const corrected = blockBootstrapProportion(winSeries(occ), blockLengthFor(h));
      lines.push(
        `| ${tier.label} | ${h}d | ${stat.n} | ${corrected ? corrected.effectiveN.toFixed(0) : "—"} | ${pct(stat.winRate)} | ` +
        `${fmt(stat.meanReturnPct)} | ${fmt(stat.medianReturnPct)} | ` +
        `${stat.significance ? stat.significance.pValue.toFixed(4) : "—"} | ` +
        `${corrected ? `**${corrected.pValue.toFixed(4)}**` : "—"} |`
      );
    }
  }
  lines.push("");
}

/** Lift of each harmonic tier's win rate over the baseline tier, same population slice, same horizon. */
function liftTable(records: DayRecord[], title: string, lines: string[]): void {
  lines.push(`### ${title} — lift over baseline`, "");
  lines.push("| Tier | Horizon | N | Win rate | Baseline win rate (same days) | Lift (pp) |", "|---|---|---|---|---|---|");
  for (const tier of TIERS) {
    if (tier.id === "baseline") continue;
    for (const h of HORIZONS) {
      const occ = occurrencesFor(records, tier, h);
      const stat = summarizeOccurrences(occ, MIN_SAMPLE_N);
      // Baseline restricted to the SAME day set this tier matched, so the
      // comparison isolates the tier's filter/verdict, not a different population.
      const matchedRecords = records.filter((r) => r.harmonic !== null && tier.match(r));
      const baseOcc = occurrencesFor(matchedRecords, TIERS[0], h);
      const baseStat = summarizeOccurrences(baseOcc, MIN_SAMPLE_N);
      if (stat.n < MIN_SAMPLE_N || baseStat.n < MIN_SAMPLE_N || stat.winRate === null || baseStat.winRate === null) {
        lines.push(`| ${tier.label} | ${h}d | ${stat.n} | insufficient data | | |`);
        continue;
      }
      const lift = (stat.winRate - baseStat.winRate) * 100;
      lines.push(`| ${tier.label} | ${h}d | ${stat.n} | ${pct(stat.winRate)} | ${pct(baseStat.winRate)} | ${lift >= 0 ? "+" : ""}${lift.toFixed(1)} |`);
    }
  }
  lines.push("");
}

/**
 * Chronological IS/OOS split, per asset (so BTC's longer/shorter history
 * doesn't skew ETH's split point or vice versa), then recombined. 70/30 —
 * this framework has zero fitted parameters (no threshold above was tuned
 * to this data), so this is a persistence check, not a train/test split in
 * the ML sense. Same framing walkForward.ts already uses.
 */
function splitInOutSample(records: DayRecord[]): { inSample: DayRecord[]; outOfSample: DayRecord[] } {
  const inSample: DayRecord[] = [];
  const outOfSample: DayRecord[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const assetRecords = records.filter((r) => r.asset === asset).sort((a, b) => a.t - b.t);
    const cut = Math.floor(assetRecords.length * 0.7);
    inSample.push(...assetRecords.slice(0, cut));
    outOfSample.push(...assetRecords.slice(cut));
  }
  return { inSample, outOfSample };
}

/**
 * Sequential walk-forward folds for the headline tier (TRADEABLE, the full
 * production gate) at 7d — 4 folds, each validated strictly after its own
 * discovery window, checking whether the win rate stays above 50% across
 * folds rather than being a one-off from a single lucky period.
 */
function walkForwardCheck(records: DayRecord[], lines: string[]): void {
  lines.push("### Walk-forward persistence — TRADEABLE tier, 7d horizon", "");
  const tier = TIERS.find((t) => t.id === "harmonic-tradeable")!;
  const occ = occurrencesFor(records, tier, 7).sort((a, b) => a.t - b.t);
  if (occ.length < MIN_SAMPLE_N * 4) {
    lines.push(`Insufficient sample (N=${occ.length}) to split into 4 sequential folds at N>=${MIN_SAMPLE_N} each.`, "");
    return;
  }
  const foldCount = 4;
  const foldSize = Math.floor(occ.length / foldCount);
  lines.push("| Fold | N | Win rate | Mean return |", "|---|---|---|---|");
  for (let i = 0; i < foldCount; i++) {
    const start = i * foldSize;
    const end = i === foldCount - 1 ? occ.length : start + foldSize;
    const fold = occ.slice(start, end);
    const stat = summarizeOccurrences(fold, 1); // report every fold's raw stat regardless of MIN_SAMPLE_N; small folds are labeled, not hidden
    lines.push(`| ${i + 1} | ${stat.n} | ${pct(stat.winRate)} | ${fmt(stat.meanReturnPct)} |`);
  }
  lines.push("");
}

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  say("# Harmonic Engine — Incremental Value Study (Production)");
  say("");
  say(
    "Reads `DayRecord.harmonic` from results.json — the actual production " +
    "`buildHarmonicEvidence`/`selectBestHarmonic` output, replayed point-in-time-safe " +
    "by scripts/backtest/run.ts. No detection logic is reimplemented here."
  );
  say("");

  const records: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8"));
  const withHarmonic = records.filter((r) => r.harmonic !== null);
  say(`Total day-records: ${records.length}. With a harmonic pattern present: ${withHarmonic.length} (${((100 * withHarmonic.length) / records.length).toFixed(1)}%).`);
  say("");

  const byStatus: Record<string, number> = {};
  for (const r of withHarmonic) byStatus[r.harmonic!.status] = (byStatus[r.harmonic!.status] ?? 0) + 1;
  say(`Status distribution: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  say("");

  tableFor(records, "Full sample", lines);
  liftTable(records, "Full sample", lines);

  const { inSample, outOfSample } = splitInOutSample(records);
  say(`In-sample: ${inSample.length} records (earliest 70% per asset). Out-of-sample: ${outOfSample.length} records (latest 30% per asset).`);
  say("");
  tableFor(inSample, "In-sample (discovery, first 70%)", lines);
  tableFor(outOfSample, "Out-of-sample (validation, last 30%)", lines);
  liftTable(outOfSample, "Out-of-sample", lines);

  walkForwardCheck(records, lines);

  say("## Verdict");
  say("");
  say("**This verdict supersedes an earlier one that graded the harmonic engine a C on the strength of a 30-day result at p<0.01. That p-value was wrong** — not miscomputed, but computed under an independence assumption the data does not satisfy. It is restated here from the corrected numbers, and the verdict moves down as a result.");
  say("");
  say("**Coverage.** A harmonic pattern of some kind is present on 99.8% of days (2889/2896). With nine patterns, two timeframes and an 8% intermediate-leg tolerance, X-A-B-C structure is nearly always findable in noisy price data. \"Harmonic present\" is not a filter, it is close to a constant, and carries no information by itself. Everything below concerns the tiers that restrict that population.");
  say("");
  say("**The overlap correction changes the headline completely.** A 30-day forward return sampled daily shares 29 of its 30 days with its neighbour, and BTC/ETH are two correlated views of the same day. The `Eff. N` column is the honest independent count: at the 30-day horizon the TRADEABLE tier's 1,611 rows are worth **27** independent observations, not 1,611. Every 30-day result that read p<0.01 lands between p=0.19 and p=0.31 once that is accounted for:");
  say("");
  say("| Tier (30d) | Naive p | Corrected p | Eff. N |");
  say("|---|---|---|---|");
  say("| Harmonic present | 0.0061 | 0.2359 | 47 |");
  say("| PRZ tested | 0.0029 | 0.1922 | 41 |");
  say("| Confirmed | 0.0150 | 0.2545 | 33 |");
  say("| Daily/4H confluence | 0.0061 | 0.3050 | 38 |");
  say("| TRADEABLE (full production gate) | 0.0033 | 0.2307 | 27 |");
  say("");
  say("**Nothing in this study is statistically significant at any horizon after correction.** That includes the counter-trend diagnostic, which the earlier verdict called \"the cleanest result in this study\": its 7d and 14d p-values move from 0.0115 and 0.0068 to 0.1170 and 0.1795. The claim that counter-trend suppression was empirically validated was overstated and is withdrawn.");
  say("");
  say("What survives is weaker and purely descriptive: the point estimates still lean the direction theory predicts (TRADEABLE beats baseline by +2 to +7pp out-of-sample; counter-trend harmonics remain the worst bucket in every cut), and the walk-forward folds are mixed (46/51/53/52% win rate, one with a negative mean return). Directionally encouraging, statistically unproven.");
  say("");
  say("### HARMONIC VERDICT: D — no demonstrable incremental value");
  say("");
  say("Not \"harmonics are useless\" — **\"this dataset cannot tell us whether harmonics are useful\"**, which is a different and more honest claim. At 27-47 effective observations per 30-day cell, only an enormous effect would be detectable, and no such effect is present.");
  say("");
  say("**Recommendation: keep the engine, change nothing, and fix the copy.** Three reasons it stays. It is architecturally correct (forward-looking PRZ, geometry and confirmation held separate, regime-non-overriding, point-in-time safe). It gates nothing — it is additive evidence, so an unproven signal in this position costs nothing but a line of text. And the cost of removing and rebuilding it later would exceed the cost of leaving it in place while evidence accumulates.");
  say("");
  say("What must change is the claim, not the code: no UI or reasoning copy may describe harmonic evidence as improving outcomes at any horizon, because that is not established. The live summary line is already phrased as corroborating evidence rather than a prediction, which is the correct framing and should stay that way.");
  say("");
  say("**What would change this answer:** effective sample size, not better geometry. Reaching ~200 independent 30-day windows requires roughly 16 years of two-asset history, or a wider asset universe. Broadening beyond BTC/ETH is the only realistic route to settling this, and is worth more than any refinement of the pattern detector.");

  const outPath = path.join(__dirname, "harmonicIncrementalStudy.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[harmonicIncrementalStudy] wrote ${outPath}`);
}

main();
