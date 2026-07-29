import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Paradex — direct adapter. Public API, no key.
 * Docs: https://docs.paradex.trade/
 *
 * `open_interest` is in base units and needs pricing at the mark. Verified
 * against CoinGecko's view of Paradex: 47.9971 BTC × $64,434 = $3.09M
 * against their $3.1M.
 *
 * FUNDING INTERVAL: Paradex accrues funding continuously and settles it on
 * an 8-hour basis, and `funding_rate` is quoted over that 8h window. Note
 * that providers/defillama.ts lists paradex among its hourly venues — that
 * classification is for DefiLlama's own feed and disagrees with this one.
 * The venue's own API is the better authority for its own contract, so 8h
 * is used here.
 */
const BASE = "https://api.prod.paradex.trade/v1";

interface ParadexSummary {
  symbol?: string;
  mark_price?: string;
  last_traded_price?: string;
  underlying_price?: string;
  /** Base units. */
  open_interest?: string;
  /** Decimal fraction over the 8h settlement window. */
  funding_rate?: string;
  /** Decimal fraction: 0.014731 = +1.47%. */
  price_change_rate_24h?: string;
  volume_24h?: string;
}

export async function fetchParadex(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const market = `${asset}-USD-PERP`;
  try {
    const res = await fetchJson<{ results?: ParadexSummary[] }>(
      `${BASE}/markets/summary?market=${market}`
    );
    const row = res.results?.[0];
    if (!row) return null;

    const price = safeNumber(row.mark_price) || safeNumber(row.last_traded_price);
    if (!price) return null;

    const now = Date.now();
    return {
      exchangeId: "paradex",
      asset,
      fundingRatePct: safeNumber(row.funding_rate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: Math.ceil(now / 28_800_000) * 28_800_000,
      openInterestUsd: safeNumber(row.open_interest) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(row.volume_24h),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(row.price_change_rate_24h) * 100,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[paradex] fetch failed for ${asset}:`, err);
    return null;
  }
}
