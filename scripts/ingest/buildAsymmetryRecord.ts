import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { BarsPanel } from "../../src/lib/research/barsPanel";
import {
  ASYMMETRY_SCREEN_DECLARATION,
  buildAsymmetryObservations,
  evaluateAsymmetryScreen,
} from "../../src/lib/research/asymmetryScreen";

/**
 * THE ASYMMETRY FORWARD RECORD — a nightly projection of the bars panel.
 *
 * Same storage argument as ivRvHistory: the only input is committed
 * (`barsPanel.json`), so this artifact is a projection — delete it and the
 * next run rebuilds it identically, forward legs resolve retroactively on
 * whatever run notices the bars reach far enough, and there is no
 * resolution job to forget.
 *
 * The one thing a projection cannot be trusted with is the declaration
 * boundary, because every "observation" before 2026-09-14 is equally
 * computable and none of it is forward evidence. The boundary is enforced
 * in `buildAsymmetryObservations` (the library, not this wrapper) and
 * re-checked in `evaluateAsymmetryScreen`, so neither this script nor a
 * future caller can backfill by accident.
 *
 * generatedAt moves on EVERY run, including runs that add nothing — the
 * stamp is the liveness heartbeat, and a "nothing changed" guard would
 * make the stale-artifact banner cry wolf.
 *
 *   npx tsx scripts/ingest/buildAsymmetryRecord.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");
const BARS = path.join(ROOT, "src", "data", "barsPanel.json");
const OUT = path.join(ROOT, "src", "data", "asymmetryForward.json");

const panel = JSON.parse(fs.readFileSync(BARS, "utf8")) as BarsPanel;
const d = ASYMMETRY_SCREEN_DECLARATION;

const built = buildAsymmetryObservations(panel, d.declaredOn);
const standing = evaluateAsymmetryScreen(built);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: Date.now(),
      declaration: {
        id: d.id,
        declaredOn: d.declaredOn,
        horizonSessions: d.horizonSessions,
      },
      sessions: built.sessions,
      observations: built.observations,
      excludedInterpolatedBySession: built.excludedInterpolatedBySession,
    },
    null,
    1
  )
);

const resolved = built.observations.filter((o) => o.status === "resolved").length;
const pending = built.observations.filter((o) => o.status === "pending").length;
console.log(
  `asymmetry forward record: ${built.sessions.length} eligible sessions since ${d.declaredOn}, ` +
    `${built.observations.length} observations (${resolved} resolved, ${pending} pending)`
);
console.log(standing.reading);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
