import { AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// Bybit v5 linear perpetuals. Public market data, no key required.
// Docs: https://bybit-exchange.github.io/docs/v5/intro
const BASE = "https://api.bybit.com";

interface BybitTicker {
  lastPrice: string;
  price24hPcnt: string;
  volume24h: string;
  fundingRate: string;
  nextFundingTime: string;
  openInterest: string;
  openInterestValue: string;
}

export async function fetchBybit(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}USDT`;
  try {
    const [tickerRes, ratioRes, oiRes, fundingRes] = await Promise.all([
      fetchJson<{ result: { list: BybitTicker[] } }>(
        `${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`
      ),
      fetchJson<{ result: { list: Array<{ buyRatio: string; sellRatio: string }> } }>(
        `${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=5min&limit=1`
      ).catch(() => ({ result: { list: [] } })),
      fetchJson<{ result: { list: Array<{ openInterest: string; timestamp: string }> } }>(
        `${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=168`
      ).catch(() => ({ result: { list: [] } })),
      fetchJson<{ result: { list: Array<{ fundingRate: string; fundingRateTimestamp: string }> } }>(
        `${BASE}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=100`
      ).catch(() => ({ result: { list: [] } })),
    ]);

    const t = tickerRes.result.list?.[0];
    if (!t) return null;
    const price = safeNumber(t.lastPrice);
    if (!price) return null;

    const openInterestUsd =
      safeNumber(t.openInterestValue) || safeNumber(t.openInterest) * price;

    // Bybit returns OI history newest-first; reverse to chronological.
    const oiRows = [...(oiRes.result.list ?? [])].reverse();
    const oiPoints: FundingPoint[] = oiRows.map((r) => ({
      t: safeNumber(r.timestamp),
      openInterestUsd: safeNumber(r.openInterest) * price,
    }));

    const fundingPoints: FundingPoint[] = [...(fundingRes.result.list ?? [])]
      .reverse()
      .map((r) => ({
        t: safeNumber(r.fundingRateTimestamp),
        fundingRatePct: safeNumber(r.fundingRate) * 100,
      }));

    let openInterestChange24hPct: number | null = null;
    if (oiPoints.length > 24) {
      const then = oiPoints[oiPoints.length - 25].openInterestUsd;
      if (then && then > 0) {
        openInterestChange24hPct = ((openInterestUsd - then) / then) * 100;
      }
    }

    const ratio = ratioRes.result.list?.[0];
    const sell = ratio ? safeNumber(ratio.sellRatio) : 0;

    return {
      exchangeId: "bybit",
      asset,
      fundingRatePct: safeNumber(t.fundingRate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: safeNumber(t.nextFundingTime),
      openInterestUsd,
      openInterestChange24hPct,
      volume24hUsd: safeNumber(t.volume24h) * price,
      longShortRatio: ratio && sell > 0 ? safeNumber(ratio.buyRatio) / sell : null,
      price,
      priceChange24hPct: safeNumber(t.price24hPcnt) * 100,
      sparkline: fundingPoints.slice(-24).map((p) => p.fundingRatePct ?? 0),
      fundingHistory: [...oiPoints, ...fundingPoints].sort((a, b) => a.t - b.t),
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[bybit] fetch failed for ${asset}:`, err);
    return null;
  }
}
