import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { querySubgraph, isConfigured, SubgraphConfig } from "@/lib/subgraphs/client";
import { safeNumber } from "./types";

/**
 * Synthetix Perps via subgraph.
 *
 * Synthetix funding is skew-driven: it's computed on-chain from the
 * imbalance between long and short open interest rather than from an
 * orderbook premium. The subgraph exposes periodic market snapshots.
 *
 * Values are typically already decimal strings (not fixed-point) in the
 * perps subgraph, unlike GMX — hence no 1e30 scaling here. If numbers come
 * back absurdly large, that assumption is the first thing to check.
 *
 * Setup: THE_GRAPH_API_KEY + SYNTHETIX_SUBGRAPH_ID in .env.local, or point
 * SYNTHETIX_SUBGRAPH_URL at a self-hosted endpoint.
 *
 * Note: Kwenta is a front-end over Synthetix Perps, so it reads from the
 * same data. It's intentionally not a separate adapter.
 */
export const SYNTHETIX_SUBGRAPH: SubgraphConfig = {
  idEnvVar: "SYNTHETIX_SUBGRAPH_ID",
  urlEnvVar: "SYNTHETIX_SUBGRAPH_URL",
};

interface Market {
  id?: string;
  marketKey?: string;
  asset?: string;
  currentFundingRate?: string;
  currentFundingVelocity?: string;
  marketSize?: string;
  marketSkew?: string;
  price?: string;
}

interface MarketsResult {
  futuresMarkets?: Market[];
  markets?: Market[];
}

const QUERY = `
  query Markets {
    futuresMarkets(first: 100) {
      id
      marketKey
      asset
      currentFundingRate
      currentFundingVelocity
      marketSize
      marketSkew
      price
    }
  }
`;

export function synthetixConfigured(): boolean {
  return isConfigured(SYNTHETIX_SUBGRAPH);
}

let cache: { markets: Market[]; fetchedAt: number } | null = null;

async function getMarkets(): Promise<Market[]> {
  if (cache && Date.now() - cache.fetchedAt < 20_000) return cache.markets;
  const data = await querySubgraph<MarketsResult>(SYNTHETIX_SUBGRAPH, QUERY, {}, "synthetix");
  const markets = data?.futuresMarkets ?? data?.markets ?? [];
  cache = { markets, fetchedAt: Date.now() };
  return markets;
}

export async function fetchSynthetix(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  if (!synthetixConfigured()) return null;

  try {
    const markets = await getMarkets();

    // Synthetix encodes assets as bytes32 keys like "sBTC" / "BTC".
    const market = markets.find((m) => {
      const a = (m.asset ?? "").replace(/^s/, "").toUpperCase();
      const k = (m.marketKey ?? "").replace(/^s/, "").replace(/PERP$/i, "").toUpperCase();
      return a === asset || k === asset;
    });
    if (!market) return null;

    const price = safeNumber(market.price);
    const marketSize = safeNumber(market.marketSize); // total OI in base units
    const openInterestUsd = marketSize * price;
    if (!openInterestUsd) return null;

    // currentFundingRate is a daily rate expressed as a decimal fraction.
    const dailyPct = safeNumber(market.currentFundingRate) * 100;
    // Normalize to an hourly figure so fundingIntervalHours=1 is honest.
    const hourlyPct = dailyPct / 24;

    // Skew is (longs - shorts) in base units; recover the split from it.
    const skew = safeNumber(market.marketSkew);
    const longs = (marketSize + skew) / 2;
    const shorts = (marketSize - skew) / 2;

    const now = Date.now();
    return {
      exchangeId: "synthetix",
      asset,
      fundingRatePct: hourlyPct,
      fundingIntervalHours: 1,
      nextFundingAt: Math.ceil(now / 3_600_000) * 3_600_000,
      openInterestUsd,
      openInterestChange24hPct: null,
      volume24hUsd: 0,
      longShortRatio: shorts > 0 ? longs / shorts : null,
      price,
      priceChange24hPct: 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[synthetix] fetch failed for ${asset}:`, err);
    return null;
  }
}
