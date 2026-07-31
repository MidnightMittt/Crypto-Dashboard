import { AssetSymbol } from "@/types/market";
import { swr } from "../cache/swr";
import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * 30-day daily price history per asset, from CoinGecko — free, keyless.
 *
 * Deliberately NOT built from this app's own history/store.ts. That store
 * only accumulates a point when a given asset happens to be the one
 * currently selected in the dashboard (client-driven polling records
 * history only for the asset being viewed) — reliable for whichever asset
 * a user actually watches, but far too thin and asset-dependent to build a
 * 10-asset correlation matrix from. CoinGecko's market_chart endpoint gives
 * a real, complete 30-day series per asset in one call regardless of what
 * anyone has been looking at.
 *
 * Fetched sequentially with a small stagger, not in parallel — this shares
 * CoinGecko's free-tier rate limit with the derivatives provider
 * (providers/coingecko.ts), and firing 10 requests at once risks losing
 * all of them to a rate limit instead of a graceful partial result.
 *
 * Wrapped in swr() rather than a hand-rolled cache: this doesn't need to be
 * fresher than about once an hour (it's 30 DAYS of daily points; one poll
 * cycle changes almost nothing), and swr() already gives this the same
 * Redis-shared, background-refreshing behavior every other cache in this
 * app has, for free.
 */
const COINGECKO_IDS: Record<AssetSymbol, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  SUI: "sui",
  XRP: "ripple",
  DOGE: "dogecoin",
  LINK: "chainlink",
  ADA: "cardano",
  AVAX: "avalanche-2",
};

export const CORRELATION_WINDOW_DAYS = 30;

export interface PricePoint {
  t: number;
  price: number;
}

interface MarketChartResponse {
  prices?: Array<[number, number]>;
}

function demoKeyHeader(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

async function fetchOneSeries(id: string): Promise<PricePoint[] | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${CORRELATION_WINDOW_DAYS}&interval=daily`,
      {
        headers: { accept: "application/json", ...demoKeyHeader() },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }
    );
    if (!res.ok) return null;

    const json = (await res.json()) as MarketChartResponse;
    const points = (json.prices ?? [])
      .filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[1]) && p[1] > 0)
      .map(([t, price]) => ({ t, price }));

    return points.length > 0 ? points : null;
  } catch {
    return null;
  }
}

async function fetchAll(): Promise<Partial<Record<AssetSymbol, PricePoint[]>>> {
  const out: Partial<Record<AssetSymbol, PricePoint[]>> = {};
  for (const [asset, id] of Object.entries(COINGECKO_IDS) as [AssetSymbol, string][]) {
    const series = await fetchOneSeries(id);
    if (series) out[asset] = series;
    // 400ms, not a tighter stagger: this shares CoinGecko's free-tier rate
    // limit with providers/coingecko.ts's derivatives fetch, which is often
    // running concurrently in the same request. A cold instance hitting
    // both at once measurably lost several of the 10 assets to 429s at a
    // 150ms stagger — this is the more conservative pacing that fixed it.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return out;
}

/** Below this many assets, a result is a rate-limited cold start, not a genuine "some coins have no data" answer. */
const MIN_ASSETS_TO_SHARE = 8;

export async function fetchAllAssetHistories(): Promise<Partial<Record<AssetSymbol, PricePoint[]>>> {
  return swr("coingecko-30d-histories", fetchAll, {
    freshMs: 55 * 60_000,
    maxAgeMs: 4 * 60 * 60_000,
    // A cold instance that only got 4-5 of 10 assets past CoinGecko's rate
    // limit must not publish that to the shared cache — every other
    // instance would inherit a correlation matrix missing half its assets
    // for up to freshMs. Same reasoning as AGGREGATE_CACHE's shouldShare
    // veto in exchanges/aggregator.ts.
    shouldShare: (next, previous) => {
      const nextCount = Object.keys(next).length;
      if (nextCount >= MIN_ASSETS_TO_SHARE) return true;
      const previousCount = previous ? Object.keys(previous).length : 0;
      return previousCount === 0; // never block the very first result
    },
  });
}
