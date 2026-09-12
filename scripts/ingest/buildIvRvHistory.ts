import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BarsPanel, alignedCloses } from "../../src/lib/research/barsPanel";
import {
  IV_TENOR_SESSIONS,
  IvRvPoint,
  buildIvRvPoint,
  logReturnsAligned,
  matchedLeg,
} from "../../src/lib/research/ivRv";
import {
  ResolutionSchedule,
  buildResolutionSchedule,
  scheduleReading,
} from "../../src/lib/research/ivRvSchedule";

/**
 * IMPLIED AGAINST REALIZED — regenerated every night, stored by nobody.
 *
 * ── Why this is DERIVED and not an append-only store ──────────────────
 *
 * Both inputs are already committed. `positioningHistory.json` carries the
 * implied number — which is the perishable half, since CBOE's delayed chain
 * has no date parameter and a session not recorded there is gone for good.
 * `barsPanel.json` carries the closes. Everything below is a join and some
 * arithmetic over those two.
 *
 * So a third store would add nothing but a way for the three to disagree, and
 * a reconstruction problem the moment the arithmetic changed. This artefact is
 * a PROJECTION: delete it and the next run rebuilds it identically. The same
 * reasoning as positioningLatest.json, for the same reason.
 *
 * The consequence worth stating: the forward leg of an observation resolves
 * whenever the bars reach far enough, retroactively, on whatever run happens
 * to notice. There is no resolution job to forget to run and no partial state
 * to repair, because there is no state.
 *
 * ── What this deliberately does NOT do ────────────────────────────────
 *
 * No threshold, no ranking, no "IV/RV below 0.85 fires". Eight sessions of
 * constant-maturity implied vol exist as of 2026-09-10 and not one forward
 * leg has resolved. A screen built now would be a threshold chosen by eye
 * from a single remembered trade, dressed as a signal — and once it is on a
 * page somebody trades it.
 *
 * The collector runs first and earns the right to a screen later. What
 * decides it is `forwardRatio` accumulating enough resolved observations to
 * separate from noise, judged against the effective breadth of the panel
 * rather than its row count: ~70 names on one night are not 70 bets, because
 * implied vol across a universe this correlated moves largely as one factor.
 *
 *   npx tsx scripts/ingest/buildIvRvHistory.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");
const POSITIONING = path.join(ROOT, "src", "data", "positioningHistory.json");
const BARS = path.join(ROOT, "src", "data", "barsPanel.json");
const OUT = path.join(ROOT, "src", "data", "ivRvHistory.json");

interface PositioningPoint {
  date: string;
  symbol: string;
  ivConstantMaturityPct?: number | null;
  atmIvDaysToExpiry?: number | null;
}

export interface IvRvHistory {
  version: 1;
  generatedAt: number;
  /** Sessions the forward leg is measured over — the tenor IV is quoted at. */
  horizonSessions: number;
  /** Counts, so a shrinking join is visible without diffing the rows. */
  coverage: {
    ivRows: number;
    joined: number;
    resolved: number;
    /** IV rows whose date is not a session in the bars panel, so unjoinable. */
    unjoinableDates: string[];
    /** IV rows whose symbol the bars panel does not carry. */
    unjoinableSymbols: string[];
  };
  /**
   * When this collector can first say anything. Computed here rather than on
   * the page because only this script holds the panel calendar every forward
   * window is counted against.
   */
  schedule: ResolutionSchedule;
  /** One sentence generated FROM `schedule`, so the two cannot disagree. */
  reading: string;
  points: IvRvPoint[];
}

function main(): void {
  const positioning = JSON.parse(fs.readFileSync(POSITIONING, "utf8")) as {
    points: PositioningPoint[];
  };
  const bars = JSON.parse(fs.readFileSync(BARS, "utf8")) as BarsPanel;

  const sessionIndex = new Map(bars.sessions.map((d, i) => [d, i]));

  /*
   * Returns are computed ONCE per symbol and reused across that symbol's
   * observations. Recomputing per row would be the same arithmetic done
   * eighty times, and — more to the point — it is the shape in which a
   * per-row variation could creep in unnoticed.
   */
  const returnsBySymbol = new Map<string, (number | null)[]>();
  const returnsFor = (symbol: string): (number | null)[] | null => {
    if (!bars.symbols[symbol]) return null;
    let r = returnsBySymbol.get(symbol);
    if (!r) {
      r = logReturnsAligned(alignedCloses(bars, symbol));
      returnsBySymbol.set(symbol, r);
    }
    return r;
  };

  const withIv = positioning.points.filter(
    (p): p is PositioningPoint & { ivConstantMaturityPct: number } =>
      typeof p.ivConstantMaturityPct === "number" && p.ivConstantMaturityPct > 0
  );

  const points: IvRvPoint[] = [];
  /*
   * The panel index each observation was taken at, kept alongside the point
   * because the point does not carry it. The schedule needs it to know how
   * much of each forward window has elapsed, and recovering it later by
   * looking the date back up would be the same join done twice.
   */
  const scheduleObs: { sessionIndex: number; resolved: boolean }[] = [];
  const unjoinableDates = new Set<string>();
  const unjoinableSymbols = new Set<string>();

  for (const row of withIv) {
    const idx = sessionIndex.get(row.date);
    if (idx === undefined) {
      /*
       * An implied reading stamped on a date the panel has no session for.
       * Refused rather than snapped to the nearest session: pairing an
       * implied number with a different day's realized move is a silent
       * one-session look-ahead in whichever direction the calendar happens to
       * be off, and it would be invisible in the output.
       */
      unjoinableDates.add(row.date);
      continue;
    }
    const returns = returnsFor(row.symbol);
    if (!returns) {
      unjoinableSymbols.add(row.symbol);
      continue;
    }
    const point = buildIvRvPoint({
      date: row.date,
      symbol: row.symbol,
      ivPct: row.ivConstantMaturityPct,
      ivTenorSessions: IV_TENOR_SESSIONS,
      returns,
      sessionIndex: idx,
      sessions: bars.sessions,
    });
    points.push(point);
    scheduleObs.push({ sessionIndex: idx, resolved: point.forwardRatio !== null });
  }

  points.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  const resolved = points.filter((p) => p.forwardRatio !== null).length;
  const schedule = buildResolutionSchedule({
    observations: scheduleObs,
    horizonSessions: IV_TENOR_SESSIONS,
    sessions: bars.sessions,
  });
  const out: IvRvHistory = {
    version: 1,
    generatedAt: Date.now(),
    horizonSessions: IV_TENOR_SESSIONS,
    schedule,
    reading: scheduleReading(schedule),
    coverage: {
      ivRows: withIv.length,
      joined: points.length,
      resolved,
      unjoinableDates: [...unjoinableDates].sort(),
      unjoinableSymbols: [...unjoinableSymbols].sort(),
    },
    points,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0));

  const matched = points.map(matchedLeg).filter((m): m is NonNullable<typeof m> => m !== null);
  const withRatio = matched.filter((m) => m.ratio !== null).length;
  const dates = [...new Set(points.map((p) => p.date))];

  console.log(`[iv/rv] ${withIv.length} implied readings -> ${points.length} joined`);
  console.log(`  sessions        ${dates.length} (${dates[0] ?? "-"} .. ${dates[dates.length - 1] ?? "-"})`);
  console.log(`  symbols         ${new Set(points.map((p) => p.symbol)).size}`);
  console.log(`  trailing ratio  ${withRatio} of ${points.length} computable at the matched ${IV_TENOR_SESSIONS}-session window`);
  console.log(
    `  forward leg     ${schedule.resolved} resolved, ${schedule.pending} pending, ` +
      `${schedule.unresolvable} lost to gaps`
  );
  if (schedule.sessionsUntilNextResolution !== null) {
    console.log(
      `  next landing    ${schedule.nextResolutionCount} rows in ` +
        `${schedule.sessionsUntilNextResolution} sessions ` +
        `(projected ${schedule.projectedNextResolution ?? `— ${schedule.projectionNote}`})`
    );
  }
  if (unjoinableDates.size) console.log(`  unjoinable dates   ${[...unjoinableDates].join(", ")}`);
  if (unjoinableSymbols.size) console.log(`  unjoinable symbols ${[...unjoinableSymbols].join(", ")}`);
  /*
   * The line that says how far away an answer is. Printed from the same
   * `reading` the page renders, rather than written twice — a console message
   * and a UI string that disagree is how the log stops being worth reading.
   */
  console.log(`  ${out.reading}`);
  console.log(`[iv/rv] wrote ${OUT}`);
}

main();
