import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// dYdX v4 indexer — public REST, no key required.
// Docs: https://docs.dydx.xyz/api_integration-indexer/indexer_api
const BASE = "https://indexer.dydx.trade/v4";

interface DydxMarket {
  ticker: string;
  oraclePrice: string;
  priceChange24H: string;
  volume24H: string;
  openInterest: string; // in base units
  nextFundingRate: string; // 1-hour rate, as a decimal
  nextFundingAt?: string;
}

let cache: { data: Record<string, DydxMarket>; fetchedAt: number } | null = null;

/** dYdX returns every market in one call — cache briefly so we don't refetch per asset. */
async function getMarkets(): Promise<Record<string, DydxMarket>> {
  if (cache && Date.now() - cache.fetchedAt < 5_000) return cache.data;
  const res = await fetchJson<{ markets: Record<string, DydxMarket> }>(`${BASE}/perpetualMarkets`);
  cache = { data: res.markets, fetchedAt: Date.now() };
  return res.markets;
}

export async function fetchDydx(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const markets = await getMarkets();
    const m = markets[`${asset}-USD`];
    if (!m) return null;

    const price = safeNumber(m.oraclePrice);
    if (!price) return null;

    const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;

    return {
      exchangeId: "dydx",
      asset,
      // dYdX funding is hourly.
      fundingRatePct: safeNumber(m.nextFundingRate) * 100,
      fundingIntervalHours: 1,
      nextFundingAt: m.nextFundingAt ? new Date(m.nextFundingAt).getTime() : nextHour,
      openInterestUsd: safeNumber(m.openInterest) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(m.volume24H),
      longShortRatio: null,
      price,
      priceChange24hPct: price ? (safeNumber(m.priceChange24H) / price) * 100 : 0,
      sparkline: [],
      fundingHistory: [],
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[dydx] fetch failed for ${asset}:`, err);
    return null;
  }
}
