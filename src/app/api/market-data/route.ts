import { NextRequest, NextResponse } from "next/server";
import { getAggregateForAsset, getAggregateForMarket } from "@/lib/exchanges/aggregator";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";
import { fetchFearGreed } from "@/lib/providers/fearGreed";
import { fetchStablecoinSummary } from "@/lib/providers/stablecoins";
import { fetchGlobalMarketSummary } from "@/lib/providers/globalMarket";
import { fetchAllAssetHistories, CORRELATION_WINDOW_DAYS } from "@/lib/providers/coingeckoHistory";
import { computeCorrelationMatrix } from "@/lib/sentiment/correlation";
import { fetchBitcoinNetworkSummary } from "@/lib/providers/bitcoinNetwork";
import { fetchEthereumGasSummary } from "@/lib/providers/ethereumGas";
import { fetchSolanaNetworkSummary } from "@/lib/providers/solanaNetwork";
import { fetchChainTvlSummary } from "@/lib/providers/chainTvl";
import { fetchMacroSnapshot } from "@/lib/providers/macro";

export const dynamic = "force-dynamic";
// swr()'s background refresh now runs via after(), which keeps this
// invocation alive until it finishes rather than letting the platform freeze
// it the instant the response is sent (see lib/cache/swr.ts). A cold,
// degraded fan-out across ~20 adapters at 12s each and concurrency 8 can
// legitimately take 30s+; 60 is Vercel's Hobby-plan ceiling, so this is the
// most headroom available without assuming a paid plan.
export const maxDuration = 60;

/**
 * GET /api/market-data?asset=BTC
 * GET /api/market-data?asset=MARKET   → whole-market roll-up
 *
 * Runs server-side so exchange APIs can be called directly: no CORS issues,
 * and rate limits are shared across all users rather than per-browser.
 */
export async function GET(req: NextRequest) {
  const assetParam = req.nextUrl.searchParams.get("asset") ?? "BTC";

  try {
    const [
      aggregate,
      fearGreed,
      stablecoins,
      globalMarket,
      assetHistories,
      bitcoinNetwork,
      ethereumGas,
      solanaNetwork,
      chainTvl,
      macro,
    ] = await Promise.all([
      assetParam === "MARKET"
        ? getAggregateForMarket()
        : ALL_ASSETS.includes(assetParam as AssetSymbol)
          ? getAggregateForAsset(assetParam as AssetSymbol)
          : Promise.resolve(null),
      fetchFearGreed(),
      // Market-wide, asset-independent — same reasoning as fearGreed above:
      // fetched every request, but each is swr()/module cached, so this
      // costs nothing beyond the first request per cache window.
      fetchStablecoinSummary().catch(() => null),
      fetchGlobalMarketSummary().catch(() => null),
      fetchAllAssetHistories().catch(() => ({})),
      fetchBitcoinNetworkSummary().catch(() => null),
      fetchEthereumGasSummary().catch(() => null),
      fetchSolanaNetworkSummary().catch(() => null),
      fetchChainTvlSummary().catch(() => null),
      fetchMacroSnapshot().catch(() => null),
    ]);

    if (!aggregate) {
      return NextResponse.json(
        { error: `Unknown asset "${assetParam}". Supported: ${ALL_ASSETS.join(", ")}, MARKET.` },
        { status: 400 }
      );
    }

    const correlation = computeCorrelationMatrix(assetHistories, CORRELATION_WINDOW_DAYS, Date.now());

    return NextResponse.json({
      aggregate,
      fearGreed,
      stablecoins,
      globalMarket,
      correlation,
      networkHealth: { bitcoin: bitcoinNetwork, ethereum: ethereumGas, solana: solanaNetwork, chainTvl },
      macro,
      meta: { generatedAt: Date.now() },
    });
  } catch (err) {
    console.error("[market-data] failed:", err);
    return NextResponse.json({ error: "Could not build market snapshot." }, { status: 500 });
  }
}
