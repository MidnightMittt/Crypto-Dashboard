import { NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import earningsJson from "@/data/earningsCalendar.json";
import positioningLatestJson from "@/data/positioningLatest.json";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import { BarsPanel } from "@/lib/research/barsPanel";
import { fetchStreet } from "@/lib/dossier/providers/nasdaqStreet";
import { AssetFacts, buildAssetFacts, EarningsProbe } from "@/lib/asset/buildAssetFacts";

/**
 * GET /api/asset/{SYMBOL} — one symbol, flat JSON, built for a machine.
 *
 * The consumer is the trading agent inside a decision window. The existing
 * paths were unusable there: the dossier page is 235KB of server-rendered
 * HTML, /api/asset-composites was measured at 16.3 seconds, and pulling raw
 * bars from the broker blew a token limit three times in one session. The
 * budget here is ~2s, and the design that meets it is: EVERYTHING from
 * committed artifacts (the matched bars panel, the positioning projection,
 * the earnings calendar) plus exactly ONE live probe — earnings, because it
 * is the one three-state fact no committed file can answer alone — bounded
 * by a hard deadline so a slow provider degrades the answer, never the
 * latency.
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

/**
 * The live probe's whole budget. Nasdaq from a datacenter IP either answers
 * fast or hangs; past this the committed calendar takes over and the status
 * degrades to lookup_failed / calendar-confirmed. Chosen to keep worst-case
 * response comfortably inside the ~2s acceptance bound.
 */
const EARNINGS_PROBE_MS = 1_200;

const panel = barsPanelJson as unknown as BarsPanel;
const positioningPoints = (positioningLatestJson as { points: PositioningPoint[] }).points;
const calendarEntries = (earningsJson as { entries: { symbol: string; date: string }[] }).entries;

async function probeEarnings(symbol: string, lastClose: number | null): Promise<EarningsProbe> {
  if (lastClose === null) return { kind: "unreachable" };
  try {
    const street = await Promise.race([
      fetchStreet(symbol, lastClose),
      new Promise<null>((r) => setTimeout(() => r(null), EARNINGS_PROBE_MS)),
    ]);
    if (street && street.ok) return { kind: "live", nextEarningsDate: street.summary.nextEarningsDate };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

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

  // Last real close, needed by the probe before the builder runs. Same
  // walk-back the builder does; cheap enough that sharing it isn't worth
  // widening the builder's contract.
  const filled = new Set(symbolPanel.interpolated);
  let lastClose: number | null = null;
  for (let i = panel.sessions.length - 1; i >= 0; i--) {
    const row = symbolPanel.bars[i];
    if (row && !filled.has(i)) {
      lastClose = row[3];
      break;
    }
  }

  const earnings = await probeEarnings(symbol, lastClose);

  const facts: AssetFacts = buildAssetFacts({
    symbol,
    sessions: panel.sessions,
    panel: symbolPanel,
    positioning: positioningPoints.find((p) => p.symbol === symbol) ?? null,
    earnings,
    calendarEntries,
    now: Date.now(),
  });

  return NextResponse.json(facts);
}
