import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// Gate.io v4 futures API — public, no key required.
// Docs: https://www.gate.io/docs/developers/apiv4/en/
const BASE = "https://api.gateio.ws/api/v4";

interface GateContract {
  name: string;
  mark_price: string;
  last_price: string;
  funding_rate: string;
  funding_next_apply: number; // unix seconds
  funding_interval: number; // seconds
  trade_size: number;
  position_size: number; // open interest in contracts
  quanto_multiplier: string;
}

interface GateTicker {
  contract: string;
  last: string;
  change_percentage: string;
  volume_24h_settle: string;
}

export async function fetchGateio(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const contract = `${asset}_USDT`;
  try {
    const [c, tickers] = await Promise.all([
      fetchJson<GateContract>(`${BASE}/futures/usdt/contracts/${contract}`),
      fetchJson<GateTicker[]>(`${BASE}/futures/usdt/tickers?contract=${contract}`).catch(() => []),
    ]);

    const price = safeNumber(c.mark_price) || safeNumber(c.last_price);
    if (!price) return null;

    // Gate quotes position_size in contracts; quanto_multiplier converts to base units.
    const multiplier = safeNumber(c.quanto_multiplier, 1) || 1;
    const openInterestUsd = c.position_size * multiplier * price;

    const ticker = tickers[0];

    return {
      exchangeId: "gateio",
      asset,
      fundingRatePct: safeNumber(c.funding_rate) * 100,
      fundingIntervalHours: c.funding_interval ? c.funding_interval / 3600 : 8,
      nextFundingAt: c.funding_next_apply * 1000,
      openInterestUsd,
      openInterestChange24hPct: null,
      volume24hUsd: ticker ? safeNumber(ticker.volume_24h_settle) : 0,
      longShortRatio: null,
      price,
      priceChange24hPct: ticker ? safeNumber(ticker.change_percentage) : 0,
      sparkline: [],
      fundingHistory: [],
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[gateio] fetch failed for ${asset}:`, err);
    return null;
  }
}
