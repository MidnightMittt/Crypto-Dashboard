/**
 * Bounded-concurrency map.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * The aggregator used `Promise.all(venues.map(...))`, which fires every
 * adapter at the same instant — 23 of them, to 23 different hosts. On a warm
 * process that's fine. On a cold one it means 23 simultaneous DNS lookups and
 * TLS handshakes competing for the same socket budget, and enough of them
 * exceed the per-request deadline that the dashboard comes back with a third
 * of its venues.
 *
 * This was measured, not assumed: the same commit returned 10 venues on the
 * first two polls with 10 TimeoutErrors logged, then 24 once warm, with no
 * code change in between. The same endpoints answered `curl` in under a
 * second throughout. So the problem was never how MANY venues there are — it
 * was how many were dialled at once.
 *
 * Capping concurrency gives each request room inside its deadline without
 * dropping a single venue. Total wall time rises slightly on a warm process,
 * which costs nothing here because the result is served from cache.
 *
 * Order of results matches order of input, so callers can still zip them
 * against their inputs.
 */

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * How many exchange adapters may be in flight at once.
 *
 * 8 is a compromise: high enough that a warm fan-out finishes in roughly the
 * time of its slowest member, low enough that a cold process isn't opening
 * two dozen connections simultaneously.
 */
export const ADAPTER_CONCURRENCY = envInt("ADAPTER_CONCURRENCY", 8);

/**
 * How many assets whole-market mode processes at once.
 *
 * MARKET is the worst case — it fans out across all ten assets. Unbounded,
 * that's 10 x 23 = 230 concurrent requests, which is exactly the burst that
 * makes cold starts collapse. Three assets x 8 adapters caps it near 24.
 */
export const ASSET_CONCURRENCY = envInt("ASSET_CONCURRENCY", 3);

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;

  // Each worker pulls the next index until the queue is drained. Simpler and
  // more even than pre-slicing into chunks, where one slow item would idle
  // the rest of its chunk's slot.
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
