import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Orderly Network — direct adapter. Public API, no key.
 * Docs: https://orderly.network/docs/build-on-omnichain/evm-api/introduction
 *
 * One request per asset returns everything, including explicit 24h open and
 * close prices, so the daily change is a real computed figure rather than an
 * inferred one.
 *
 * `open_interest` is in base units. `last_funding_rate` is a decimal
 * fraction over the 8h settlement window that `next_funding_time` points at.
 */
const BASE = "https://api.orderly.org/v1/public/futures";

interface OrderlyFutures {
  symbol?: string;
  status?: string;
  index_price?: number;
  mark_price?: number;
  /** Base units. */
  open_interest?: number;
  /** Decimal fraction, e.g. 0.00009925 = 0.009925%. */
  last_funding_rate?: number;
  est_funding_rate?: number;
  next_funding_time?: number;
  "24h_open"?: number;
  "24h_close"?: number;
  /** Quote-denominated turnover. */
  "24h_amount"?: number;
}

export async function fetchOrderly(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `PERP_${asset}_USDC`;
  try {
    const res = await fetchJson<{ success?: boolean; data?: OrderlyFutures }>(
      `${BASE}/${symbol}`
    );
    const d = res.data;
    if (!d || res.success === false) return null;
    if (d.status && d.status !== "ACTIVE") return null;

    const price = safeNumber(d.mark_price) || safeNumber(d.index_price);
    if (!price) return null;

    const open24h = safeNumber(d["24h_open"]);
    const now = Date.now();

    return {
      exchangeId: "orderly",
      asset,
      fundingRatePct: safeNumber(d.last_funding_rate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: safeNumber(d.next_funding_time) || now,
      openInterestUsd: safeNumber(d.open_interest) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(d["24h_amount"]),
      longShortRatio: null,
      price,
      priceChange24hPct: open24h > 0 ? ((price - open24h) / open24h) * 100 : 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[orderly] fetch failed for ${asset}:`, err);
    return null;
  }
}
