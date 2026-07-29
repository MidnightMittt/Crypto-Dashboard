import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { querySubgraph, isConfigured, SubgraphConfig } from "@/lib/subgraphs/client";
import { safeNumber } from "./types";

/**
 * GMX (V2) via subgraph.
 *
 * GMX uses a pool-based model (GM pools) rather than an orderbook. What it
 * calls a "borrowing fee" plus the long/short funding split is the economic
 * analogue of funding on an orderbook venue: the cost of holding leverage.
 * We map it into fundingRatePct so it's comparable, but the mechanism does
 * differ — worth remembering when reading the heat map.
 *
 * GMX quantities are fixed-point with 30 decimals (USD values) — that's the
 * single most common source of wrong numbers when integrating GMX.
 *
 * Setup: set THE_GRAPH_API_KEY and GMX_SUBGRAPH_ID in .env.local, or point
 * GMX_SUBGRAPH_URL at a self-hosted endpoint.
 */
export const GMX_SUBGRAPH: SubgraphConfig = {
  idEnvVar: "GMX_SUBGRAPH_ID",
  urlEnvVar: "GMX_SUBGRAPH_URL",
};

/** GMX USD values are scaled by 1e30. */
const USD_DECIMALS = 30;
function fromUsd(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n)) return 0;
  return n / Math.pow(10, USD_DECIMALS);
}

interface MarketInfo {
  id?: string;
  marketToken?: string;
  indexToken?: string;
  longOpenInterestUsd?: string;
  shortOpenInterestUsd?: string;
  fundingFactorPerSecond?: string;
  longsPayShorts?: boolean;
}

interface MarketInfosResult {
  marketInfos?: MarketInfo[];
}

/**
 * Index token addresses per asset on Arbitrum. GMX identifies markets by
 * token address, not symbol, so this mapping is required.
 */
const INDEX_TOKENS: Partial<Record<AssetSymbol, string>> = {
  BTC: "0x47904963fc8b2340414262125af798b9655e58cd", // BTC (WBTC.b index)
  ETH: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
  SOL: "0x2bcc6d6cdbbdc0a4071e48bb3b969b06b3330c07", // SOL
  LINK: "0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
  AVAX: "0x565609faf65b92f7be02468acf86f8979423e514",
  DOGE: "0xc4da4c24fd591125c3f47b340b6f4f76111883d8",
};

const QUERY = `
  query MarketInfos($indexToken: String!) {
    marketInfos(where: { indexToken: $indexToken }, first: 1) {
      id
      marketToken
      indexToken
      longOpenInterestUsd
      shortOpenInterestUsd
      fundingFactorPerSecond
      longsPayShorts
    }
  }
`;

export function gmxConfigured(): boolean {
  return isConfigured(GMX_SUBGRAPH);
}

export async function fetchGmx(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const indexToken = INDEX_TOKENS[asset];
  if (!indexToken) return null;
  if (!gmxConfigured()) return null;

  const data = await querySubgraph<MarketInfosResult>(
    GMX_SUBGRAPH,
    QUERY,
    { indexToken },
    "gmx"
  );
  const market = data?.marketInfos?.[0];
  if (!market) return null;

  const longOi = fromUsd(market.longOpenInterestUsd);
  const shortOi = fromUsd(market.shortOpenInterestUsd);
  const openInterestUsd = longOi + shortOi;
  if (!openInterestUsd) return null;

  // fundingFactorPerSecond is a 1e30-scaled per-second rate. Convert to an
  // hourly percentage, then sign it: when longs pay shorts the rate is
  // positive, matching the convention on every other venue here.
  const perSecond = fromUsd(market.fundingFactorPerSecond);
  const hourlyPct = perSecond * 3600 * 100;
  const fundingRatePct = market.longsPayShorts === false ? -hourlyPct : hourlyPct;

  const now = Date.now();
  return {
    exchangeId: "gmx",
    asset,
    fundingRatePct,
    fundingIntervalHours: 1, // GMX accrues continuously; normalized hourly
    nextFundingAt: Math.ceil(now / 3_600_000) * 3_600_000,
    openInterestUsd,
    openInterestChange24hPct: null,
    volume24hUsd: 0,
    // GMX does expose a long/short split, but it is NOTIONAL — dollars on
    // each side, which a pool-based venue can have diverge. The CEX gauge
    // aggregates an ACCOUNT ratio (how many traders per side), the only
    // positioning an order book can meaningfully report since its notional
    // is balanced by construction. Averaging the two produces a number that
    // is neither, so this goes through poolExposure instead — see
    // providers/gmxExposure.ts, which reads it keylessly over REST.
    longShortRatio: null,
    price: 0,
    priceChange24hPct: 0,
    sparkline: [],
    fundingHistory: [],
    source: "direct",
    updatedAt: now,
  };
}
