import { AssetSymbol, ExchangeSnapshot } from "@/types/market";

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
    // These run in Next.js route handlers (server-side), so there's no CORS
    // concern. A short revalidate window keeps us well inside exchange rate
    // limits without the data going stale.
    next: { revalidate: 5 },
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
