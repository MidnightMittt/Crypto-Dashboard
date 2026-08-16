import { NextResponse } from "next/server";
import historyJson from "@/data/positioningHistory.json";
import {
  MIN_SERIES_N,
  PositioningHistory,
  isChartable,
  seriesOf,
} from "@/lib/history/positioningHistory";

/**
 * GET /api/positioning/{SYMBOL}
 *
 * The daily series behind the point-in-time positioning numbers on the
 * dossier: net dealer gamma, short-sale volume share, put/call ratios, ATM
 * implied vol and typical daily move.
 *
 * ── Coverage is per FIELD, and that is the whole point ────────────────
 *
 * FINRA's short-volume archive reaches back years; CBOE's delayed chain has
 * no archive at all. So a symbol can hold hundreds of rows and a handful of
 * gamma readings, and a single `count` beside a gamma chart would be a lie of
 * composition. Every field reports its own observation count and its own
 * first and last date, plus a `chartable` flag that is false until the series
 * is long enough to mean anything.
 *
 * Read from the committed artefact at module load like every other one here;
 * the daily job is what moves it.
 */

export const dynamic = "force-static";

/** Schema version, so a consumer can tell when the shape changes under it. */
const SCHEMA_VERSION = 1;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol: raw } = await params;
  const symbol = raw.toUpperCase();

  const history = historyJson as unknown as PositioningHistory;
  const series = seriesOf(history.points ?? [], symbol);

  if (series.points.length === 0) {
    /*
     * 404 rather than an empty series: "no rows" and "this symbol is not
     * recorded" are different answers, and a consumer that cannot tell them
     * apart will plot a blank chart instead of reporting a gap.
     */
    return NextResponse.json(
      {
        schemaVersion: SCHEMA_VERSION,
        symbol,
        error: "not-recorded",
        detail:
          "No positioning rows for this symbol. Recording covers the declared equity panel; " +
          "options fields only exist from the day recording began.",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    schemaVersion: SCHEMA_VERSION,
    symbol,
    generatedAt: history.generatedAt,
    minSeriesN: MIN_SERIES_N,
    coverage: series.coverage.map((c) => ({
      ...c,
      chartable: isChartable(series, c.field),
    })),
    /*
     * Origins are surfaced so a consumer can separate the two populations
     * without inferring it from nulls. A backfilled row's null gamma means
     * "never observed", never "observed as zero".
     */
    origins: {
      live: series.points.filter((p) => p.origin === "live").length,
      backfill: series.points.filter((p) => p.origin === "backfill").length,
    },
    points: series.points,
  });
}
