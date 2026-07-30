/**
 * DexScreener — spot reference prices.
 *
 * WHAT THIS IS NOT: DexScreener is a spot AMM pair aggregator. It does not
 * publish funding rates, open interest, or any perpetuals data, so it is
 * deliberately NOT registered as an exchange source in this app.
 *
 * WHAT IT IS FOR: every price elsewhere in this dashboard is a *perp* mark
 * price. DexScreener supplies the *spot* price, which lets us compute basis:
 *
 *     basis % = (perp price - spot price) / spot price * 100
 *
 * Basis is a leverage signal that sits alongside funding. Perps trading
 * above spot means longs are paying up for leverage; below means short
 * pressure. Funding and basis usually agree — when they diverge, that gap
 * is worth noticing, which is why both are shown.
 *
 * Free, no API key. Rate limit ~300 req/min on the pairs routes.
 *
 * ── Why this file has three layers of validation ───────────────────────
 *
 * `/search` matches loosely and readily returns a pool that is NOT the
 * requested asset — see EXPECTED_SYMBOLS below for a live example that
 * produced a 6,100,199% basis figure on the dashboard. Kept as a source
 * (traders already reference it) rather than removed, but every result now
 * passes a symbol check, a volume floor, and a cross-pool median check
 * before it can reach the UI. spotPrice.ts adds a fourth layer on top,
 * cross-checking against Coinbase.
 */

import { timeoutSignal } from "../net/timeout";
const BASE = "https://api.dexscreener.com/latest/dex";
const CACHE_MS = 60_000;

export interface SpotPrice {
  asset: string;
  priceUsd: number;
  /** Highest-volume validated pool we sourced it from, shown in the UI for provenance. */
  source: string;
  liquidityUsd: number;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  baseToken?: { symbol?: string; address?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

interface SearchResponse {
  pairs?: DexPair[] | null;
}

/**
 * Search terms per asset. Uses a liquid, well-known pair so we don't match
 * a wrapped/bridged token with a thin pool and a wandering price.
 */
const SEARCH_TERMS: Record<string, string> = {
  BTC: "WBTC/USDC",
  ETH: "WETH/USDC",
  SOL: "SOL/USDC",
  BNB: "WBNB/USDT",
  LINK: "LINK/USDC",
  AVAX: "WAVAX/USDC",
  DOGE: "DOGE/USDT",
  ADA: "ADA/USDT",
  XRP: "XRP/USDT",
  SUI: "SUI/USDC",
};

/**
 * Base-token symbols that genuinely represent each asset.
 *
 * THIS IS THE MOST IMPORTANT FILTER HERE. `/search` matches loosely, so a
 * query for "WBTC/USDC" returns whatever the indexer associates with those
 * strings — including tokens that are not BTC in any sense. Observed live:
 *
 *   MNT      solana   liquidity $6,544,349,198   24h vol $4   price $1.05
 *   WBTC     arbitrum liquidity     $8,021,865   24h vol $10.0M  price $64,096
 *
 * The old logic sorted by liquidity and took the deepest, so it selected MNT
 * at $1.05 as the spot price for BTC. Against a $64,000 perp that is the
 * 6,100,199% basis figure that reached the dashboard.
 *
 * Wrapped and bridged forms are allowed because they track the underlying.
 * Vault, LP and staking derivatives are NOT — "SOL-USDT" is an LP token near
 * $1, and "vbWBTC" is a vault share. Both would pass a substring test.
 */
const EXPECTED_SYMBOLS: Record<string, string[]> = {
  BTC: ["WBTC", "BTC", "BTCB", "CBBTC", "TBTC", "WBTC.E"],
  ETH: ["WETH", "ETH", "WETH.E"],
  SOL: ["SOL", "WSOL"],
  BNB: ["WBNB", "BNB"],
  LINK: ["LINK", "WLINK", "LINK.E"],
  AVAX: ["WAVAX", "AVAX"],
  DOGE: ["DOGE", "WDOGE"],
  ADA: ["ADA", "WADA"],
  XRP: ["XRP", "WXRP"],
  SUI: ["SUI", "WSUI"],
};

/**
 * Locked capital is easy to strand or fabricate; traded volume is not. The
 * bogus pools above carried billions in "liquidity" against single-digit
 * daily volume, so volume is the discriminator that actually separates a real
 * market from a dead one.
 *
 * Tuned against live data, not guessed. DOGE's genuine Ethereum pool trades
 * $39,783/24h — an initial $50k floor excluded it and lost a working
 * reference, so this sits just under that while remaining three orders of
 * magnitude above the fake pools, which carry single-digit daily volume.
 */
const MIN_VOLUME_24H_USD = 25_000;
const MIN_LIQUIDITY_USD = 100_000;

/** Beyond this from the median of survivors, a pool is quoting something else. */
const MAX_DEVIATION_FROM_MEDIAN = 0.2;

function isExpectedSymbol(asset: string, symbol: string | undefined): boolean {
  if (!symbol) return false;
  const allowed = EXPECTED_SYMBOLS[asset];
  if (!allowed) return false;
  // Exact match only. A substring test would readmit SOL-USDT and vbWBTC.
  return allowed.includes(symbol.trim().toUpperCase());
}

const cache = new Map<string, { price: SpotPrice | null; fetchedAt: number }>();

export async function fetchSpotPrice(asset: string): Promise<SpotPrice | null> {
  const cached = cache.get(asset);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.price;

  const term = SEARCH_TERMS[asset];
  if (!term) return null;

  try {
    const res = await fetch(`${BASE}/search?q=${encodeURIComponent(term)}`, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);

    const json = (await res.json()) as SearchResponse;
    const pairs = json.pairs ?? [];
    if (pairs.length === 0) {
      cache.set(asset, { price: null, fetchedAt: Date.now() });
      return null;
    }

    /*
     * Three filters, then rank. Each catches a failure the others miss:
     *
     *   symbol  — the pool is actually this asset, not a same-string token
     *   volume  — the pool trades, rather than merely holding capital
     *   median  — the price agrees with the other surviving pools
     *
     * Ranking is then by VOLUME, not liquidity. Price discovery happens where
     * trades happen; the deepest pool can be stale, and sorting by depth is
     * precisely what selected a $4-per-day token as the BTC reference.
     */
    const eligible = pairs.filter((p) => {
      const price = parseFloat(p.priceUsd ?? "");
      if (!Number.isFinite(price) || price <= 0) return false;
      if (!isExpectedSymbol(asset, p.baseToken?.symbol)) return false;
      if ((p.volume?.h24 ?? 0) < MIN_VOLUME_24H_USD) return false;
      if ((p.liquidity?.usd ?? 0) < MIN_LIQUIDITY_USD) return false;
      return true;
    });

    if (eligible.length === 0) {
      // Better to report nothing than to relax the filters and guess.
      cache.set(asset, { price: null, fetchedAt: Date.now() });
      return null;
    }

    /*
     * Outlier rejection only applies with 3+ candidates, because a "median"
     * of two is just the higher of the two and biases the result upward.
     *
     * SUI is the case that proved it: the genuine pool on the sui chain
     * ($0.6852, $1.0M daily volume) was measured against a solana pool
     * ($0.9444, $147k volume), the higher one became the "median", and the
     * correct pool was then rejected as 27% off. Volume is the better
     * authority when there are too few candidates to vote.
     */
    const byVolume = [...eligible].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));

    let survivors = byVolume;
    if (byVolume.length >= 3) {
      const prices = byVolume.map((p) => parseFloat(p.priceUsd ?? "0")).sort((a, b) => a - b);
      const median = prices[Math.floor(prices.length / 2)];
      const agreeing = byVolume.filter((p) => {
        const price = parseFloat(p.priceUsd ?? "0");
        return Math.abs(price - median) / median <= MAX_DEVIATION_FROM_MEDIAN;
      });
      if (agreeing.length > 0) survivors = agreeing;
    }

    // Highest traded volume among survivors — where price discovery happens.
    const best = survivors[0];

    if (!best) {
      cache.set(asset, { price: null, fetchedAt: Date.now() });
      return null;
    }

    const price: SpotPrice = {
      asset,
      priceUsd: parseFloat(best.priceUsd ?? "0"),
      source: `${best.dexId ?? "dex"} · ${best.chainId ?? ""}`.trim(),
      liquidityUsd: best.liquidity?.usd ?? 0,
    };

    cache.set(asset, { price, fetchedAt: Date.now() });
    return price;
  } catch (err) {
    console.warn(`[dexscreener] spot price failed for ${asset}:`, err);
    cache.set(asset, { price: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Basis as a percentage. Positive = perps trade above spot (long demand);
 * negative = perps below spot (short pressure).
 *
 * Returns null rather than 0 when either side is missing — a missing spot
 * reference must not read as "perfectly at parity".
 */
export function computeBasisPct(perpPrice: number, spot: SpotPrice | null): number | null {
  if (!spot || !spot.priceUsd || !perpPrice) return null;
  return ((perpPrice - spot.priceUsd) / spot.priceUsd) * 100;
}
