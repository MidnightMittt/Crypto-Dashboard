import { kvConfigured, kvGet, kvSet } from "@/lib/store/kv";
import { SweepRecord } from "./heartbeat";

/**
 * The sweep's record of itself.
 *
 * Kept in the same KV the levels live in, because a heartbeat stored somewhere
 * the sweep might not reach would fail independently of the thing it reports
 * on — and a broken monitor that reports "never ran" about a working watchdog
 * is worse than no monitor.
 */

const KEY = "watch:sweeps:v1";

/**
 * Sweeps retained. At five staggered crons per hour this is roughly a day, so
 * the health endpoint can distinguish "quiet today" from "silent for a week"
 * without unbounded growth.
 */
export const MAX_SWEEPS = 300;

/** Newest last. Empty when nothing has ever run, or when KV is unconfigured. */
export async function loadSweeps(): Promise<SweepRecord[]> {
  if (!kvConfigured()) return [];
  return (await kvGet<SweepRecord[]>(KEY)) ?? [];
}

/**
 * Append one sweep, oldest dropped past the cap.
 *
 * Deliberately never throws. This is the sweep telling us it ran; if writing
 * that note fails, the sweep itself must still complete and still fire its
 * alerts. Losing the heartbeat costs visibility, but letting it abort the
 * sweep would cost the alert — the whole point of the system.
 */
export async function recordSweep(record: SweepRecord): Promise<void> {
  if (!kvConfigured()) return;
  try {
    const existing = await loadSweeps();
    await kvSet(KEY, [...existing, record].slice(-MAX_SWEEPS));
  } catch {
    // Intentionally swallowed. See above.
  }
}
