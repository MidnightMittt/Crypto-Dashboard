import { SpotPrice } from "./dexscreener";

/**
 * Alchemy Prices API — spot reference prices.
 *
 * WHAT THIS IS NOT: Alchemy is node/RPC infrastructure. It publishes no
 * funding rates or open interest, so it is not an exchange source here.
 *
 * WHAT IT IS FOR: the highest-quality spot price available to us. Per
 * Alchemy's docs, the by-symbol endpoint "combines CEX and DEX data" and
 * aggregates "by averaging exchange prices (weighted by total volume)".
 *
 * That makes it a better basis reference than a single DEX pool, which is
 * why it runs ahead of DexScreener in the fallback chain — a volume-weighted
 * cross-venue average is far harder to distort than one pool's mid.
 *
 * GET https://api.g.alchemy.com/prices/v1/{apiKey}/tokens/by-symbol?symbols=BTC,ETH
 * Response: { data: [ { symbol, prices: [ { currency, value, lastUpdatedAt } ] } ] }
 *
 * Free key at https://dashboard.alchemy.com. Their public "docs-demo" key
 * works for trying it out but is heavily rate-limited — fine for a first
 * run, not for continuous polling.
 */
const BASE = "https://api.g.alchemy.com/prices/v1";
const CACHE_MS = 60_000;
const MAX_SYMBOLS = 25; // documented limit

interface AlchemyPricesResponse {
  data?: Array<{
    symbol?: string;
    prices?: Array<{ currency?: string; value?: string; lastUpdatedAt?: string }>;
    error?: unknown;
  }>;
}

function apiKey(): string {
  // Falls back to Alchemy's public demo key so basis works with no setup.
  return process.env.ALCHEMY_API_KEY?.trim() || "docs-demo";
}

export function usingDemoKey(): boolean {
  return !process.env.ALCHEMY_API_KEY?.trim();
}

let cache: { prices: Map<string, number>; fetchedAt: number } | null = null;

/**
 * Fetches every asset in one request — the endpoint accepts up to 25
 * symbols, and one call per asset would burn the rate limit needlessly.
 */
async function getAll(symbols: string[]): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.prices;

  const out = new Map<string, number>();
  try {
    const list = symbols.slice(0, MAX_SYMBOLS).join(",");
    const res = await fetch(`${BASE}/${apiKey()}/tokens/by-symbol?symbols=${list}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
    });

    if (res.status === 429) {
      throw new Error("Alchemy rate limit — set ALCHEMY_API_KEY for your own quota");
    }
    if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);

    const json = (await res.json()) as AlchemyPricesResponse;
    for (const row of json.data ?? []) {
      const symbol = row.symbol?.toUpperCase();
      if (!symbol || row.error) continue;
      const usd = row.prices?.find((p) => (p.currency ?? "").toLowerCase() === "usd");
      const value = usd?.value ? parseFloat(usd.value) : NaN;
      if (Number.isFinite(value) && value > 0) out.set(symbol, value);
    }

    cache = { prices: out, fetchedAt: Date.now() };
    return out;
  } catch (err) {
    console.warn("[alchemy] price fetch failed:", err);
    cache = { prices: out, fetchedAt: Date.now() };
    return out;
  }
}

export async function fetchAlchemySpot(
  asset: string,
  allAssets: string[]
): Promise<SpotPrice | null> {
  const prices = await getAll(allAssets);
  const price = prices.get(asset.toUpperCase());
  if (!price) return null;

  return {
    asset,
    priceUsd: price,
    source: usingDemoKey()
      ? "Alchemy (demo key, volume-weighted CEX+DEX)"
      : "Alchemy (volume-weighted CEX+DEX)",
    liquidityUsd: 0, // not applicable — this is an aggregate, not a pool
  };
}
