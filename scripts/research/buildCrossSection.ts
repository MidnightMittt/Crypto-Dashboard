import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  excludeCorruptSeries,
  indexAsOf,
  panelBreadth,
  ret,
} from "../../src/lib/research/signalLab";
import { describeLoad, loadEquityPanel } from "./loadPanel";

/**
 * TODAY'S CROSS-SECTION — the bridge from the validated study to one ticker.
 *
 * `momentum-12-1-long-only` is a CROSS-SECTIONAL claim: the top decile of a
 * ranked panel beats that panel. Nothing about it can be evaluated from one
 * instrument's bars alone, because "top decile" is a statement about where a
 * name sits relative to 127 others. So the dossier needs the panel's current
 * distribution, and it cannot read the panel directly: the bar files under
 * scripts/ingest/data are 146MB and gitignored, so a route reading them
 * would work locally and 500 in production — the worst failure shape there
 * is.
 *
 * This emits the small thing the runtime actually needs: the ranked
 * momentum distribution, the decile boundaries, and the breadth regime.
 *
 * ── Why the formulas are imported rather than rewritten ───────────────
 *
 * `ret`, `panelBreadth` and `excludeCorruptSeries` come from signalLab
 * itself. A second implementation of "12-1 momentum" here would be a second
 * definition of the thing that was validated, and the two would drift — the
 * exact defect the charter calls out as a single-source-of-truth violation.
 * The decile boundary likewise mirrors runHypothesis's k = floor(n × 0.1).
 *
 * ── The staleness this file is responsible for ────────────────────────
 *
 * Everything here is as of the panel's last bar, and the panel refreshes
 * only when someone runs the ingest. The consumer decides what to do about
 * that; this file's job is to state `asOf` truthfully so it can.
 *
 *   npm run study:cross-section
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "equityCrossSection.json");

/** Trailing window and skip, identical to the declared hypothesis. */
const LOOKBACK = 252;
const SKIP = 21;
/** Matches runHypothesis's DECILE. */
const DECILE = 0.1;
/**
 * An instrument whose last bar is further back than this has stopped
 * updating, and ranking it on a stale 12-month return would put a name in
 * the top decile on the strength of a year that ended months ago.
 */
const MAX_INSTRUMENT_STALENESS_MS = 10 * 86_400_000;


function main(): void {
  const load = loadEquityPanel();
  const { clean, excluded } = excludeCorruptSeries(load.series);
  if (clean.length === 0) throw new Error("no usable instruments");

  /*
   * The as-of date is the newest bar anywhere in the panel, and every
   * instrument is then read at or before it. A name that stopped updating
   * would otherwise contribute a year-old return to today's ranking, so
   * those are dropped and counted rather than quietly included.
   */
  const asOf = Math.max(...clean.map((s) => s.t[s.t.length - 1]));

  const members: Array<{ symbol: string; mom: number }> = [];
  const stale: string[] = [];
  const tooShort: string[] = [];

  for (const s of clean) {
    const i = indexAsOf(s.t, asOf);
    if (i < LOOKBACK + SKIP) {
      tooShort.push(s.symbol);
      continue;
    }
    if (asOf - s.t[i] > MAX_INSTRUMENT_STALENESS_MS) {
      stale.push(s.symbol);
      continue;
    }
    const mom = ret(s, i - LOOKBACK, i - SKIP);
    if (mom === null || !Number.isFinite(mom)) continue;
    members.push({ symbol: s.symbol, mom });
  }

  members.sort((a, b) => b.mom - a.mom);
  const k = Math.max(1, Math.floor(members.length * DECILE));

  const breadthPct = panelBreadth(clean, asOf);

  const artifact = {
    generatedAt: Date.now(),
    /** Last session in the panel. Everything below is measured at this date. */
    asOf,
    instruments: members.length,
    excludedForCorruptBars: excluded.length,
    excludedForStaleness: stale,
    excludedForShortHistory: tooShort.length,
    lookbackSessions: LOOKBACK,
    skipSessions: SKIP,
    decileSize: k,
    /**
     * A name at or above `topCut` would enter the long decile; at or below
     * `bottomCut` it would enter the short one. Boundaries rather than a
     * membership list, because the dossier scores tickers that are not in
     * this panel at all.
     */
    topCut: members[k - 1].mom,
    bottomCut: members[members.length - k].mom,
    /** Share of the panel above its own 200-session average, at `asOf`. */
    breadthPct,
    members,
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));

  console.log(`Cross-section as of ${new Date(asOf).toISOString().slice(0, 10)}`);
  console.log(`  panel           ${describeLoad(load)}`);
  console.log(`  ranked          ${members.length} instruments (decile = ${k})`);
  console.log(`  excluded        ${excluded.length} corrupt, ${stale.length} stale, ${tooShort.length} short`);
  if (stale.length) console.log(`    stale: ${stale.join(", ")}`);
  console.log(`  top decile cut  ${(artifact.topCut * 100).toFixed(1)}% trailing 12-1 return`);
  console.log(`  bottom cut      ${(artifact.bottomCut * 100).toFixed(1)}%`);
  console.log(
    `  breadth         ${breadthPct === null ? "unavailable" : (breadthPct * 100).toFixed(1) + "% above 200-session average"}`
  );
  console.log(`  long leg        ${members.slice(0, k).map((m) => m.symbol).join(", ")}`);
  console.log(`\n[cross-section] wrote ${OUT}`);
}

main();
