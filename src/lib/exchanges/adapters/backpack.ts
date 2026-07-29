import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Backpack Exchange — direct adapter. Public API, no key.
 * Docs: https://docs.backpack.exchange/
 *
 * Data is split across three endpoints, each of which returns EVERY market
 * when called without a symbol filter. They're fetched unfiltered once and
 * cached, so a polling cycle costs three requests total rather than three
 * per asset.
 *
 * FUNDING IS HOURLY here (`fundingInterval` is 3600000 ms), unlike most CEXs
 * on this dashboard which settle 8-hourly. That matters: an hourly rate is
 * one eighth the size of an 8-hourly one for identical economics, so
 * anything comparing across venues must normalise first — see
 * `fundingPer8h()` in lib/utils/format.ts.
 *
 * `openInterest` is in base units and needs pricing at the mark.
 */
const BASE = "https://api.backpack.exchange/api/v1";
const CACHE_MS = 10_000;

interface BpMarket {
  symbol?: string;
  baseSymbol?: string;
  marketType?: string;
  /** Milliseconds between funding settlements. */
  fundingInterval?: number;
}
interface BpOpenInterest {
  symbol?: string;
  /** Base units. */
  openInterest?: string;
}
interface BpMarkPrice {
  symbol?: string;
  markPrice?: string;
  indexPrice?: string;
  /** Decimal fraction, e.g. 0.0000125 = 0.00125%. */
  fundingRate?: string;
  nextFundingTimestamp?: number;
}
interface BpTicker {
  symbol?: string;
  /** Decimal fraction: -0.011928 = -1.19%. */
  priceChangePercent?: string;
  quoteVolume?: string;
}

interface Bundle {
  markets: BpMarket[];
  oi: BpOpenInterest[];
  marks: BpMarkPrice[];
  tickers: BpTicker[];
}

let cache: { data: Bundle; fetchedAt: number } | null = null;
let inflight: Promise<Bundle> | null = null;

async function getAll(): Promise<Bundle> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.data;
  if (inflight) return inflight;

  inflight = Promise.all([
    fetchJson<BpMarket[]>(`${BASE}/markets`).catch(() => [] as BpMarket[]),
    fetchJson<BpOpenInterest[]>(`${BASE}/openInterest`).catch(() => [] as BpOpenInterest[]),
    fetchJson<BpMarkPrice[]>(`${BASE}/markPrices`).catch(() => [] as BpMarkPrice[]),
    fetchJson<BpTicker[]>(`${BASE}/tickers`).catch(() => [] as BpTicker[]),
  ])
    .then(([markets, oi, marks, tickers]) => {
      const data = { markets, oi, marks, tickers };
      cache = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export async function fetchBackpack(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}_USDC_PERP`;
  try {
    const { markets, oi, marks, tickers } = await getAll();

    const market = markets.find((m) => m.symbol === symbol && m.marketType === "PERP");
    if (!market) return null;

    const mark = marks.find((m) => m.symbol === symbol);
    const price = safeNumber(mark?.markPrice) || safeNumber(mark?.indexPrice);
    if (!price) return null;

    const openInterest = safeNumber(oi.find((o) => o.symbol === symbol)?.openInterest);
    const ticker = tickers.find((t) => t.symbol === symbol);

    const intervalMs = safeNumber(market.fundingInterval, 3_600_000);
    const intervalHours = intervalMs > 0 ? intervalMs / 3_600_000 : 1;
    const now = Date.now();

    return {
      exchangeId: "backpack",
      asset,
      fundingRatePct: safeNumber(mark?.fundingRate) * 100,
      fundingIntervalHours: intervalHours,
      nextFundingAt: safeNumber(mark?.nextFundingTimestamp) || now,
      openInterestUsd: openInterest * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(ticker?.quoteVolume),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(ticker?.priceChangePercent) * 100,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[backpack] fetch failed for ${asset}:`, err);
    return null;
  }
}
