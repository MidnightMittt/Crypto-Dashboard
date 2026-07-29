import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// Kraken Futures public tickers — one call returns every instrument.
// Docs: https://docs.kraken.com/api/docs/futures-api/trading/get-tickers
const BASE = "https://futures.kraken.com/derivatives/api/v3";

interface KrakenTicker {
  symbol: string;
  markPrice?: number;
  last?: number;
  change24h?: number; // percent
  volumeQuote?: number;
  openInterest?: number; // base units
  fundingRate?: number; // per-hour rate relative to price
  fundingRatePrediction?: number;
  tag?: string;
}

/** Kraken uses XBT for bitcoin, and PF_<BASE>USD for perpetual futures. */
function symbolFor(asset: AssetSymbol): string {
  const base = asset === "BTC" ? "XBT" : asset;
  return `PF_${base}USD`.toLowerCase();
}

let cache: { data: KrakenTicker[]; fetchedAt: number } | null = null;

async function getTickers(): Promise<KrakenTicker[]> {
  if (cache && Date.now() - cache.fetchedAt < 5_000) return cache.data;
  const res = await fetchJson<{ tickers: KrakenTicker[] }>(`${BASE}/tickers`);
  cache = { data: res.tickers ?? [], fetchedAt: Date.now() };
  return cache.data;
}

export async function fetchKraken(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const tickers = await getTickers();
    const target = symbolFor(asset);
    const t = tickers.find((x) => x.symbol?.toLowerCase() === target);
    if (!t) return null;

    const price = safeNumber(t.markPrice ?? t.last);
    if (!price) return null;

    // Kraken publishes an absolute hourly funding amount; divide by price to
    // get a rate, matching how every other venue here expresses it.
    const rawFunding = t.fundingRate ?? t.fundingRatePrediction ?? 0;
    const fundingRatePct = price ? (rawFunding / price) * 100 : 0;

    return {
      exchangeId: "kraken",
      asset,
      fundingRatePct,
      fundingIntervalHours: 1,
      nextFundingAt: Math.ceil(Date.now() / 3_600_000) * 3_600_000,
      openInterestUsd: safeNumber(t.openInterest) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(t.volumeQuote),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(t.change24h),
      sparkline: [],
      fundingHistory: [],
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[kraken] fetch failed for ${asset}:`, err);
    return null;
  }
}
