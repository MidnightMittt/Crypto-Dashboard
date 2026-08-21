import { NextResponse } from "next/server";
import { assessSweepLiveness } from "@/lib/watch/heartbeat";
import { loadSweeps } from "@/lib/watch/heartbeatStore";

/**
 * GET /api/watch/health — is the watchdog watching?
 *
 * Deliberately UNAUTHENTICATED, unlike the sweep itself. The sweep is guarded
 * because it does work and can fire alerts; this only reports whether that
 * happened. A liveness check that needs the same secret as the thing it
 * monitors cannot be run by whoever is trying to find out why the alerts went
 * quiet — which is exactly when it is needed.
 *
 * It exposes no level, no symbol and no price. Counts and timestamps only.
 *
 * The four answers are distinct on purpose, because they were previously one
 * silence: never_ran / silent / blind / watching.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const sweeps = await loadSweeps();
  const liveness = assessSweepLiveness(sweeps);

  return NextResponse.json(
    {
      health: liveness.health,
      last_swept_at: liveness.lastSweptAt,
      minutes_since_sweep: liveness.minutesSinceSweep,
      armed: liveness.armed,
      fired_in_retained_record: liveness.firedRecently,
      sweeps_retained: sweeps.length,
      sentence: liveness.sentence,
    },
    {
      /*
       * 503 when the watchdog is not watching, so an uptime checker pointed
       * here fails without having to parse the body. A monitor that always
       * answers 200 is a monitor nobody notices.
       */
      status: liveness.health === "watching" ? 200 : 503,
    }
  );
}
