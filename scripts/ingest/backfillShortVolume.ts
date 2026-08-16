import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  EMPTY_POSITIONING_HISTORY,
  PositioningHistory,
  PositioningPoint,
  appendPoints,
  prunePoints,
} from "../../src/lib/history/positioningHistory";
import { parseShortVolumeRow } from "../../src/lib/dossier/providers/finraShortVolume";
import { EQUITY_PANEL } from "../../src/lib/markets/equityPanel";

/**
 * SHORT-VOLUME BACKFILL — the only half of the positioning history that has
 * a past to recover.
 *
 * FINRA publishes one Reg SHO file PER DATE, so short-sale volume genuinely
 * can be reconstructed: verified reachable for 2020, 2023, 2025 and 2026;
 * 2016 answers 403. CBOE's delayed chain has no date parameter at all, so
 * gamma, put/call and ATM IV cannot be backfilled by anything — they start
 * when recordPositioning.ts starts and that is simply the cost of not having
 * built this sooner.
 *
 * Rows written here carry `origin: "backfill"` and NOTHING but short volume.
 * Their null gamma means "never observed", not "observed as absent", and
 * appendPoints refuses to let them overwrite a live row — otherwise running
 * this after a month of recording would silently delete every option
 * observation collected so far.
 *
 * One file serves every symbol, so the cost is one request per DATE, not per
 * symbol-date. Backfilling 95 names over a year is ~250 requests, not 23,750.
 *
 *   npx tsx scripts/ingest/backfillShortVolume.ts --days 400
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "positioningHistory.json");

/** Courtesy delay between date files. */
const THROTTLE_MS = 200;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

async function main(): Promise<void> {
  const days = arg("days", 400);
  const wanted = new Set<string>(EQUITY_PANEL);

  const record: PositioningHistory = fs.existsSync(OUT)
    ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as PositioningHistory)
    : EMPTY_POSITIONING_HISTORY;

  const fresh: PositioningPoint[] = [];
  let filesOk = 0;
  let filesMissing = 0;
  /** Dates that actually yielded rows; min/max are taken at the end. */
  const covered: string[] = [];

  for (let back = 1; back <= days; back++) {
    const d = new Date(Date.now() - back * 86_400_000);
    // Weekends never have a file; skipping them saves a third of the requests.
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
    const iso = d.toISOString().slice(0, 10);

    let text: string;
    try {
      const res = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${stamp}.txt`, {
        headers: { "User-Agent": "leverage-terminal/1.0" },
      });
      /*
       * A missing file is normal — market holidays have none, and FINRA's
       * archive does not reach back forever (2016 answers 403). Counted and
       * reported rather than thrown, so one hole cannot abandon the run.
       */
      if (!res.ok) {
        filesMissing++;
        continue;
      }
      text = await res.text();
    } catch {
      filesMissing++;
      continue;
    }

    let matched = 0;
    for (const line of text.split("\n")) {
      // Cheap pre-filter: the symbol is the second pipe-delimited field.
      const bar = line.indexOf("|");
      if (bar < 0) continue;
      const bar2 = line.indexOf("|", bar + 1);
      const symbol = line.slice(bar + 1, bar2);
      if (!wanted.has(symbol)) continue;

      const row = parseShortVolumeRow(line);
      if (!row) continue;
      matched++;
      fresh.push({
        date: iso,
        symbol,
        origin: "backfill",
        netGexUsdPer1Pct: null,
        gammaSign: null,
        shortRatioPct: row.shortRatioPct,
        putCallOiRatio: null,
        putCallVolumeRatio: null,
        atmIvPct: null,
        atmIvDaysToExpiry: null,
        typicalDailyMovePct: null,
      });
    }

    if (matched > 0) {
      filesOk++;
      covered.push(iso);
    }
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  const points = prunePoints(appendPoints(record.points, fresh));
  fs.writeFileSync(
    OUT,
    JSON.stringify({ version: 1, generatedAt: Date.now(), points } satisfies PositioningHistory, null, 0)
  );

  console.log(
    `[backfill] ${filesOk} daily files parsed, ${filesMissing} missing/holiday, ` +
      `${fresh.length.toLocaleString()} short-volume rows for ${wanted.size} symbols`
  );
  covered.sort();
  console.log(`[backfill] covered ${covered[0] ?? "-"} to ${covered[covered.length - 1] ?? "-"}`);
  console.log(
    "[backfill] options fields left null BY CONSTRUCTION — CBOE has no archive, " +
      "so gamma, put/call and ATM IV begin when recordPositioning.ts first runs."
  );
  console.log(`[backfill] ${points.length.toLocaleString()} rows total -> ${OUT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
