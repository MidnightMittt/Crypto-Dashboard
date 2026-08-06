"use client";

import { useQuery } from "@tanstack/react-query";
import { AssetComposites } from "@/lib/exchanges/assetComposites";

/**
 * Polls at 90s, not useMarketData's 15s — this data only changes server-side
 * every 5 minutes (assetComposites.ts's COMPOSITE_CACHE), so a matching
 * 15s poll would just re-fetch the same cached payload 20x for nothing.
 */
const POLL_MS = 90_000;

async function fetchAssetComposites(): Promise<AssetComposites> {
  const res = await fetch("/api/asset-composites");
  if (!res.ok) throw new Error(`Asset composites request failed (${res.status})`);
  return res.json();
}

export function useAssetComposites() {
  return useQuery({
    queryKey: ["asset-composites"],
    queryFn: fetchAssetComposites,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  });
}
