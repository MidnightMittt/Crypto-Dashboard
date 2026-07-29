import { NextRequest, NextResponse } from "next/server";
import { getAggregateForAsset, getAggregateForMarket } from "@/lib/exchanges/aggregator";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";
import { fetchFearGreed } from "@/lib/providers/fearGreed";

export const dynamic = "force-dynamic";

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
    const [aggregate, fearGreed] = await Promise.all([
      assetParam === "MARKET"
        ? getAggregateForMarket()
        : ALL_ASSETS.includes(assetParam as AssetSymbol)
          ? getAggregateForAsset(assetParam as AssetSymbol)
          : Promise.resolve(null),
      fetchFearGreed(),
    ]);

    if (!aggregate) {
      return NextResponse.json(
        { error: `Unknown asset "${assetParam}". Supported: ${ALL_ASSETS.join(", ")}, MARKET.` },
        { status: 400 }
      );
    }

    return NextResponse.json({
      aggregate,
      fearGreed,
      meta: { generatedAt: Date.now() },
    });
  } catch (err) {
    console.error("[market-data] failed:", err);
    return NextResponse.json({ error: "Could not build market snapshot." }, { status: 500 });
  }
}
