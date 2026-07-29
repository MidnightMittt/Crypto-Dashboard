import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Phemex — direct adapter. Public API, no key.
 * Docs: https://phemex-docs.github.io/
 *
 * ── Phemex's field-suffix convention ───────────────────────────────────
 *
 * Phemex encodes scaling in the field NAME, which is easy to miss:
 *   ...Rv / ...Rq / ...Rp / ...Rr  are REAL values — plain decimals
 *   ...Ev / ...Eq / ...Ep / ...Er  are SCALED integers needing a divisor
 *
 * The v2 endpoint used here returns the "R" variants, so the values are
 * already usable as-is. If you ever switch to a v1 `...Ep` field, it must be
 * divided by that symbol's scale factor first — otherwise prices land eight
 * orders of magnitude out.
 *
 * `openInterestRv` is in base units and needs pricing at the mark.
 */
const BASE = "https://api.phemex.com";

interface PhemexTicker {
  error?: unknown;
  result?: {
    symbol?: string;
    /** Real value, base units. */
    openInterestRv?: string;
    markPriceRp?: string;
    indexPriceRp?: string;
    closeRp?: string;
    openRp?: string;
    /** Decimal fraction, e.g. 0.0001 = 0.01%. */
    fundingRateRr?: string;
    predFundingRateRr?: string;
    /** Quote-denominated turnover. */
    turnoverRv?: string;
  };
}

export async function fetchPhemex(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}USDT`;
  try {
    const res = await fetchJson<PhemexTicker>(
      `${BASE}/md/v2/ticker/24hr?symbol=${symbol}`
    );
    const r = res.result;
    if (!r || res.error) return null;

    const price = safeNumber(r.markPriceRp) || safeNumber(r.closeRp);
    if (!price) return null;

    const open24h = safeNumber(r.openRp);
    const now = Date.now();

    return {
      exchangeId: "phemex",
      asset,
      fundingRatePct: safeNumber(r.fundingRateRr) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: Math.ceil(now / 28_800_000) * 28_800_000,
      openInterestUsd: safeNumber(r.openInterestRv) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(r.turnoverRv),
      longShortRatio: null,
      price,
      priceChange24hPct: open24h > 0 ? ((price - open24h) / open24h) * 100 : 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[phemex] fetch failed for ${asset}:`, err);
    return null;
  }
}
