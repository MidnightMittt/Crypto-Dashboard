import { kvConfigured, kvGet, kvSet } from "@/lib/store/kv";
import { WatchLevel } from "./levels";

/**
 * WHERE ARMED LEVELS LIVE, and why it cannot be a file.
 *
 * Vercel's runtime filesystem is ephemeral — a write vanishes between
 * invocations, which is the exact defect kv.ts was built to fix for the
 * time-series store. A watchdog whose levels evaporate on the next cold start
 * would reproduce, inside this service, the failure it exists to prevent
 * outside it.
 *
 * So Redis, and Redis is not optional here. Every other consumer of kv.ts
 * degrades gracefully to a local fallback because losing a cache entry costs
 * a recomputation. Losing a disaster-stop costs a position. When Redis is not
 * configured this module REFUSES to accept a level rather than accepting one
 * it cannot keep — an agent told "armed" that is not armed is worse off than
 * one told "I cannot arm this".
 */

const KEY = "watch:levels:v1";

/** Guard against an unbounded store and against a runaway registration loop. */
export const MAX_LEVELS = 200;

export class WatchStoreUnavailable extends Error {
  constructor() {
    super(
      "Durable storage is not configured, so a level cannot be guaranteed to survive. " +
        "Set KV_REST_API_URL and KV_REST_API_TOKEN (Upstash via the Vercel Marketplace). " +
        "Refusing to accept a level this service cannot keep."
    );
    this.name = "WatchStoreUnavailable";
  }
}

export async function loadLevels(): Promise<WatchLevel[]> {
  if (!kvConfigured()) throw new WatchStoreUnavailable();
  return (await kvGet<WatchLevel[]>(KEY)) ?? [];
}

/**
 * Persist the full set.
 *
 * No TTL: a stop must not expire quietly. The store is bounded by MAX_LEVELS
 * and by explicit disarming, never by a clock — an alert that stops watching
 * because a key aged out is the silent failure this whole module refuses.
 */
export async function saveLevels(levels: WatchLevel[]): Promise<void> {
  if (!kvConfigured()) throw new WatchStoreUnavailable();
  await kvSet(KEY, levels);
}

/** Stable, sortable, and unique without a dependency. */
export function newId(now: Date, rand = Math.random): string {
  return `w_${now.getTime().toString(36)}_${Math.floor(rand() * 1e6).toString(36)}`;
}
