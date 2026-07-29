import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { PROVIDER_FETCH_TIMEOUT_MS, timeoutSignal } from "../net/timeout";
import { PoolExposure } from "./jlpExposure";

/**
 * GMX V2 pool exposure — per-asset long and short notional.
 *
 * Endpoints (public, NO API KEY):
 *   https://arbitrum-api.gmxinfra.io/markets/info
 *   https://avalanche-api.gmxinfra.io/markets/info
 *
 * ── Why REST and not the subgraph ──────────────────────────────────────
 *
 * adapters/gmx.ts reads GMX through The Graph, which needs THE_GRAPH_API_KEY
 * and a deployment id that changes whenever GMX ships a new version. These
 * REST endpoints publish `openInterestLong` and `openInterestShort` directly
 * and need no key at all, so pool exposure works out of the box even when
 * the subgraph isn't configured.
 *
 * ── Units ──────────────────────────────────────────────────────────────
 *
 * GMX scales USD values by 1e30. This is the single most common way to get
 * GMX integrations wrong; the raw BTC long figure is 7.04e36, which is
 * $7.04M once scaled and $7.04e36 if you forget.
 *
 * ── Several markets per asset ──────────────────────────────────────────
 *
 * GMX keys markets by index token AND collateral, so BTC has three separate
 * markets on Arbitrum alone (WBTC.b-USDC, BTC-USDC, and so on). Reading only
 * the first would understate the venue, so every market for an asset is
 * summed. GMX also runs on Avalanche; both chains are included and summed,
 * since "GMX's positioning in BTC" spans both.
 *
 * Verified against the live payload: BTC $8.54M long vs $9.48M short across
 * 3 markets, ETH $6.33M vs $8.42M, magnitudes consistent with GMX's size.
 */
const ENDPOINTS = [
  "https://arbitrum-api.gmxinfra.io/markets/info",
  "https://avalanche-api.gmxinfra.io/markets/info",
];

const CACHE_MS = 30_000;

/** GMX USD values are fixed-point with 30 decimals. */
const USD_SCALE = 1e30;

interface GmxMarket {
  /** e.g. "BTC/USD [WBTC.b-USDC]" — the index symbol is before the slash. */
  name?: string;
  openInterestLong?: string;
  openInterestShort?: string;
}

interface GmxMarketsInfo {
  markets?: GmxMarket[];
}

let cache: { markets: GmxMarket[]; fetchedAt: number } | null = null;
let inflight: Promise<GmxMarket[]> | null = null;

async function getMarkets(): Promise<GmxMarket[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.markets;
  if (inflight) return inflight;

  inflight = Promise.all(
    ENDPOINTS.map((url) =>
      fetchJson<GmxMarketsInfo>(url, {
        // Bulk endpoint — every market on the chain in one payload, and it
        // runs several seconds. Gets the provider deadline, not the tight
        // per-adapter one.
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
      })
        .then((r) => r.markets ?? [])
        // One chain being unreachable shouldn't lose the other.
        .catch(() => [] as GmxMarket[])
    )
  )
    .then((chains) => {
      const markets = chains.flat();
      cache = { markets, fetchedAt: Date.now() };
      return markets;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** "BTC/USD [WBTC.b-USDC]" -> "BTC". Null for swap-only and malformed rows. */
function indexSymbol(name: string | undefined): string | null {
  if (!name || !name.includes("/USD")) return null;
  const symbol = name.split("/")[0]?.trim().toUpperCase();
  return symbol || null;
}

export async function fetchGmxExposure(asset: AssetSymbol): Promise<PoolExposure | null> {
  try {
    const markets = await getMarkets();

    let longUsd = 0;
    let shortUsd = 0;
    let matched = 0;

    for (const m of markets) {
      if (indexSymbol(m.name) !== asset) continue;
      longUsd += safeNumber(m.openInterestLong) / USD_SCALE;
      shortUsd += safeNumber(m.openInterestShort) / USD_SCALE;
      matched += 1;
    }

    if (matched === 0 || longUsd + shortUsd <= 0) return null;

    return { asset, longUsd, shortUsd };
  } catch (err) {
    console.warn(`[gmx-exposure] fetch failed for ${asset}:`, err);
    return null;
  }
}
