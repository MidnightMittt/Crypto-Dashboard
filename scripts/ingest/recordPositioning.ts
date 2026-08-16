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
import { fetchOptionsSummary } from "../../src/lib/dossier/providers/cboeOptions";
import { fetchShortVolume } from "../../src/lib/dossier/providers/finraShortVolume";
import { EQUITY_PANEL } from "../../src/lib/markets/equityPanel";
import { resolveUniverse } from "../../src/lib/markets/scannerUniverse";
import { adjustForCorporateActions } from "../../src/lib/research/corporateActions";
import { atrPctSeries } from "../../src/lib/technicals/indicators";
import { Bar } from "../../src/lib/research/types";

/**
 * TODAY'S POSITIONING, recorded so it can be tested later.
 *
 * Net dealer gamma, short-sale volume share, put/call ratios and ATM implied
 * vol are rendered on every dossier as point-in-time values with no past.
 * This job gives them one, by appending a row per symbol per session.
 *
 * ── Recorded, never recomputed ────────────────────────────────────────
 *
 * Every figure comes from the SAME provider functions the ticker page calls
 * — fetchOptionsSummary and fetchShortVolume — rather than a second
 * computation that could drift from what was displayed. This is the rule the
 * signal ledger and the forward record already follow: a history is only
 * evidence if it records what was actually shown.
 *
 * ── What can and cannot be backfilled ─────────────────────────────────
 *
 * CBOE's delayed chain has no date parameter. Gamma, put/call and ATM IV
 * begin the day this job first runs and can never be given a past. FINRA's
 * files are per-date and reach back years — see backfillShortVolume.ts, which
 * writes `origin: "backfill"` rows so the two are never confused.
 *
 * Run: npx tsx scripts/ingest/recordPositioning.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "positioningHistory.json");

/** Wilder ATR over 14, the same period the dossier's "typical daily move" uses. */
const ATR_PERIOD = 14;

/** Courtesy delay between symbols; both sources are free public endpoints. */
const THROTTLE_MS = 350;

function loadBars(symbol: string): Bar[] | null {
  const file = path.join(DATA_DIR, `${symbol}.US.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const bars: Bar[] = raw.bars ?? [];
  if (bars.length === 0) return null;
  // Same guard the replay applies — an ATR spanning an unadjusted action is wrong.
  return adjustForCorporateActions(bars, symbol).bars;
}

/**
 * The SAME function the dossier's "typical daily move" reads, not a second
 * ATR. A history that quietly used a different estimator than the page would
 * be untestable against what the page actually claimed.
 */
function typicalDailyMovePct(bars: Bar[]): number | null {
  const series = atrPctSeries(bars, ATR_PERIOD);
  return series.length ? series[series.length - 1] : null;
}

async function main(): Promise<void> {
  const record: PositioningHistory = fs.existsSync(OUT)
    ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as PositioningHistory)
    : EMPTY_POSITIONING_HISTORY;

  const fresh: PositioningPoint[] = [];
  let optionsOk = 0;
  let shortOk = 0;

  /*
   * The declared panel PLUS the scanned names. They are different sets: APLD,
   * RIOT, CLSK, CORZ, IONQ and OKLO are traded but are not panel members, and
   * iterating the panel alone left the six highest-interest symbols with no
   * gamma, no short volume and no ATR — invisible until the pre-trade
   * endpoint returned nulls for the top-ranked name in the study.
   */
  const covered = [...new Set([...EQUITY_PANEL, ...resolveUniverse()])].sort();
  for (const symbol of covered) {
    const bars = loadBars(symbol);
    /*
     * The row is dated by the DATA's last session, not the wall clock. A run
     * at 22:15 UTC records the session that just closed, and a manual re-run
     * next morning lands on the SAME row rather than inventing a trading day.
     */
    const date = bars
      ? new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const [options, shortVol] = await Promise.all([
      fetchOptionsSummary(symbol).catch(() => ({ ok: false, reason: "threw" }) as const),
      fetchShortVolume(symbol).catch(() => ({ ok: false, reason: "threw" }) as const),
    ]);

    const gex = options.ok ? options.summary.netGexUsdPer1Pct : null;
    if (options.ok) optionsOk++;
    if (shortVol.ok) shortOk++;

    fresh.push({
      date,
      symbol,
      origin: "live",
      netGexUsdPer1Pct: gex,
      gammaSign: gex === null ? null : gex >= 0 ? "positive" : "negative",
      shortRatioPct: shortVol.ok ? shortVol.summary.latest.shortRatioPct : null,
      putCallOiRatio: options.ok ? options.summary.putCallOiRatio : null,
      putCallVolumeRatio: options.ok ? options.summary.putCallVolumeRatio : null,
      atmIvPct: options.ok ? options.summary.atmIvPct : null,
      atmIvDaysToExpiry: options.ok ? options.summary.atmIvDaysToExpiry : null,
      typicalDailyMovePct: bars ? typicalDailyMovePct(bars) : null,
    });

    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  const points = prunePoints(appendPoints(record.points, fresh));
  fs.writeFileSync(
    OUT,
    JSON.stringify({ version: 1, generatedAt: Date.now(), points } satisfies PositioningHistory, null, 0)
  );

  /*
   * Coverage is reported per SOURCE, not as one success count. A run where
   * CBOE refused every symbol and FINRA answered all of them is not "half
   * working" — it is one dead source, and the two numbers say so.
   */
  console.log(
    `[positioning] ${fresh.length} symbols — options ${optionsOk}/${fresh.length}, ` +
      `short volume ${shortOk}/${fresh.length}`
  );
  if (optionsOk === 0) console.log("[positioning] WARNING: no options data at all — CBOE may have changed or blocked.");
  if (shortOk === 0) console.log("[positioning] WARNING: no short volume at all — FINRA may have changed or blocked.");
  console.log(`[positioning] ${points.length} rows total -> ${OUT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
