import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * MEXC futures — direct adapter. Public API, no key.
 * Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 *
 * ── The contract-size trap ─────────────────────────────────────────────
 *
 * `holdVol` (open interest) and `volume24` are quoted in CONTRACTS, not in
 * the base asset. For BTC_USDT one contract is 0.0001 BTC, so treating
 * holdVol as a base-unit figure overstates open interest by 10,000x —
 * $53 trillion instead of $5.3B.
 *
 * `contractSize` comes from /contract/detail and is cached, since it changes
 * essentially never. Verified against CoinGecko's independent view of MEXC:
 * 836,175,846 contracts × 0.0001 × $64,458 = $5.39B, versus CoinGecko's
 * $5.35B for the same venue and asset.
 */
const BASE = "https://contract.mexc.com/api/v1/contract";

interface MexcTicker {
  success?: boolean;
  data?: {
    symbol?: string;
    lastPrice?: number;
    fairPrice?: number;
    indexPrice?: number;
    /** Open interest, in contracts. */
    holdVol?: number;
    /** 24h turnover already in quote currency (USDT). */
    amount24?: number;
    /** 24h change as a decimal fraction: 0.0087 = +0.87%. */
    riseFallRate?: number;
    fundingRate?: number;
  };
}

interface MexcDetail {
  data?: { contractSize?: number };
}

const sizeCache = new Map<string, { size: number; fetchedAt: number }>();

async function contractSize(symbol: string): Promise<number> {
  const hit = sizeCache.get(symbol);
  if (hit && Date.now() - hit.fetchedAt < 6 * 3_600_000) return hit.size;

  try {
    const res = await fetchJson<MexcDetail>(`${BASE}/detail?symbol=${symbol}`);
    const size = safeNumber(res.data?.contractSize, 0);
    // Refuse to guess: an unknown multiplier would silently scale open
    // interest by orders of magnitude, so the venue is dropped instead.
    if (size <= 0) return 0;
    sizeCache.set(symbol, { size, fetchedAt: Date.now() });
    return size;
  } catch {
    return 0;
  }
}

export async function fetchMexc(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const symbol = `${asset}_USDT`;
  try {
    const [ticker, size] = await Promise.all([
      fetchJson<MexcTicker>(`${BASE}/ticker?symbol=${symbol}`),
      contractSize(symbol),
    ]);

    const d = ticker.data;
    if (!d || ticker.success === false || !size) return null;

    const price = safeNumber(d.lastPrice) || safeNumber(d.fairPrice);
    if (!price) return null;

    const now = Date.now();
    return {
      exchangeId: "mexc",
      asset,
      // fundingRate is a decimal fraction (0.0001 = 0.01%).
      fundingRatePct: safeNumber(d.fundingRate) * 100,
      // `collectCycle` on /funding_rate reports 8 for the USDT perps.
      fundingIntervalHours: 8,
      nextFundingAt: Math.ceil(now / 28_800_000) * 28_800_000,
      openInterestUsd: safeNumber(d.holdVol) * size * price,
      openInterestChange24hPct: null,
      // amount24 is already quote-denominated, so no contract scaling here.
      volume24hUsd: safeNumber(d.amount24),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(d.riseFallRate) * 100,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[mexc] fetch failed for ${asset}:`, err);
    return null;
  }
}
