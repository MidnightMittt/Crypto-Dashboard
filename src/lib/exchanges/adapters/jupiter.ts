import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Jupiter Perps — direct adapter.
 *
 * ENDPOINT HISTORY, so nobody repeats the search:
 *   - `lite-api.jup.ag/perps/v1/markets` was deprecated 31 Jan 2026 (404).
 *   - `api.jup.ag/perps/v1/*` — 404 on every path tried.
 *   - `perps-api.jup.ag/v1/pool-info?mint=<mint>` — LIVE, public, no key.
 *     It answers per collateral mint, not per market, which is why it isn't
 *     a "markets" list: Jupiter Perps is one JLP pool, not an order book.
 *
 * ── What this venue actually publishes ─────────────────────────────────
 *
 * Jupiter has NO FUNDING RATE. It's an LP-to-trader model: positions borrow
 * from the JLP pool and pay a *borrow fee* to it. Longs and shorts both pay;
 * there is no transfer between them the way a funding rate transfers between
 * crowded and uncrowded sides.
 *
 * So `fundingRatePct` here is a DERIVED PROXY: the long borrow rate minus
 * the short borrow rate. The reasoning:
 *
 *   - Borrow rates on each side scale with that side's utilization of the
 *     pool. Crowded longs drive long utilization up, which drives the long
 *     borrow rate above the short one.
 *   - The differential therefore carries the same directional meaning the
 *     rest of this dashboard assigns to funding: positive = it costs more
 *     to be long = the crowd is leaning long.
 *
 * Reporting the raw long borrow rate instead would be actively misleading,
 * because it is always positive — Jupiter would read as "crowded long" on
 * every asset forever, regardless of positioning.
 *
 * This is a proxy, not a funding rate. It is directionally sound and it is
 * built only from published numbers, but do not read its magnitude as
 * comparable to a CEX funding rate.
 *
 * ── Open interest ──────────────────────────────────────────────────────
 *
 * Deliberately NOT reported here. `longUtilizationPercent × liquidity` gives
 * a real per-asset long OI, but the SHORT side of the pool is shared: every
 * mint reports an identical shortUtilizationPercent because shorts are all
 * collateralised from one stablecoin pool. There is no honest way to split
 * that per asset, and reporting long-only OI would understate the venue and
 * skew every OI-weighted aggregate it feeds.
 *
 * Instead this adapter leaves openInterestUsd at 0, and the aggregator's
 * field-level merge fills it from DefiLlama/CoinGecko, which derive Jupiter's
 * true OI from on-chain state. First-hand borrow rates, provider-sourced OI.
 */
const BASE = "https://perps-api.jup.ag/v1";

/**
 * Jupiter Perps trades exactly three markets against the JLP pool.
 *
 * Mints are overridable because wrapped BTC and ETH on Solana have several
 * competing bridged representations, and Jupiter has migrated between them
 * before. Format: JUPITER_MINTS={"BTC":"<mint>","ETH":"<mint>"}
 */
const DEFAULT_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // wBTC (Portal)
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
};

function mintFor(asset: AssetSymbol): string | null {
  const overrides = process.env.JUPITER_MINTS?.trim();
  if (overrides) {
    try {
      const parsed = JSON.parse(overrides) as Record<string, string>;
      if (parsed[asset]) return parsed[asset];
    } catch {
      console.warn("[jupiter-perps] JUPITER_MINTS is not valid JSON — using defaults");
    }
  }
  return DEFAULT_MINTS[asset] ?? null;
}

interface PoolInfo {
  longAvailableLiquidity?: string;
  longBorrowRatePercent?: string;
  longUtilizationPercent?: string;
  shortAvailableLiquidity?: string;
  shortBorrowRatePercent?: string;
  shortUtilizationPercent?: string;
}

const CACHE_MS = 15_000;
const cache = new Map<string, { info: PoolInfo; fetchedAt: number }>();

async function getPoolInfo(mint: string): Promise<PoolInfo> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.info;

  const apiKey = process.env.JUPITER_API_KEY?.trim();
  const info = await fetchJson<PoolInfo>(`${BASE}/pool-info?mint=${mint}`, {
    // The public endpoint works unauthenticated; a key from portal.jup.ag
    // only raises the rate limit.
    headers: apiKey ? { "x-api-key": apiKey } : {},
  });

  cache.set(mint, { info, fetchedAt: Date.now() });
  return info;
}

export async function fetchJupiter(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const mint = mintFor(asset);
  if (!mint) return null; // Only SOL, ETH, BTC trade on Jupiter Perps.

  try {
    const info = await getPoolInfo(mint);

    const longRate = safeNumber(info.longBorrowRatePercent, NaN);
    const shortRate = safeNumber(info.shortBorrowRatePercent, NaN);
    if (!Number.isFinite(longRate) || !Number.isFinite(shortRate)) return null;

    // Already a percentage ("0.0014" means 0.0014%), so no ×100 here.
    const fundingProxyPct = longRate - shortRate;

    const now = Date.now();
    return {
      exchangeId: "jupiter",
      asset,
      fundingRatePct: fundingProxyPct,
      // Jupiter accrues borrow fees continuously; hourly is the rate's
      // published basis and the unit the rest of the app normalises from.
      fundingIntervalHours: 1,
      nextFundingAt: Math.ceil(now / 3_600_000) * 3_600_000,
      // See the header: left for the provider layer to fill.
      openInterestUsd: 0,
      openInterestChange24hPct: null,
      volume24hUsd: 0,
      longShortRatio: null,
      // pool-info publishes no mark price. Providers supply it.
      price: 0,
      priceChange24hPct: 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[jupiter-perps] fetch failed for ${asset}:`, err);
    return null;
  }
}
