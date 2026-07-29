import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// Hyperliquid info endpoint — single POST, no key required.
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
const BASE = "https://api.hyperliquid.xyz/info";

interface AssetCtx {
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  markPx: string;
  prevDayPx: string;
}

type MetaAndAssetCtxs = [{ universe: Array<{ name: string }> }, AssetCtx[]];

let cache: { data: MetaAndAssetCtxs; fetchedAt: number } | null = null;

/** Returns the entire market in one call — cache briefly to avoid refetching per asset. */
async function getMetaAndCtxs(): Promise<MetaAndAssetCtxs> {
  if (cache && Date.now() - cache.fetchedAt < 5_000) return cache.data;
  const data = await fetchJson<MetaAndAssetCtxs>(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  cache = { data, fetchedAt: Date.now() };
  return data;
}

export async function fetchHyperliquid(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const [meta, ctxs] = await getMetaAndCtxs();
    const idx = meta.universe.findIndex((u) => u.name === asset);
    if (idx === -1) return null;
    const ctx = ctxs[idx];
    if (!ctx) return null;

    const price = safeNumber(ctx.markPx);
    if (!price) return null;
    const prevPx = safeNumber(ctx.prevDayPx);

    return {
      exchangeId: "hyperliquid",
      asset,
      // Hyperliquid funding is published as an hourly rate.
      fundingRatePct: safeNumber(ctx.funding) * 100,
      fundingIntervalHours: 1,
      nextFundingAt: Math.ceil(Date.now() / 3_600_000) * 3_600_000,
      openInterestUsd: safeNumber(ctx.openInterest) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(ctx.dayNtlVlm),
      longShortRatio: null,
      price,
      priceChange24hPct: prevPx ? ((price - prevPx) / prevPx) * 100 : 0,
      sparkline: [],
      fundingHistory: [],
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[hyperliquid] fetch failed for ${asset}:`, err);
    return null;
  }
}
