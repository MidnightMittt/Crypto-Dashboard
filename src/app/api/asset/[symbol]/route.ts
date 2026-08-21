import { NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import earningsJson from "@/data/earningsCalendar.json";
import positioningLatestJson from "@/data/positioningLatest.json";
import positioningHistoryJson from "@/data/positioningHistory.json";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import { BarsPanel } from "@/lib/research/barsPanel";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { AssetFacts, buildAssetFacts } from "@/lib/asset/buildAssetFacts";

/**
 * GET /api/asset/{SYMBOL} — one symbol, flat JSON, built for a machine.
 *
 * The consumer is the trading agent inside a decision window. The existing
 * paths were unusable there: the dossier page is 235KB of server-rendered
 * HTML, /api/asset-composites was measured at 16.3 seconds, and pulling raw
 * bars from the broker blew a token limit three times in one session. The
 * budget here is ~2s, and the design that meets it is: EVERYTHING from
 * committed artifacts — the matched bars panel, the positioning projection,
 * the earnings calendar — and NO provider call at all.
 *
 * The first version of this route did carry one live probe, for earnings,
 * on the theory that only a provider could separate "no earnings" from "we
 * could not find out". Production disproved it on the first measurement: the
 * probe timed out on EVERY request (Nasdaq rejects datacenter IPs, which
 * this repository's own daily workflow already documented), spending 1.2s of
 * a 1.7s response to learn nothing, and returning a different
 * earnings_status on a laptop than on the server for the same symbol. The
 * calendar now records whether its sweep completed, which answers the same
 * question from a committed file — see resolveEarnings.
 *
 * Coverage is the positioning universe, deliberately: this endpoint exists
 * to join what the recorder measures with where the price has been, and a
 * symbol outside that universe has no positioning row to join. The 404 says
 * so rather than half-answering.
 *
 * No verdicts, same contract as /api/pretrade: facts, with each value's own
 * instant beside it.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const positioningPoints = (positioningLatestJson as { points: PositioningPoint[] }).points;
const calendar = earningsJson as EarningsCalendar;

/*
 * THE CONSTANT-MATURITY VOL SERIES, per symbol, built once at module load.
 *
 * positioningHistory.json is the large store — parsing it per request would
 * undo the millisecond budget this route was built for — but the projection
 * carries only the latest row, and a percentile needs the past. So it is
 * indexed once on cold start and shared by every request the instance serves.
 *
 * Only rows that actually recorded a constant-maturity reading contribute.
 * Sessions predating the field are ABSENT rather than null, and skipping them
 * is what keeps the series comparable — the entire point of holding a fixed
 * tenor.
 */
const ivHistoryBySymbol: Map<string, number[]> = (() => {
  const index = new Map<string, number[]>();
  const points = (positioningHistoryJson as { points: PositioningPoint[] }).points;
  for (const p of points) {
    const v = p.ivConstantMaturityPct;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const bucket = index.get(p.symbol);
    if (bucket) bucket.push(v);
    else index.set(p.symbol, [v]);
  }
  return index;
})();

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> }
): Promise<NextResponse> {
  const symbol = (await params).symbol.toUpperCase();

  const symbolPanel = panel.symbols[symbol];
  if (!symbolPanel) {
    return NextResponse.json(
      {
        error: `${symbol} is not in the positioning universe this endpoint covers.`,
        covered: Object.keys(panel.symbols).length,
        hint: "The universe is declared in src/lib/markets/scannerUniverse.ts (positioningUniverse).",
      },
      { status: 404 }
    );
  }

  const facts: AssetFacts = buildAssetFacts({
    symbol,
    sessions: panel.sessions,
    panel: symbolPanel,
    positioning: positioningPoints.find((p) => p.symbol === symbol) ?? null,
    calendar,
    ivHistory: ivHistoryBySymbol.get(symbol) ?? [],
    now: Date.now(),
  });

  return NextResponse.json(facts);
}
