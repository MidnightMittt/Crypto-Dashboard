"use client";

import { useQuery } from "@tanstack/react-query";
import { AggregateMarketData, AssetSymbol, FearGreed } from "@/types/market";

const POLL_MS = Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS ?? 15_000);

export interface MarketPayload {
  aggregate: AggregateMarketData;
  /** Market-wide spot sentiment, for contrast with our leverage index. */
  fearGreed: FearGreed | null;
  meta: { generatedAt: number };
}

async function fetchMarket(asset: AssetSymbol | "MARKET"): Promise<MarketPayload> {
  const res = await fetch(`/api/market-data?asset=${asset}`);
  if (!res.ok) throw new Error(`Market data request failed (${res.status})`);
  return res.json();
}

export function useMarketData(asset: AssetSymbol | "MARKET") {
  return useQuery({
    queryKey: ["market-data", asset],
    queryFn: () => fetchMarket(asset),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: POLL_MS / 2,
  });
}
