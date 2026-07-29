"use client";

import { useQuery } from "@tanstack/react-query";
import { AssetSymbol, LocalHistoryPoint } from "@/types/market";

const POLL_MS = Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS ?? 15_000);

export interface HistoryPayload {
  history: LocalHistoryPoint[];
  historyHours: number;
}

async function fetchHistory(asset: AssetSymbol | "MARKET"): Promise<HistoryPayload> {
  const res = await fetch(`/api/history?asset=${asset}`);
  if (!res.ok) throw new Error(`History request failed (${res.status})`);
  return res.json();
}

/**
 * Recorded history, fetched independently of the main market payload.
 *
 * This resolves in milliseconds (one local file read) while `useMarketData`
 * is still waiting on exchanges, which is what lets the chart draw straight
 * away instead of last. See app/api/history/route.ts.
 */
export function useHistory(asset: AssetSymbol | "MARKET") {
  return useQuery({
    queryKey: ["history", asset],
    queryFn: () => fetchHistory(asset),
    refetchInterval: POLL_MS,
    // History only grows every 5 minutes, so refetching on every focus
    // change would be pure noise.
    refetchOnWindowFocus: false,
    staleTime: POLL_MS,
  });
}
