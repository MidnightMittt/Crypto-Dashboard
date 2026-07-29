import { NextRequest, NextResponse } from "next/server";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";
import { historySpanHours, readHistory } from "@/lib/history/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/history?asset=BTC
 *
 * The chart's fast path. This reads ONE local JSON file and returns — no
 * exchange calls, no providers, no spot lookup.
 *
 * WHY IT'S SEPARATE FROM /api/market-data: the chart used to receive its
 * series as part of the full aggregate payload, which meant it couldn't draw
 * a single pixel until 13 exchange adapters, 3 aggregator providers, and a
 * spot-price resolution had all finished. The slowest upstream decided when
 * the chart appeared.
 *
 * Splitting it lets the chart render from recorded history in milliseconds
 * and then silently upgrade to deeper exchange-published history when the
 * main payload lands. Same final picture, drawn immediately instead of last.
 */
export async function GET(req: NextRequest) {
  const assetParam = req.nextUrl.searchParams.get("asset") ?? "BTC";

  if (assetParam !== "MARKET" && !ALL_ASSETS.includes(assetParam as AssetSymbol)) {
    return NextResponse.json(
      { error: `Unknown asset "${assetParam}". Supported: ${ALL_ASSETS.join(", ")}, MARKET.` },
      { status: 400 }
    );
  }

  try {
    const history = await readHistory(assetParam as AssetSymbol | "MARKET");
    return NextResponse.json({
      history,
      historyHours: historySpanHours(history),
    });
  } catch (err) {
    console.error("[history] read failed:", err);
    // An empty series is a valid answer — the chart shows its "collecting
    // history" state rather than an error, which is the honest reading:
    // we have no recorded points to draw.
    return NextResponse.json({ history: [], historyHours: 0 });
  }
}
