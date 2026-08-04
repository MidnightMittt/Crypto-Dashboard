import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord } from "./run";

/**
 * Rolling-window backtest orchestrator (plan Part 4): instead of one long
 * window, replay the SAME real `replayAsset()` (imported, never
 * reimplemented) across several overlapping stretches, so a signal's
 * win rate can be compared across different chunks of history rather than
 * reported as one number that might just describe one lucky/unlucky
 * stretch.
 *
 * Window boundaries are computed from the ACTUAL earliest/latest evaluable
 * date on disk, not hardcoded calendar dates. Coinalyze's OI/long-short
 * history is a rolling retention window, not a fixed archive (confirmed
 * during the migration — see fetchHistory.mjs's header), so a fixed
 * "2019-2021" style label would silently go stale as the available range
 * creeps forward on every future re-fetch.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DAY_MS = 86_400_000;

// 18 months wide, sliding 6 months at a time — roughly the cadence the
// windows were originally requested at (2-year windows, 1-year stride),
// scaled down to fit the ~4 years of depth Coinalyze's OI history actually
// has today (a fixed 2yr/1yr stride would only fit 2 full windows in that
// range; 18mo/6mo fits 5-6, giving enough windows to actually see drift).
const WINDOW_MONTHS = 18;
const STRIDE_MONTHS = 6;

export interface RollingWindow {
  label: string;
  start: number; // ms, inclusive
  end: number; // ms, exclusive
}

/** UTC-safe month arithmetic, matching fetchHistory.mjs's own monthsBackList convention. */
function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
}

export function buildWindows(earliestT: number, latestT: number): RollingWindow[] {
  const windows: RollingWindow[] = [];
  let start = earliestT;
  while (start < latestT) {
    const end = Math.min(addMonths(start, WINDOW_MONTHS), latestT + DAY_MS);
    windows.push({
      label: `${new Date(start).toISOString().slice(0, 7)} to ${new Date(end).toISOString().slice(0, 7)}`,
      start,
      end,
    });
    if (end >= latestT + DAY_MS) break; // last window already reaches the end
    start = addMonths(start, STRIDE_MONTHS);
  }
  return windows;
}

export interface RollingDayRecord extends DayRecord {
  windowLabel: string;
}

function main() {
  const marketPath = path.join(DATA_DIR, "MARKET.json");
  if (!fs.existsSync(marketPath)) {
    console.error(`Missing ${marketPath} — run "npm run backtest:fetch" first.`);
    process.exit(1);
  }
  const marketWide: MarketWideData = JSON.parse(fs.readFileSync(marketPath, "utf8"));

  const allRecords: RollingDayRecord[] = [];

  for (const asset of ["BTC", "ETH"] as const) {
    const filePath = path.join(DATA_DIR, `${asset}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing ${filePath} — run "npm run backtest:fetch" first.`);
      process.exit(1);
    }
    const data: RawAssetData = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // One unbounded pass just to discover the real evaluable range (cheap
    // relative to a batch script; avoids duplicating run.ts's private
    // OI_BURN_IN_DAYS/FORWARD_BUFFER_DAYS constants here).
    const fullRange = replayAsset(data, marketWide);
    if (fullRange.length === 0) {
      console.log(`[rolling] ${asset}: no evaluable days at all — skipping`);
      continue;
    }
    const earliestT = fullRange[0].t;
    const latestT = fullRange[fullRange.length - 1].t;
    const windows = buildWindows(earliestT, latestT);

    console.log(
      `[rolling] ${asset}: ${windows.length} windows across ${fullRange[0].date} to ${fullRange[fullRange.length - 1].date}`
    );
    for (const w of windows) {
      const records = replayAsset(data, marketWide, w.start, w.end);
      console.log(`  ${w.label}: ${records.length} days`);
      for (const r of records) allRecords.push({ ...r, windowLabel: w.label });
    }
  }

  fs.writeFileSync(path.join(DATA_DIR, "resultsRolling.json"), JSON.stringify(allRecords, null, 2));
  console.log(`[rolling] wrote ${allRecords.length} total windowed day-records to scripts/backtest/data/resultsRolling.json`);
}

main();
