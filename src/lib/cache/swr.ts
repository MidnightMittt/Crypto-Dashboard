/**
 * Stale-while-revalidate memo for server-side aggregation.
 *
 * WHY THIS EXISTS: the dashboard polls every 15s, and each poll used to
 * re-run the entire fan-out — 13 exchange adapters plus 3 aggregator
 * providers, per asset. Two browser tabs doubled that; whole-market mode
 * multiplied it by ten. Coinalyze allows 40 calls/minute, so duplicate work
 * wasn't just slow, it actively burned the budget that long/short ratios
 * depend on.
 *
 * Behaviour:
 *   fresh (< freshMs)    → cached value, no upstream call at all
 *   stale (< maxAgeMs)   → cached value returned IMMEDIATELY, refresh runs
 *                          in the background for the *next* caller
 *   missing or expired   → await a real fetch
 *
 * The stale branch is what makes polling feel instant: after the first load,
 * a request never waits on the network. It trades a few seconds of staleness
 * for a response time measured in microseconds, which is the right trade for
 * data that updates on an 8-hour funding cycle.
 *
 * In-flight requests are de-duplicated by key, so ten simultaneous tabs
 * trigger one upstream fan-out rather than ten.
 */

interface Entry<T> {
  value: T;
  fetchedAt: number;
  /** Set while a refresh is running, so concurrent callers share it. */
  inflight?: Promise<T>;
}

const store = new Map<string, Entry<unknown>>();

export interface SwrOptions {
  /** Below this age, serve cache and don't refresh at all. */
  freshMs: number;
  /** Above this age, the cache is unusable and callers must wait. */
  maxAgeMs: number;
}

export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  { freshMs, maxAgeMs }: SwrOptions
): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;
  const age = entry ? now - entry.fetchedAt : Infinity;

  if (entry && age < freshMs) return entry.value;

  const refresh = (): Promise<T> => {
    // Share a single in-flight refresh across concurrent callers.
    if (entry?.inflight) return entry.inflight;

    const p = fetcher()
      .then((value) => {
        store.set(key, { value, fetchedAt: Date.now() });
        return value;
      })
      .catch((err) => {
        // Keep serving the old value rather than emptying the dashboard.
        // Clearing `inflight` lets the next poll retry.
        if (entry) {
          store.set(key, { value: entry.value, fetchedAt: entry.fetchedAt });
          console.warn(`[swr] refresh failed for "${key}", serving stale:`, err);
          return entry.value;
        }
        store.delete(key);
        throw err;
      });

    store.set(key, {
      value: entry?.value as T,
      fetchedAt: entry?.fetchedAt ?? 0,
      inflight: p,
    });
    return p;
  };

  // Stale but usable: hand back the old value now, warm the cache behind it.
  if (entry && age < maxAgeMs) {
    void refresh().catch(() => {});
    return entry.value;
  }

  return refresh();
}

/** Drops a key (or everything). Used by tests and manual refresh. */
export function invalidate(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}
