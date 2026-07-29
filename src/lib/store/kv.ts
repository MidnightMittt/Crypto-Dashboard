import { Redis } from "@upstash/redis";

/**
 * Shared key-value storage, with a filesystem fallback.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * Two problems, one cause: serverless instances share nothing.
 *
 * 1. INCONSISTENT RESPONSES. The aggregate cache lived in module-level
 *    memory, so every instance held its own copy. Polling the deployed site
 *    returned 25 venues or 16 depending on which instance answered, and the
 *    long/short gauge flickered as OKX dropped in and out.
 *
 * 2. NO HISTORY. The time-series store wrote JSON to `.data/`, and Vercel's
 *    filesystem is ephemeral — every write vanished between invocations. The
 *    chart read "Collecting history" forever and the OI percentile had no
 *    local series to fall back on.
 *
 * Redis fixes both because it is genuinely shared and genuinely persistent.
 *
 * ── Configuration ──────────────────────────────────────────────────────
 *
 * Provision an Upstash database from the Vercel Marketplace and the
 * credentials are injected automatically. Both naming conventions are
 * accepted because Vercel's integration has used each at different times:
 *
 *   KV_REST_API_URL / KV_REST_API_TOKEN              (Vercel KV style)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash native)
 *
 * With neither set, every function here returns null and callers fall back
 * to the filesystem. That keeps local development working with no setup,
 * which is the whole reason the fallback is worth its complexity.
 */

function credentials(): { url: string; token: string } | null {
  const url =
    process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token =
    process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

let client: Redis | null = null;

function redis(): Redis | null {
  if (client) return client;
  const creds = credentials();
  if (!creds) return null;
  client = new Redis(creds);
  return client;
}

export function kvConfigured(): boolean {
  return credentials() !== null;
}

/**
 * Read a value. Returns null when unset, unconfigured, or unreachable —
 * callers treat all three the same way, because a cache miss and a broken
 * cache should both degrade to "compute it" rather than to an error.
 */
export async function kvGet<T>(key: string): Promise<T | null> {
  const r = redis();
  if (!r) return null;
  try {
    // The Upstash client parses JSON automatically on the way out.
    return (await r.get<T>(key)) ?? null;
  } catch (err) {
    console.warn(`[kv] get failed for "${key}":`, err);
    return null;
  }
}

/**
 * Write a value. `ttlSeconds` omitted means store indefinitely, which is what
 * the history series need — they are storage, not cache, and must not be
 * evicted.
 *
 * Never throws: a failed write must not break a response that is otherwise
 * fine. Worst case the value is recomputed next time.
 */
export async function kvSet<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    if (ttlSeconds && ttlSeconds > 0) await r.set(key, value, { ex: ttlSeconds });
    else await r.set(key, value);
  } catch (err) {
    console.warn(`[kv] set failed for "${key}":`, err);
  }
}
