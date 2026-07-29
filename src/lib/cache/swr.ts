import { kvConfigured, kvGet, kvSet } from "../store/kv";

/**
 * Stale-while-revalidate memo, shared across serverless instances.
 *
 * ── Why it needs two layers ────────────────────────────────────────────
 *
 * The dashboard polls every 15s and each poll would otherwise re-run the
 * whole fan-out — 20+ exchange adapters plus aggregator providers, per
 * asset. Coinalyze allows 40 calls/minute, so duplicate work doesn't just
 * cost latency, it burns the budget the long/short ratio depends on.
 *
 * The first version cached in module-level memory only. That works locally,
 * where there's one process, and fails on Vercel, where there are many:
 * every instance held its own copy, so the same URL returned 25 venues or 16
 * depending on which one answered and the gauges visibly flickered.
 *
 *   L1  in-memory   — microseconds, per instance, absorbs repeat polls
 *   L2  Redis       — ~50ms, SHARED, makes every instance agree
 *
 * L1 is checked first so the common case never pays a network hop. L2 is the
 * consistency layer: a cold instance reads what a warm one already computed
 * instead of rebuilding from scratch and possibly coming back short.
 *
 * Without Redis configured, L2 is skipped entirely and this behaves exactly
 * as it did before — correct locally, single-instance.
 */

interface Entry<T> {
  value: T;
  fetchedAt: number;
  /** Set while a refresh is running, so concurrent callers share it. */
  inflight?: Promise<T>;
}

/** What L2 stores. Kept flat so it survives JSON round-tripping. */
interface Stored<T> {
  value: T;
  fetchedAt: number;
}

const store = new Map<string, Entry<unknown>>();

export interface SwrOptions<T = unknown> {
  /** Below this age, serve cache and don't refresh at all. */
  freshMs: number;
  /** Above this age, the cache is unusable and callers must wait. */
  maxAgeMs: number;
  /**
   * Optional veto on writing a freshly computed value to the SHARED layer.
   *
   * A cold instance can legitimately produce a degraded result — some venues
   * miss their deadline while connections warm up. Publishing that to Redis
   * would hand every other instance the worse answer. This lets the caller
   * say "that one looks wrong, keep what we had", and the value is still
   * returned to the current request and kept in L1.
   */
  shouldShare?: (next: T, previous: T | null) => boolean;
}

export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  { freshMs, maxAgeMs, shouldShare }: SwrOptions<T>
): Promise<T> {
  const now = Date.now();
  const local = store.get(key) as Entry<T> | undefined;

  // L1 — fresh enough to answer with no network at all.
  if (local && now - local.fetchedAt < freshMs) return local.value;

  // L2 — what the other instances have. Consulted before recomputing so a
  // cold instance inherits a good answer rather than building its own.
  let shared: Stored<T> | null = null;
  if (kvConfigured()) {
    shared = await kvGet<Stored<T>>(`swr:${key}`);
    if (shared && Number.isFinite(shared.fetchedAt)) {
      const sharedAge = now - shared.fetchedAt;
      if (sharedAge < freshMs) {
        store.set(key, { value: shared.value, fetchedAt: shared.fetchedAt });
        return shared.value;
      }
    } else {
      shared = null;
    }
  }

  // Best value we currently hold, from either layer.
  const best: Entry<T> | null =
    local && shared
      ? local.fetchedAt >= shared.fetchedAt
        ? local
        : { value: shared.value, fetchedAt: shared.fetchedAt }
      : local ?? (shared ? { value: shared.value, fetchedAt: shared.fetchedAt } : null);

  const refresh = (): Promise<T> => {
    // Share a single in-flight refresh across concurrent callers.
    if (local?.inflight) return local.inflight;

    const p = fetcher()
      .then(async (value) => {
        const fetchedAt = Date.now();
        store.set(key, { value, fetchedAt });

        if (kvConfigured() && (!shouldShare || shouldShare(value, best?.value ?? null))) {
          // TTL matches maxAge so stale entries expire rather than linger.
          await kvSet(`swr:${key}`, { value, fetchedAt }, Math.ceil(maxAgeMs / 1000));
        }
        return value;
      })
      .catch((err) => {
        // Keep serving the old value rather than emptying the dashboard.
        if (best) {
          store.set(key, { value: best.value, fetchedAt: best.fetchedAt });
          console.warn(`[swr] refresh failed for "${key}", serving stale:`, err);
          return best.value;
        }
        store.delete(key);
        throw err;
      });

    store.set(key, {
      value: best?.value as T,
      fetchedAt: best?.fetchedAt ?? 0,
      inflight: p,
    });
    return p;
  };

  // Stale but usable: hand back what we have now, warm the cache behind it.
  if (best && now - best.fetchedAt < maxAgeMs) {
    void refresh().catch(() => {});
    return best.value;
  }

  return refresh();
}

/** Drops a key from the local layer. Used by tests and manual refresh. */
export function invalidate(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}
