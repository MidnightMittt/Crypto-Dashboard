import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// Bitget v2 mix (futures) API — public, no key required.
// Docs: https://www.bitget.com/api-doc/contract/intro
const BASE = "https://api.bitget.com";

interface BitgetTicker {
  symbol: string;
  lastPr: string;
  change24h: string; // decimal fraction
  baseVolume: string;
  usdtVolume: string;
  holdingAmount: string; // open interest in base units
  fundingRate: string;
  nextFundingTime: string;
}

export async function fetchBitget(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}USDT`;
  try {
    const res = await fetchJson<{ data: BitgetTicker[] }>(
      `${BASE}/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`
    );
    const t = res.data?.[0];
    if (!t) return null;

    const price = safeNumber(t.lastPr);
    if (!price) return null;

    return {
      exchangeId: "bitget",
      asset,
      fundingRatePct: safeNumber(t.fundingRate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: safeNumber(t.nextFundingTime) || Date.now(),
      openInterestUsd: safeNumber(t.holdingAmount) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(t.usdtVolume),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(t.change24h) * 100,
      sparkline: [],
      fundingHistory: [],
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[bitget] fetch failed for ${asset}:`, err);
    return null;
  }
}
