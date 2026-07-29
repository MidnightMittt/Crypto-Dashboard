import { SpotPrice } from "./dexscreener";
import { timeoutSignal } from "../net/timeout";

/**
 * Coinbase spot price — free, no API key, no signup.
 *
 * WHY THIS IS FIRST IN THE CHAIN: the basis figure needs a spot reference
 * that is unambiguously the right asset. The previous chain started with
 * Alchemy (whose shared "docs-demo" key answers 403) and ended at
 * DexScreener, which matches on ticker TEXT. Solana is full of worthless
 * tokens named "BTC", so that fallback once returned a ~$1 meme pool as the
 * spot price for a $64,000 perp — a basis of 6,120,642%.
 *
 * Coinbase quotes a regulated exchange's own book against USD. There is no
 * ticker ambiguity: BTC-USD means BTC. Verified to cover all ten assets this
 * dashboard tracks, including BNB and SUI, which the on-chain sources handle
 * poorly.
 *
 * GET /v2/prices/{ASSET}-USD/spot
 * → { "data": { "amount": "64385.465", "base": "BTC", "currency": "USD" } }
 *
 * This is the retail spot endpoint, distinct from the International
 * derivatives API used by adapters/coinbaseIntl.ts.
 */
const BASE = "https://api.coinbase.com/v2/prices";
const CACHE_MS = 30_000;

interface CoinbaseSpotResponse {
  data?: { amount?: string; base?: string; currency?: string };
}

const cache = new Map<string, { price: number; fetchedAt: number }>();

export async function fetchCoinbaseSpot(asset: string): Promise<SpotPrice | null> {
  const symbol = asset.toUpperCase();

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) {
    return toSpot(symbol, hit.price);
  }

  try {
    const res = await fetch(`${BASE}/${symbol}-USD/spot`, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(),
      cache: "no-store",
    });
    // A 404 means Coinbase doesn't list it — a normal answer, not a fault.
    if (!res.ok) return null;

    const json = (await res.json()) as CoinbaseSpotResponse;
    const price = parseFloat(json.data?.amount ?? "");
    if (!Number.isFinite(price) || price <= 0) return null;

    cache.set(symbol, { price, fetchedAt: Date.now() });
    return toSpot(symbol, price);
  } catch (err) {
    console.warn(`[coinbase-spot] fetch failed for ${asset}:`, err);
    return null;
  }
}

function toSpot(asset: string, priceUsd: number): SpotPrice {
  return {
    asset,
    priceUsd,
    source: "Coinbase spot",
    // Not a pool — liquidity isn't a meaningful concept for an exchange book
    // here, and nothing downstream reads it for non-DEX sources.
    liquidityUsd: 0,
  };
}
