import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { timeoutSignal } from "../../net/timeout";

/**
 * The contract every adapter implements.
 *
 * Return `null` (don't throw) when the venue doesn't list the asset or the
 * call fails. The aggregator then excludes that venue entirely rather than
 * substituting an estimate — so a single flaky exchange never breaks the
 * dashboard, and never silently contaminates the aggregate numbers.
 *
 * Any field the venue doesn't publish should also be `null`, not a guess.
 */
export type LiveAdapter = (asset: AssetSymbol) => Promise<ExchangeSnapshot | null>;

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    // Every adapter routes through here, so this is the one place a deadline
    // needs to exist. Without it a geo-blocked venue can hang the socket
    // indefinitely and — because the aggregator uses Promise.all — hold the
    // whole dashboard on its skeleton. See lib/net/timeout.ts.
    signal: init?.signal ?? timeoutSignal(),
    // Next's data cache is deliberately bypassed. Caching is owned at a
    // higher level now — lib/cache/swr.ts for whole aggregates, plus each
    // adapter's own module cache — so Next's layer added nothing but a disk
    // write per response. Worse, it serialises those writes: under the
    // fan-out's concurrency the queue grew until requests blew their abort
    // deadline and every venue "timed out" at once, on responses that
    // complete in under a second when fetched directly.
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function safeNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}
