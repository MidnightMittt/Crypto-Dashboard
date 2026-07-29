import { SpotPrice } from "./dexscreener";

/**
 * Jupiter Price API V3 — spot reference prices for Solana-native assets.
 *
 * WHAT THIS IS NOT: the Price API. It returns spot token prices only — no
 * funding rates, no open interest, no long/short ratio. Jupiter's *Perps*
 * API is a separate surface (see adapters/jupiter.ts).
 *
 * WHY IT'S HERE: Jupiter prices by last-swapped price worked outward from
 * oracle-priced reference tokens, then filters outliers using liquidity,
 * holder distribution, and organic-score heuristics. For Solana assets
 * that's a high-quality reference, so it joins the spot fallback chain.
 *
 * GET https://api.jup.ag/price/v3?ids=<mint>,<mint>
 * Response is keyed BY MINT ADDRESS:
 *   { "<mint>": { usdPrice, blockId, decimals, priceChange24h } }
 *
 * TWO TRAPS, both documented by Jupiter:
 *
 *  1. Unreliable tokens are OMITTED ENTIRELY — no key, no null, no error.
 *     A missing mint is indistinguishable from a malformed request unless
 *     you diff requested ids against returned keys. We do that explicitly.
 *
 *  2. `priceChange24h` is already a PERCENTAGE (1.29 means +1.29%), not a
 *     0-1 fraction. Multiplying by 100 would inflate it 100x.
 */
const BASE = "https://api.jup.ag/price/v3";
const CACHE_MS = 30_000;
const MAX_IDS = 50; // documented limit

/**
 * Mint addresses per asset.
 *
 * Only SOL is hardcoded — that address appears verbatim in Jupiter's own
 * documentation, so it's verified. Wrapped BTC/ETH on Solana have several
 * competing bridged representations (Portal, Wormhole, Sollet) with
 * different mints and very different liquidity, and guessing wrong would
 * silently price the wrong asset.
 *
 * Add others via JUPITER_MINTS in .env.local as a JSON object:
 *   JUPITER_MINTS={"BTC":"<mint>","ETH":"<mint>"}
 */
const VERIFIED_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
};

function mintMap(): Record<string, string> {
  const extra = process.env.JUPITER_MINTS?.trim();
  if (!extra) return VERIFIED_MINTS;
  try {
    const parsed = JSON.parse(extra) as Record<string, string>;
    return { ...VERIFIED_MINTS, ...parsed };
  } catch {
    console.warn("[jupiter-price] JUPITER_MINTS is not valid JSON — ignoring");
    return VERIFIED_MINTS;
  }
}

interface JupPriceEntry {
  usdPrice?: number;
  blockId?: number;
  decimals?: number;
  priceChange24h?: number;
}

type JupPriceResponse = Record<string, JupPriceEntry>;

let cache: { prices: Map<string, JupPriceEntry>; fetchedAt: number } | null = null;

async function getAll(): Promise<Map<string, JupPriceEntry>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.prices;

  const out = new Map<string, JupPriceEntry>();
  const mints = mintMap();
  const entries = Object.entries(mints).slice(0, MAX_IDS);
  if (entries.length === 0) return out;

  try {
    const ids = entries.map(([, mint]) => mint).join(",");
    const apiKey = process.env.JUPITER_API_KEY?.trim();

    const res = await fetch(`${BASE}?ids=${ids}`, {
      headers: {
        accept: "application/json",
        // Docs show an x-api-key header. The endpoint is also reachable
        // without one at lower rate limits, so it's sent only when set.
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      next: { revalidate: 30 },
    });

    if (res.status === 429) throw new Error("Jupiter rate limit — set JUPITER_API_KEY");
    if (!res.ok) throw new Error(`Jupiter Price HTTP ${res.status}`);

    const json = (await res.json()) as JupPriceResponse;

    // Trap 1: diff requested against returned. Omissions are silent.
    const returnedMints = new Set(Object.keys(json));
    const missing = entries.filter(([, mint]) => !returnedMints.has(mint));
    if (missing.length > 0) {
      console.info(
        `[jupiter-price] omitted (untraded/illiquid/flagged): ${missing
          .map(([asset]) => asset)
          .join(", ")}`
      );
    }

    for (const [asset, mint] of entries) {
      const entry = json[mint];
      if (entry?.usdPrice && Number.isFinite(entry.usdPrice) && entry.usdPrice > 0) {
        out.set(asset.toUpperCase(), entry);
      }
    }

    cache = { prices: out, fetchedAt: Date.now() };
    return out;
  } catch (err) {
    console.warn("[jupiter-price] fetch failed:", err);
    cache = { prices: out, fetchedAt: Date.now() };
    return out;
  }
}

export async function fetchJupiterSpot(asset: string): Promise<SpotPrice | null> {
  const prices = await getAll();
  const entry = prices.get(asset.toUpperCase());
  if (!entry?.usdPrice) return null;

  return {
    asset,
    priceUsd: entry.usdPrice,
    source: "Jupiter Price V3 (Solana)",
    liquidityUsd: 0, // not applicable — oracle/heuristic derived, not a pool
  };
}

/** 24h change, already a percentage per Jupiter's docs. Do not scale. */
export async function fetchJupiterPriceChange24h(asset: string): Promise<number | null> {
  const prices = await getAll();
  const entry = prices.get(asset.toUpperCase());
  return entry?.priceChange24h ?? null;
}
