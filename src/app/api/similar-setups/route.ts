import { NextRequest, NextResponse } from "next/server";
import { AggregateMarketData } from "@/types/market";
import { directionSign } from "@/lib/signals/scoring";
import {
  DayFingerprint,
  findSimilarSetups,
  metricAgreementCount,
  SIMILAR_SETUPS_K,
  SIMILAR_SETUPS_MAX_DISTANCE,
} from "@/lib/signals/similarity";
import { regimeTagsToStrings } from "@/lib/technicals/regimes";
// 873 KB, ~2900 days — deliberately NOT imported by any client component
// (see historicalFingerprints.json's generation comment in report.ts). A
// Route Handler only ever runs server-side, so this import never reaches
// the browser bundle; that's the whole reason this lives behind an API
// route instead of being read directly by SignalBreakdown.tsx the way the
// small backtestMetricStats.json is.
import historicalFingerprints from "@/data/historicalFingerprints.json";

export const dynamic = "force-dynamic";

export interface SimilarSetupMatch {
  date: string;
  distance: number;
  signalsMatched: number;
  signalsTotal: number;
  regimeTags: string[];
  forwardReturn1d: number | null;
  forwardReturn7d: number | null;
}

/**
 * POST /api/similar-setups  →  { matches: SimilarSetupMatch[] }
 *
 * Builds today's fingerprint from the live aggregate's already-computed
 * marketBias.metrics (the SAME verdicts every card on the page already
 * shows — no re-evaluation, no second opinion) and matches it against the
 * precomputed historical fingerprint set. An empty `matches` array is a
 * legitimate answer ("no comparable historical setup found"), not an error.
 */
export async function POST(req: NextRequest) {
  const { aggregate } = (await req.json()) as { aggregate: AggregateMarketData };

  if (!aggregate?.marketBias) {
    return NextResponse.json({ matches: [] });
  }

  const targetMetricVerdicts = Object.fromEntries(
    aggregate.marketBias.metrics.map((m) => [m.id, directionSign(m.verdict) as -1 | 0 | 1])
  );

  const target: DayFingerprint = {
    asset: aggregate.asset,
    date: new Date(aggregate.updatedAt).toISOString().slice(0, 10),
    metricVerdicts: targetMetricVerdicts,
    regimeTags: aggregate.marketThesis?.regimeTags ? regimeTagsToStrings(aggregate.marketThesis.regimeTags) : [],
    forwardReturn1d: null,
    forwardReturn7d: null,
  };

  const results = findSimilarSetups(
    target,
    historicalFingerprints as DayFingerprint[],
    SIMILAR_SETUPS_K,
    SIMILAR_SETUPS_MAX_DISTANCE
  );

  const matches: SimilarSetupMatch[] = results.map(({ day, distance }) => {
    const { matched, total } = metricAgreementCount(targetMetricVerdicts, day.metricVerdicts);
    return {
      date: day.date,
      distance,
      signalsMatched: matched,
      signalsTotal: total,
      regimeTags: day.regimeTags,
      forwardReturn1d: day.forwardReturn1d,
      forwardReturn7d: day.forwardReturn7d,
    };
  });

  return NextResponse.json({ matches });
}
