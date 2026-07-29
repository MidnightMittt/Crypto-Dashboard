import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Aster — direct adapter. Public API, no key.
 * Docs: https://docs.asterdex.com/
 *
 * Aster exposes a Binance-compatible futures API (same paths, same field
 * names, same units), so this mirrors adapters/binance.ts closely. The
 * useful part: unlike Binance itself, it is not geo-blocked, so this is
 * first-hand data rather than a CoinGecko relay.
 *
 * Units follow the Binance convention throughout:
 *   lastFundingRate   decimal fraction (0.00006995 = 0.006995%)
 *   openInterest      base units, needs multiplying by mark price
 *   quoteVolume       already USD
 *   priceChangePercent already a percentage
 *
 * ── Expect this to read ~half of CoinGecko's Aster figure ──────────────
 *
 * Direct gives $378.9M for BTC where CoinGecko reports $752.5M — a ratio of
 * 1.986, which is not a rounding difference. Aster's own `openInterest` is
 * single-sided, the same convention Binance, Bybit and OKX use and therefore
 * the same one every other adapter here reports; CoinGecko appears to be
 * summing both sides of the book.
 *
 * Checked and ruled out: Aster's other BTC perp, BTCUSD1, holds only 57.6 BTC
 * (~$3.7M), so a missing market does not explain the gap. BTCDOMUSDT and
 * PUMPBTCUSDT are deliberately excluded — despite the names, neither is a
 * BTC perpetual.
 *
 * The single-sided figure is the correct one to keep: mixing conventions
 * across venues would silently corrupt every open-interest-weighted
 * aggregate on the dashboard.
 */
const BASE = "https://fapi.asterdex.com";

export async function fetchAster(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}USDT`;
  try {
    const [premium, oi, ticker] = await Promise.all([
      fetchJson<{ markPrice: string; lastFundingRate: string; nextFundingTime: number }>(
        `${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`
      ),
      fetchJson<{ openInterest: string }>(`${BASE}/fapi/v1/openInterest?symbol=${symbol}`),
      // Optional: the venue is still useful without volume and 24h change.
      fetchJson<{ priceChangePercent: string; quoteVolume: string }>(
        `${BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`
      ).catch(() => null),
    ]);

    const price = safeNumber(premium.markPrice);
    if (!price) return null;

    const now = Date.now();
    return {
      exchangeId: "aster",
      asset,
      fundingRatePct: safeNumber(premium.lastFundingRate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: safeNumber(premium.nextFundingTime) || now,
      openInterestUsd: safeNumber(oi.openInterest) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(ticker?.quoteVolume),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(ticker?.priceChangePercent),
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[aster] fetch failed for ${asset}:`, err);
    return null;
  }
}
