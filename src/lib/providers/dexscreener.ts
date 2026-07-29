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
 */
const BASE = "https://api.dexscreener.com/latest/dex";
const CACHE_MS = 60_000;

export interface SpotPrice {
  asset: string;
  priceUsd: number;
  /** Deepest pool we sourced it from, shown in the UI for provenance. */
  source: string;
  liquidityUsd: number;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  baseToken?: { symbol?: string };
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

const cache = new Map<string, { price: SpotPrice | null; fetchedAt: number }>();

export async function fetchSpotPrice(asset: string): Promise<SpotPrice | null> {
  const cached = cache.get(asset);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.price;

  const term = SEARCH_TERMS[asset];
  if (!term) return null;

  try {
    const res = await fetch(`${BASE}/search?q=${encodeURIComponent(term)}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);

    const json = (await res.json()) as SearchResponse;
    const pairs = json.pairs ?? [];
    if (pairs.length === 0) {
      cache.set(asset, { price: null, fetchedAt: Date.now() });
      return null;
    }

    // Deepest liquidity wins. A thin pool can print a price well away from
    // the real market, which would produce a nonsense basis figure.
    const best = pairs
      .filter((p) => {
        const price = parseFloat(p.priceUsd ?? "");
        return Number.isFinite(price) && price > 0 && (p.liquidity?.usd ?? 0) > 50_000;
      })
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

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
