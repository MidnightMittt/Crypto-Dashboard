import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PositioningHistory, PositioningPoint } from "../../src/lib/history/positioningHistory";

/**
 * REMOVE OPTIONS READINGS FILED UNDER A SESSION THEY DO NOT DESCRIBE.
 *
 * The recorder took its session date from the PRICE bar while options carried
 * their own, later vendor instant. Whenever the bar ingest lagged, today's
 * chain was written under a stale price date — so a row dated 2026-08-14
 * holds gamma, put/call and implied vol captured on 2026-08-19. The
 * newest-session guard in recordPositioning.ts stops this recurring; these
 * rows predate it.
 *
 * The damage is not cosmetic. 34 of 60 symbols carried the SAME implied-vol
 * number under two different dates, so any percentile over that series would
 * have ranked a value against a duplicate of itself and reported a sample
 * size nearly twice its real one.
 *
 * ── What is removed, and what is deliberately kept ────────────────────
 *
 * Only the OPTIONS group, and only where the vendor instant belongs to a
 * different session. Price, short volume, street and social are untouched:
 * they carry their own instants and were never mis-filed.
 *
 * A gap of +1 day is KEPT. The job runs at 22:15 UTC and a run drifting past
 * midnight stamps the chain on the following UTC date while still describing
 * that session's close — legitimate, and 2 rows here are exactly that. The
 * corrupt rows sit at -1, +3, +4 and +5 days, which no scheduling jitter
 * explains.
 *
 * Nothing is invented. Removed fields become null with the reason recorded
 * in this file's own history: the observation existed, but not on that day,
 * and a null is the honest shape for a measurement we do not have.
 *
 *   npx tsx scripts/ingest/repairMisdatedOptions.ts [--dry-run]
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname_, "..", "..", "src", "data", "positioningHistory.json");

/** Days of drift a late-running job can legitimately produce. */
const MAX_LEGITIMATE_GAP_DAYS = 1;

/** The fields observed in one CBOE chain read. They travel together or not at all. */
const OPTIONS_FIELDS = [
  "netGexUsdPer1Pct",
  "gammaSign",
  "putCallOiRatio",
  "putCallVolumeRatio",
  "atmIvPct",
  "atmIvDaysToExpiry",
  "chainOi",
] as const;

const dayGap = (asOf: string, sessionDate: string): number =>
  Math.round(
    (Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${sessionDate}T00:00:00Z`)) / 86_400_000
  );

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const store = JSON.parse(fs.readFileSync(STORE, "utf8")) as PositioningHistory;

  let repaired = 0;
  const byGap = new Map<number, number>();

  const points: PositioningPoint[] = store.points.map((p) => {
    const asOf = p.sourceAsOf?.options;
    if (!asOf) return p;

    const gap = dayGap(asOf, p.date);
    if (gap >= 0 && gap <= MAX_LEGITIMATE_GAP_DAYS) return p;
    if (!OPTIONS_FIELDS.some((f) => p[f] !== null && p[f] !== undefined)) return p;

    repaired++;
    byGap.set(gap, (byGap.get(gap) ?? 0) + 1);

    /*
     * Named explicitly rather than looped over a string list. A cast to an
     * index signature would compile even if a field were renamed, silently
     * leaving the stale value in place — and a repair that quietly misses
     * what it claims to remove is worse than no repair.
     */
    const cleaned: PositioningPoint = {
      ...p,
      netGexUsdPer1Pct: null,
      gammaSign: null,
      putCallOiRatio: null,
      putCallVolumeRatio: null,
      atmIvPct: null,
      atmIvDaysToExpiry: null,
      chainOi: null,
    };
    /*
     * The instant goes with the values it described. Leaving it would assert
     * provenance for fields that no longer exist — the precise confusion this
     * repair removes.
     */
    if (cleaned.sourceAsOf) {
      const { options: _dropped, ...rest } = cleaned.sourceAsOf;
      cleaned.sourceAsOf = rest;
    }
    return cleaned;
  });

  const kept = points.filter((p) => p.atmIvPct !== null && p.atmIvPct !== undefined).length;

  console.log(
    `[repair] ${repaired} row(s) had options filed under a session they do not describe` +
      (repaired ? `: ${[...byGap].sort((a, b) => a[0] - b[0]).map(([g, c]) => `${g > 0 ? "+" : ""}${g}d x${c}`).join(", ")}` : "")
  );
  console.log(`[repair] ${kept} row(s) retain an implied-vol reading taken on their own session.`);

  if (dryRun) {
    console.log("[repair] --dry-run: nothing written.");
    return;
  }
  if (repaired === 0) {
    console.log("[repair] nothing to do — the store is already clean.");
    return;
  }

  fs.writeFileSync(
    STORE,
    JSON.stringify({ ...store, generatedAt: Date.now(), points } satisfies PositioningHistory, null, 0)
  );
  console.log(`[repair] written -> ${STORE}`);
}

main();
