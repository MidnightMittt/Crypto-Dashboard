import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";
import { fetchJlpExposure } from "../../providers/jlpExposure";
import { PROVIDER_FETCH_TIMEOUT_MS, timeoutSignal } from "../../net/timeout";

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
 * This adapter previously reported no open interest, reasoning that
 * pool-info's `shortUtilizationPercent` is identical across every mint —
 * shorts all draw on one shared stablecoin bucket — so the short side looked
 * unattributable per asset.
 *
 * That was true of pool-info and wrong about Jupiter. `/v1/jlp-info`
 * publishes `globalShortSizes` per custody, so both sides ARE available per
 * asset. See providers/jlpExposure.ts for the derivation and the three
 * independent checks it was validated against.
 *
 * Open interest here is therefore long + short notional, first-hand.
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

interface MarketStats {
  price?: string;
  /** Already a percentage. */
  priceChange24H?: string;
  volume?: string;
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

/**
 * market-stats is cached on the same window as pool-info. Left uncached it
 * added a live request per asset per poll, and perps-api.jup.ag slows to
 * several seconds under the concurrency of a full fan-out — enough to blow
 * the fetch deadline and drop Jupiter entirely on BTC and SOL.
 */
const statsCache = new Map<string, { stats: MarketStats | null; fetchedAt: number }>();

async function getMarketStats(mint: string): Promise<MarketStats | null> {
  const hit = statsCache.get(mint);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.stats;

  const stats = await fetchJson<MarketStats>(`${BASE}/market-stats?mint=${mint}`, {
    signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
  }).catch(() => null);
  // Cache misses too, so a failing upstream isn't retried on every asset.
  statsCache.set(mint, { stats, fetchedAt: Date.now() });
  return stats;
}

async function getPoolInfo(mint: string): Promise<PoolInfo> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.info;

  const apiKey = process.env.JUPITER_API_KEY?.trim();
  const info = await fetchJson<PoolInfo>(`${BASE}/pool-info?mint=${mint}`, {
    // The public endpoint works unauthenticated; a key from portal.jup.ag
    // only raises the rate limit.
    headers: apiKey ? { "x-api-key": apiKey } : {},
    // perps-api.jup.ag answers in ~3s idle and slower under the concurrency
    // of a full fan-out, which overran the standard adapter deadline and
    // dropped Jupiter from BTC — the asset with the most venues competing.
    // The adapter-level withDeadline still bounds the page.
    signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
  });

  cache.set(mint, { info, fetchedAt: Date.now() });
  return info;
}

export async function fetchJupiter(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const mint = mintFor(asset);
  if (!mint) return null; // Only SOL, ETH, BTC trade on Jupiter Perps.

  try {
    const [info, stats] = await Promise.all([
      getPoolInfo(mint),
      // Price, 24h change and volume. pool-info carries none of these.
      getMarketStats(mint),
    ]);

    const longRate = safeNumber(info.longBorrowRatePercent, NaN);
    const shortRate = safeNumber(info.shortBorrowRatePercent, NaN);
    if (!Number.isFinite(longRate) || !Number.isFinite(shortRate)) return null;

    // Already a percentage ("0.0014" means 0.0014%), so no ×100 here.
    const fundingProxyPct = longRate - shortRate;

    const price = safeNumber(stats?.price);
    // Long notional is stored in tokens, so it can't be valued without a
    // price — no price means no open interest rather than a guess.
    const exposure = price > 0 ? await fetchJlpExposure(asset, price) : null;

    const now = Date.now();
    return {
      exchangeId: "jupiter",
      asset,
      fundingRatePct: fundingProxyPct,
      // Jupiter accrues borrow fees continuously; hourly is the rate's
      // published basis and the unit the rest of the app normalises from.
      fundingIntervalHours: 1,
      nextFundingAt: Math.ceil(now / 3_600_000) * 3_600_000,
      openInterestUsd: exposure ? exposure.longUsd + exposure.shortUsd : 0,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(stats?.volume),
      // Jupiter's long/short skew is NOTIONAL, not the account headcount the
      // CEXs report. Surfacing it here would let it be averaged into
      // longShortRatio alongside OKX's account ratio, producing a figure that
      // matches neither. It is exposed separately — see `poolExposure` on
      // AggregateMarketData.
      longShortRatio: null,
      price,
      // Already a percentage: 1.269 against a 24h high/low range of 2.9%.
      priceChange24hPct: safeNumber(stats?.priceChange24H),
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
