import { NextResponse } from "next/server";
import { getAssetComposites } from "@/lib/exchanges/assetComposites";
import { fetchAllAssetHistories } from "@/lib/providers/coingeckoHistory";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/asset-composites → { btc, eth, altcoins, updatedAt }
 *
 * Deliberately a SEPARATE route from /api/market-data, not folded into it —
 * this data refreshes on a 5-minute server cache (assetComposites.ts), far
 * slower than market-data's 15s client poll. A dedicated route lets the
 * client poll this one on its own, much slower interval instead of
 * re-fetching an unchanged payload on every market-data tick.
 *
 * fetchAllAssetHistories() is the SAME 30-day price series the correlation
 * matrix already fetches (55min-cached) — calling it again here costs
 * nothing beyond the first request per cache window.
 */
export async function GET() {
  try {
    const histories = await fetchAllAssetHistories().catch(() => ({}));
    const composites = await getAssetComposites(histories);
    return NextResponse.json(composites);
  } catch (err) {
    console.error("[asset-composites] failed:", err);
    return NextResponse.json({ error: "Could not build asset composites." }, { status: 500 });
  }
}
