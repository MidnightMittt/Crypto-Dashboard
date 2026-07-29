import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * HTX (formerly Huobi) linear swaps — direct adapter. Public API, no key.
 * Docs: https://huobiapi.github.io/docs/usdt_swap/v1/en/
 *
 * Unusually convenient: /swap_open_interest returns `value` already
 * denominated in USD, so no contract-size lookup or price multiplication is
 * needed. The sibling fields are traps — `volume` is contracts and `amount`
 * is base units, and only `value` is money.
 *
 * Verified against CoinGecko's independent view of HTX: $2.154B vs $2.155B
 * for BTC.
 */
const BASE = "https://api.hbdm.com";

interface OiRow {
  contract_code?: string;
  /** Contracts. */
  volume?: number;
  /** Base asset units. */
  amount?: number;
  /** Already USD — this is the one to use. */
  value?: number;
}

export async function fetchHtx(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const code = `${asset}-USDT`;
  try {
    const [oi, funding, detail] = await Promise.all([
      fetchJson<{ status?: string; data?: OiRow[] }>(
        `${BASE}/linear-swap-api/v1/swap_open_interest?contract_code=${code}`
      ),
      fetchJson<{ data?: { funding_rate?: string; funding_time?: string } }>(
        `${BASE}/linear-swap-api/v1/swap_funding_rate?contract_code=${code}`
      ).catch(() => null),
      fetchJson<{ tick?: { close?: string; open?: string; trade_turnover?: string } }>(
        `${BASE}/linear-swap-ex/market/detail/merged?contract_code=${code}`
      ).catch(() => null),
    ]);

    const row = oi.data?.[0];
    if (!row) return null;

    const price = safeNumber(detail?.tick?.close);
    if (!price) return null;

    const open24h = safeNumber(detail?.tick?.open);
    const now = Date.now();

    return {
      exchangeId: "htx",
      asset,
      // funding_rate is a decimal fraction (0.0001 = 0.01%).
      fundingRatePct: safeNumber(funding?.data?.funding_rate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: safeNumber(funding?.data?.funding_time) || now,
      openInterestUsd: safeNumber(row.value),
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(detail?.tick?.trade_turnover),
      longShortRatio: null,
      price,
      priceChange24hPct: open24h > 0 ? ((price - open24h) / open24h) * 100 : 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[htx] fetch failed for ${asset}:`, err);
    return null;
  }
}
