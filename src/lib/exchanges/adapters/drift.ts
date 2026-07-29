import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Drift Protocol — Solana perps. Public hosted Data API, no key required.
 * https://data.api.drift.trade/contracts
 *
 * CRITICAL UNIT NOTE (from Drift's docs):
 *   "fundingRate is in quote/base units, so you must divide by
 *    oraclePriceTwap to convert to a percentage."
 *
 * Skipping that division yields a number off by roughly the price of the
 * asset — for BTC that's a ~100,000x error, which would look like an
 * absurd funding rate rather than an obvious bug.
 *
 * Drift funding settles hourly.
 */
const URL = "https://data.api.drift.trade/contracts";
const CACHE_MS = 15_000;

interface DriftContract {
  contract_index?: number;
  ticker_id?: string;
  base_currency?: string;
  quote_currency?: string;
  last_price?: string | number;
  base_volume?: string | number;
  quote_volume?: string | number;
  high?: string | number;
  low?: string | number;
  product_type?: string;
  open_interest?: string | number;
  index_price?: string | number;
  index_name?: string;
  funding_rate?: string | number;
  next_funding_rate?: string | number;
  oracle_price_twap?: string | number;
  // camelCase variants seen in some responses
  fundingRate?: string | number;
  oraclePriceTwap?: string | number;
  openInterest?: string | number;
}

let cache: { rows: DriftContract[]; fetchedAt: number } | null = null;

async function getContracts(): Promise<DriftContract[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;
  const json = await fetchJson<DriftContract[] | { contracts: DriftContract[] }>(URL);
  const rows = Array.isArray(json) ? json : (json?.contracts ?? []);
  if (rows.length === 0) {
    console.warn("[drift] no contracts parsed");
  }
  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

export async function fetchDrift(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const rows = await getContracts();

    const row = rows.find((r) => {
      const ticker = String(r.ticker_id ?? r.index_name ?? "").toUpperCase();
      const base = String(r.base_currency ?? "").toUpperCase();
      return base === asset || ticker.startsWith(`${asset}-PERP`) || ticker === `${asset}-PERP`;
    });
    if (!row) return null;

    const price = safeNumber(row.index_price ?? row.last_price);
    if (!price) return null;

    const oracleTwap = safeNumber(row.oracle_price_twap ?? row.oraclePriceTwap) || price;
    const rawFunding = safeNumber(row.funding_rate ?? row.fundingRate ?? row.next_funding_rate);

    // Convert quote/base units → percentage, per Drift's documentation.
    const fundingRatePct = oracleTwap > 0 ? (rawFunding / oracleTwap) * 100 : 0;

    const oiBase = safeNumber(row.open_interest ?? row.openInterest);
    const openInterestUsd = oiBase * price;
    if (!openInterestUsd) return null;

    const now = Date.now();
    return {
      exchangeId: "drift",
      asset,
      fundingRatePct,
      fundingIntervalHours: 1, // Drift funding updates hourly
      nextFundingAt: Math.ceil(now / 3_600_000) * 3_600_000,
      openInterestUsd,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(row.quote_volume),
      longShortRatio: null,
      price,
      priceChange24hPct: 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    // 403 means Drift is geofencing this region. That's expected in some
    // countries and not worth logging on every poll — the aggregator layer
    // covers Drift instead. Anything else is a real fault worth surfacing.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("403")) {
      console.warn(`[drift] fetch failed for ${asset}:`, err);
    }
    return null;
  }
}
