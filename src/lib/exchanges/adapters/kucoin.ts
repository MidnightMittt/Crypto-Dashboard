import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * KuCoin Futures — direct adapter. Public API, no key.
 * Docs: https://www.kucoin.com/docs/rest/futures-trading/market-data
 *
 * /contracts/active returns every listed contract in one call, so a single
 * request covers all ten assets. Cached module-wide and shared across a
 * polling cycle.
 *
 * ── Two things that will bite you ──────────────────────────────────────
 *
 * 1. KuCoin uses XBT for bitcoin, not BTC. The perp is XBTUSDTM.
 * 2. `openInterest` is in CONTRACTS and must be scaled by `multiplier`
 *    (0.001 BTC for XBTUSDTM). Unscaled it reads 23,673,743 BTC of open
 *    interest — roughly the entire supply, several times over.
 *
 * Sanity-checked: 23,673,743 × 0.001 × $64,458 = $1.53B, which is in line
 * with KuCoin's published futures open interest.
 */
const URL = "https://api-futures.kucoin.com/api/v1/contracts/active";
const CACHE_MS = 10_000;

interface KucoinContract {
  symbol?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  status?: string;
  /** Open interest in contracts. */
  openInterest?: string;
  /** Base units per contract. */
  multiplier?: number;
  markPrice?: number;
  indexPrice?: number;
  /** Decimal fraction, e.g. 7.4e-05 = 0.0074%. */
  fundingFeeRate?: number;
  /** Seconds between funding settlements. Absent on some contracts. */
  fundingRateGranularity?: number;
  turnoverOf24h?: number;
  /** Decimal fraction: 0.015 = +1.5%. */
  priceChgPct?: number;
}

let cache: { rows: KucoinContract[]; fetchedAt: number } | null = null;
let inflight: Promise<KucoinContract[]> | null = null;

async function getContracts(): Promise<KucoinContract[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;
  if (inflight) return inflight;

  inflight = fetchJson<{ data?: KucoinContract[] }>(URL)
    .then((res) => {
      const rows = res.data ?? [];
      cache = { rows, fetchedAt: Date.now() };
      return rows;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** KuCoin's ticker for bitcoin. Everything else matches our symbols. */
function kucoinBase(asset: AssetSymbol): string {
  return asset === "BTC" ? "XBT" : asset;
}

export async function fetchKucoin(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const rows = await getContracts();
    const base = kucoinBase(asset);

    // USDT-margined perpetual: symbols end in "M" (XBTUSDTM, ETHUSDTM).
    const row = rows.find(
      (r) => r.symbol === `${base}USDTM` && (!r.status || r.status === "Open")
    );
    if (!row) return null;

    const price = safeNumber(row.markPrice) || safeNumber(row.indexPrice);
    const multiplier = safeNumber(row.multiplier);
    // Without a multiplier the contract count is meaningless — drop rather
    // than assume 1, which would misreport by three orders of magnitude.
    if (!price || multiplier <= 0) return null;

    const now = Date.now();
    // granularity is in milliseconds when present; KuCoin perps settle 8-hourly.
    const granularityMs = safeNumber(row.fundingRateGranularity);
    const intervalHours = granularityMs > 0 ? granularityMs / 3_600_000 : 8;

    return {
      exchangeId: "kucoin",
      asset,
      fundingRatePct: safeNumber(row.fundingFeeRate) * 100,
      fundingIntervalHours: intervalHours > 0 ? intervalHours : 8,
      nextFundingAt:
        Math.ceil(now / (intervalHours * 3_600_000)) * (intervalHours * 3_600_000),
      openInterestUsd: safeNumber(row.openInterest) * multiplier * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(row.turnoverOf24h),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(row.priceChgPct) * 100,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[kucoin] fetch failed for ${asset}:`, err);
    return null;
  }
}
