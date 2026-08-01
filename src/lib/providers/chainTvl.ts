import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * DeFi TVL by chain — DefiLlama api.llama.fi, free, keyless, no rate limit
 * on normal traffic. Same company/infra as providers/stablecoins.ts
 * (stablecoins.llama.fi) — NOT the same, paywalled yields.llama.fi/perps
 * endpoint that providers/defillama.ts had to self-disable.
 *
 * Informational, not a sentiment signal — no lean/gauge.
 */
const URL = "https://api.llama.fi/v2/chains";
const CACHE_MS = 15 * 60_000; // TVL doesn't move fast enough to need tighter caching
const TOP_N = 5;

export interface ChainTvl {
  chain: string;
  tvlUsd: number;
}

export interface ChainTvlSummary {
  top: ChainTvl[];
  updatedAt: number;
}

interface LlamaChainRow {
  name?: string;
  tvl?: number;
}

let cache: { summary: ChainTvlSummary | null; fetchedAt: number } | null = null;

export async function fetchChainTvlSummary(): Promise<ChainTvlSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.summary;

  try {
    const res = await fetch(URL, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`DefiLlama chains HTTP ${res.status}`);

    const rows = (await res.json()) as LlamaChainRow[];
    const top = rows
      .filter((r): r is Required<LlamaChainRow> => typeof r.name === "string" && typeof r.tvl === "number" && r.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, TOP_N)
      .map((r) => ({ chain: r.name, tvlUsd: r.tvl }));

    if (top.length === 0) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    const summary: ChainTvlSummary = { top, updatedAt: Date.now() };
    cache = { summary, fetchedAt: Date.now() };
    return summary;
  } catch (err) {
    console.warn("[chain-tvl] fetch failed:", err);
    return null;
  }
}
