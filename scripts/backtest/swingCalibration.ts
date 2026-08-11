import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord, DEFAULT_REPLAY_CONFIG } from "./run";
import { DEFAULT_SWING_CONFIG, SwingThesisConfig } from "../../src/lib/signals/swingThesis";

/**
 * Derives the swing layer's thresholds from measured history instead of
 * taste.
 *
 * The brief is explicit: "Determine the appropriate thresholds from the
 * existing architecture and historical behavior. Do not invent arbitrary
 * values simply to force stability." So this sweeps the activation band,
 * deactivation band and sustain requirement through the REAL replay — the
 * same `replayAsset` production logic runs through — and prints what each
 * setting actually produces.
 *
 * The number that matters is MEDIAN THESIS DURATION. The product target is
 * days-to-weeks, so a configuration is disqualified if it churns (duration
 * of a day or two, i.e. the current behavior with extra steps) and equally
 * disqualified if it produces almost no theses at all, which would be
 * "stable" only in the sense that a stopped clock is.
 *
 * Run: npx tsx scripts/backtest/swingCalibration.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

interface Episode {
  asset: string;
  version: number;
  direction: string;
  days: number;
  endStatus: string;
}

/**
 * Groups consecutive day-records into thesis episodes. Version is monotone
 * per asset, so a change of version is unambiguously a different thesis —
 * no heuristic stitching required.
 */
function episodesOf(records: DayRecord[]): Episode[] {
  const episodes: Episode[] = [];
  let current: Episode | null = null;

  for (const r of records) {
    if (r.swingVersion === null) {
      current = null;
      continue;
    }
    if (!current || current.version !== r.swingVersion || current.asset !== r.asset) {
      current = {
        asset: r.asset,
        version: r.swingVersion,
        direction: r.swingDirection ?? "?",
        days: 1,
        endStatus: r.swingStatus ?? "?",
      };
      episodes.push(current);
    } else {
      current.days += 1;
      current.endStatus = r.swingStatus ?? current.endStatus;
    }
  }
  return episodes;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The stateless engine's own churn over the same days, as the baseline every
 * candidate is judged against. Counts how often the shipped `action` field
 * changes from one evaluable day to the next.
 */
function statelessFlips(records: DayRecord[]): { flips: number; days: number } {
  let flips = 0;
  let days = 0;
  const byAsset = new Map<string, DayRecord[]>();
  for (const r of records) {
    if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
    byAsset.get(r.asset)!.push(r);
  }
  for (const rows of byAsset.values()) {
    days += rows.length;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].action !== rows[i - 1].action) flips++;
    }
  }
  return { flips, days };
}

interface Row {
  label: string;
  theses: number;
  medianDays: number;
  maxDays: number;
  daysWithThesis: number;
  coveragePct: number;
  invalidated: number;
  completed: number;
}

function evaluate(label: string, swing: SwingThesisConfig, assets: Array<{ data: RawAssetData; marketWide: MarketWideData }>): Row {
  const records: DayRecord[] = [];
  for (const { data, marketWide } of assets) {
    records.push(...replayAsset(data, marketWide, undefined, undefined, { ...DEFAULT_REPLAY_CONFIG, swing }));
  }

  const episodes = episodesOf(records);
  const daysWithThesis = records.filter((r) => r.swingVersion !== null).length;

  return {
    label,
    theses: episodes.length,
    medianDays: median(episodes.map((e) => e.days)),
    maxDays: episodes.reduce((m, e) => Math.max(m, e.days), 0),
    daysWithThesis,
    coveragePct: records.length > 0 ? (100 * daysWithThesis) / records.length : 0,
    invalidated: episodes.filter((e) => e.endStatus === "invalidated").length,
    completed: episodes.filter((e) => e.endStatus === "completed").length,
  };
}

function main() {
  const marketPath = path.join(DATA_DIR, "MARKET.json");
  if (!fs.existsSync(marketPath)) {
    console.error(`Missing ${marketPath} — run "npm run backtest:fetch" first.`);
    process.exit(1);
  }
  const marketWide: MarketWideData = JSON.parse(fs.readFileSync(marketPath, "utf8"));

  const assets = (["BTC", "ETH"] as const).map((asset) => ({
    data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${asset}.json`), "utf8")) as RawAssetData,
    marketWide,
  }));

  // Baseline: what the stateless engine does over the same days.
  const baselineRecords: DayRecord[] = [];
  for (const { data } of assets) baselineRecords.push(...replayAsset(data, marketWide));
  const base = statelessFlips(baselineRecords);
  console.log(
    `\nBASELINE (stateless action, unchanged): ${base.flips} changes over ${base.days} asset-days ` +
      `= ${(base.flips / base.days).toFixed(2)} per day, median run length ${(base.days / (base.flips + 1)).toFixed(1)}d\n`
  );

  const rows: Row[] = [];
  for (const activationBand of [7, 9, 11, 13]) {
    for (const deactivationBand of [3, 5, 7]) {
      if (deactivationBand >= activationBand) continue; // the gap IS the hysteresis
      for (const sustainCloses of [1, 2, 3]) {
        rows.push(
          evaluate(`act=${activationBand} deact=${deactivationBand} sustain=${sustainCloses}`, {
            ...DEFAULT_SWING_CONFIG,
            activationBand,
            deactivationBand,
            sustainCloses,
          }, assets)
        );
      }
    }
  }

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log("configuration                  theses  medDays  maxDays  coverage%  invalid  complete");
  console.log("─".repeat(88));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(30)}${pad(r.theses, 6)}${pad(r.medianDays.toFixed(1), 9)}${pad(r.maxDays, 9)}` +
        `${pad(r.coveragePct.toFixed(0), 11)}${pad(r.invalidated, 9)}${pad(r.completed, 10)}`
    );
  }

  console.log(
    "\nRead this as: medDays is the product requirement (days-to-weeks).\n" +
      "coverage% is how often a thesis exists at all — very low coverage means\n" +
      "the engine is silent rather than stable, which is a different failure.\n"
  );
}

main();
