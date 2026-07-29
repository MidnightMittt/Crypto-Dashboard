import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { MarketDataProvider, normalizeExchangeName } from "./types";

/**
 * CoinGecko derivatives — free public API, no key required.
 *
 * GET /api/v3/derivatives?include_tickers=unexpired
 * returns every perpetual/futures ticker across ~1,700 venues in one call,
 * including Binance, Bybit, and OKX. That makes it the zero-config path to
 * those venues from regions where they block direct API access.
 *
 * Response shape verified against docs.coingecko.com:
 *   { market, symbol, index_id, price, price_percentage_change_24h,
 *     contract_type, index, basis, spread, funding_rate,
 *     open_interest, volume_24h, last_traded_at, expired_at }
 *
 * IMPORTANT: CoinGecko's `funding_rate` is already expressed in PERCENT
 * (0.009 = 0.009%), unlike most exchange APIs which return a decimal
 * fraction (0.00009). Do not multiply by 100.
 *
 * Rate limits on the keyless tier are modest (~10-30 calls/min), so the
 * whole response is cached and reused across assets.
 */
const BASE = "https://api.coingecko.com/api/v3";
const CACHE_MS = 60_000;

interface GeckoDerivative {
  market?: string;
  symbol?: string;
  index_id?: string;
  price?: string | number;
  price_percentage_change_24h?: number;
  contract_type?: string;
  funding_rate?: number;
  open_interest?: number | null;
  volume_24h?: number | string | null;
  expired_at?: string | null;
}

let cache: { rows: GeckoDerivative[]; fetchedAt: number } | null = null;

function demoKeyHeader(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  // A free Demo key raises the rate limit but isn't required.
  return key ? { "x-cg-demo-api-key": key } : {};
}

async function getRows(): Promise<GeckoDerivative[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;

  const res = await fetch(`${BASE}/derivatives?include_tickers=unexpired`, {
    headers: { accept: "application/json", ...demoKeyHeader() },
    next: { revalidate: 60 },
  });

  if (res.status === 429) {
    throw new Error("CoinGecko rate limit — set COINGECKO_API_KEY for a higher tier");
  }
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);

  const json = await res.json();
  const rows: GeckoDerivative[] = Array.isArray(json) ? json : [];
  if (rows.length === 0) {
    console.warn("[coingecko] no rows parsed; top-level type:", typeof json);
  }

  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

/** Venues that settle funding hourly rather than every 8h. */
const HOURLY = new Set(["hyperliquid", "dydx", "kraken", "vertex", "aevo", "paradex", "lighter"]);

export const coingeckoProvider: MarketDataProvider = {
  id: "coingecko",
  name: "CoinGecko",
  isConfigured: () => true, // works with no key
  fetch: async (asset: AssetSymbol): Promise<ExchangeSnapshot[]> => {
    try {
      const rows = await getRows();
      const now = Date.now();

      // Match USDT/USD-quoted perpetuals for this asset. `index_id` is
      // CoinGecko's normalized underlying (e.g. "BTC"), which is more
      // reliable than parsing the venue-specific symbol string.
      const matching = rows.filter((r) => {
        if (r.contract_type !== "perpetual") return false;
        if (r.expired_at) return false;
        const underlying = (r.index_id ?? "").toUpperCase();
        if (underlying !== asset) return false;
        const sym = (r.symbol ?? "").toUpperCase();
        return sym.includes("USDT") || sym.includes("USD");
      });

      // One market per venue — keep the deepest by open interest.
      const best = new Map<string, GeckoDerivative>();
      for (const r of matching) {
        const exchangeId = normalizeExchangeName(r.market ?? "");
        if (!exchangeId) continue;
        const oi = r.open_interest ?? 0;
        if (!oi) continue;
        const existing = best.get(exchangeId);
        if (!existing || oi > (existing.open_interest ?? 0)) {
          best.set(exchangeId, r);
        }
      }

      const snapshots: ExchangeSnapshot[] = [];
      for (const [exchangeId, r] of best) {
        const price = typeof r.price === "string" ? parseFloat(r.price) : (r.price ?? 0);
        const openInterestUsd = r.open_interest ?? 0;
        if (!openInterestUsd) continue;

        const intervalHours = HOURLY.has(exchangeId) ? 1 : 8;
        const volume =
          typeof r.volume_24h === "string" ? parseFloat(r.volume_24h) : (r.volume_24h ?? 0);

        snapshots.push({
          exchangeId,
          asset,
          // Already a percentage — see note above.
          fundingRatePct: r.funding_rate ?? 0,
          fundingIntervalHours: intervalHours,
          nextFundingAt:
            Math.ceil(now / (intervalHours * 3_600_000)) * (intervalHours * 3_600_000),
          openInterestUsd,
          openInterestChange24hPct: null,
          volume24hUsd: Number.isFinite(volume) ? volume : 0,
          longShortRatio: null,
          price: Number.isFinite(price) ? price : 0,
          priceChange24hPct: r.price_percentage_change_24h ?? 0,
          sparkline: [],
          fundingHistory: [],
          source: "coingecko",
          updatedAt: now,
        });
      }

      return snapshots;
    } catch (err) {
      console.warn("[coingecko] fetch failed:", err);
      return [];
    }
  },
};
