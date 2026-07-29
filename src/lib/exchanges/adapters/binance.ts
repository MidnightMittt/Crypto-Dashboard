import { AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// Binance USDT-M futures. All endpoints below are public, no key required.
// Docs: https://binance-docs.github.io/apidocs/futures/en/
const BASE = "https://fapi.binance.com";

interface OiHistRow {
  timestamp: number;
  sumOpenInterestValue: string;
}

export async function fetchBinance(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}USDT`;
  try {
    const [premium, ticker24h, openInterest, longShort, fundingHist, oiHist] = await Promise.all([
      fetchJson<{ lastFundingRate: string; nextFundingTime: number; markPrice: string }>(
        `${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`
      ),
      fetchJson<{ priceChangePercent: string; quoteVolume: string }>(
        `${BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`
      ),
      fetchJson<{ openInterest: string }>(`${BASE}/fapi/v1/openInterest?symbol=${symbol}`),
      fetchJson<Array<{ longShortRatio: string }>>(
        `${BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`
      ).catch(() => []),
      fetchJson<Array<{ fundingTime: number; fundingRate: string }>>(
        `${BASE}/fapi/v1/fundingRate?symbol=${symbol}&limit=100`
      ).catch(() => []),
      // Real open-interest history — this is what makes the 24h OI change
      // and the percentile gauge genuine rather than estimated.
      fetchJson<OiHistRow[]>(
        `${BASE}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=168`
      ).catch(() => [] as OiHistRow[]),
    ]);

    const price = safeNumber(premium.markPrice);
    if (!price) return null;

    const openInterestUsd = safeNumber(openInterest.openInterest) * price;

    // Build a merged history keyed by hour so funding and OI land on the
    // same timeline for the chart.
    const oiPoints: FundingPoint[] = oiHist.map((r) => ({
      t: r.timestamp,
      openInterestUsd: safeNumber(r.sumOpenInterestValue),
    }));

    const fundingPoints: FundingPoint[] = fundingHist.map((r) => ({
      t: r.fundingTime,
      fundingRatePct: safeNumber(r.fundingRate) * 100,
    }));

    const fundingHistory = [...oiPoints, ...fundingPoints].sort((a, b) => a.t - b.t);

    // 24h OI change straight from the history series.
    let openInterestChange24hPct: number | null = null;
    if (oiPoints.length > 24) {
      const then = oiPoints[oiPoints.length - 25].openInterestUsd;
      if (then && then > 0) {
        openInterestChange24hPct = ((openInterestUsd - then) / then) * 100;
      }
    }

    return {
      exchangeId: "binance",
      asset,
      fundingRatePct: safeNumber(premium.lastFundingRate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: premium.nextFundingTime,
      openInterestUsd,
      openInterestChange24hPct,
      volume24hUsd: safeNumber(ticker24h.quoteVolume),
      longShortRatio: longShort[0] ? safeNumber(longShort[0].longShortRatio) : null,
      price,
      priceChange24hPct: safeNumber(ticker24h.priceChangePercent),
      sparkline: fundingPoints.slice(-24).map((p) => p.fundingRatePct ?? 0),
      fundingHistory,
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[binance] fetch failed for ${asset}:`, err);
    return null;
  }
}
