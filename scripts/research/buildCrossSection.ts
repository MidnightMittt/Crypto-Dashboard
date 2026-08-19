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
import { EQUITY_PANEL } from "../../src/lib/markets/equityPanel";
import {
  EMPTY_UNIVERSE_HISTORY,
  UniverseExclusion,
  UniverseHistory,
  appendSnapshots,
  membershipChange,
  snapshot,
  snapshotAsOf,
} from "../../src/lib/history/universeHistory";

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

/** Append-only membership log. Never rewritten, never backfilled. */
const UNIVERSE_OUT = path.join(__dirname_, "..", "..", "src", "data", "universeHistory.json");

/**
 * Names the composition each row describes. A future second panel gets its own
 * id and its own rows rather than changing what past rows meant.
 */
const PANEL_ID = "equity_panel_v1";

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
    /*
     * WHAT THE PANEL WAS SUPPOSED TO BE, beside what it turned out to be.
     *
     * A ranked count alone is unanchored: 86 could mean the panel, or the
     * panel minus nine names whose bar files were absent on whichever
     * machine ran last. Same code, same day, a quietly different reference
     * set — and a ticker's rank is measured against it. Recording the
     * declared size and naming the absentees makes a partial ingest visible
     * instead of something a reader would have to infer from a number they
     * have no baseline for.
     */
    declaredInstruments: EQUITY_PANEL.length,
    missingInstruments: load.missing,
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

  /*
   * THE POINT-IN-TIME UNIVERSE, appended here rather than in a separate step.
   *
   * The row must describe the ranking that was actually produced, and the only
   * way to guarantee that is to write it from the same variables, in the same
   * run. A second job re-deriving membership could drift from this one and
   * nobody would be able to tell which was right — the same reasoning that
   * keeps recordPositioning on the dossier's own provider functions.
   *
   * The artifact above stores COUNTS (86 ranked, 95 declared, 9 corrupt) and
   * is overwritten daily, so it can say how many but never who, and only for
   * today. That gap is the survivorship problem in miniature.
   */
  const day = new Date(asOf).toISOString().slice(0, 10);
  const exclusions: UniverseExclusion[] = [
    ...excluded.map((e) => ({ symbol: e.symbol, reason: "corrupt_bars" as const })),
    ...stale.map((symbol) => ({ symbol, reason: "stale_series" as const })),
    ...tooShort.map((symbol) => ({ symbol, reason: "short_history" as const })),
    ...load.missing.map((symbol) => ({ symbol, reason: "missing_from_ingest" as const })),
  ];
  const today = snapshot({
    date: day,
    panel: PANEL_ID,
    declared: EQUITY_PANEL,
    ranked: members.map((m) => m.symbol),
    excluded: exclusions,
  });

  const history: UniverseHistory = fs.existsSync(UNIVERSE_OUT)
    ? (JSON.parse(fs.readFileSync(UNIVERSE_OUT, "utf8")) as UniverseHistory)
    : EMPTY_UNIVERSE_HISTORY;
  const previous = snapshotAsOf(history.snapshots, day, PANEL_ID);
  const snapshots = appendSnapshots(history.snapshots, [today]);
  fs.writeFileSync(
    UNIVERSE_OUT,
    // Compact, matching positioningHistory and spreadHistory: this file grows
    // by a row every session forever and is read by machines, not people.
    JSON.stringify({ version: 1, generatedAt: Date.now(), snapshots } satisfies UniverseHistory, null, 0)
  );

  /*
   * Churn is printed, not just stored. Most days it is empty, and the day it
   * is not is the day a cross-sectional result changed meaning — which should
   * be visible in a run log rather than discovered later in a diff.
   */
  if (previous && previous.date !== day) {
    const change = membershipChange(previous, today);
    const parts = [
      change.addedToPanel.length ? `panel +${change.addedToPanel.join(",")}` : null,
      change.removedFromPanel.length ? `panel -${change.removedFromPanel.join(",")}` : null,
      change.droppedFromRanking.length ? `dropped ${change.droppedFromRanking.join(",")}` : null,
      change.returnedToRanking.length ? `returned ${change.returnedToRanking.join(",")}` : null,
    ].filter(Boolean);
    console.log(
      `[universe] ${day} vs ${previous.date} — ${parts.length ? parts.join(" · ") : "unchanged"}`
    );
  }
  console.log(
    `[universe] ${snapshots.length} session(s) recorded — ` +
      `${today.ranked.length} ranked of ${today.declared.length} declared -> ${UNIVERSE_OUT}`
  );

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
