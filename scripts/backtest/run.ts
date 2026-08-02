import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeSqueezeRisk, computeFundingPercentile } from "../../src/lib/sentiment/positioning";
import { oiPercentileFromHistory } from "../../src/lib/history/store";
import { computeLeverageHeat } from "../../src/lib/sentiment/compositeIndex";
import { buildMarketThesis, MarketThesisInputs } from "../../src/lib/sentiment/marketThesis";
import { LocalHistoryPoint } from "../../src/types/market";

/**
 * Replay harness. Calls the REAL production scoring functions
 * (computeSqueezeRisk, buildMarketThesis, computeFundingPercentile,
 * oiPercentileFromHistory, computeLeverageHeat) against reconstructed
 * historical inputs — nothing here reimplements any scoring logic.
 *
 * The evaluable window is bounded by OKX's open-interest/long-short history,
 * which is hard-capped at 180 daily points with no pagination (confirmed by
 * direct request — see fetchHistory.mjs's header). The first 48 days of that
 * window are reserved as a lookback burn-in for oiPercentileFromHistory,
 * which refuses to return a percentile below 48 points, matching the
 * production function unmodified. The last 7 days are reserved so every
 * evaluated day has a real 7-day-forward price to label it with.
 *
 * Every input is built from data strictly BEFORE the day being evaluated —
 * matching aggregator.ts's "prior" convention (percentiles rank the current
 * reading against everything before it, never including it) — so nothing
 * here leaks future information into a score.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DAY_MS = 86_400_000;
const OI_BURN_IN_DAYS = 48; // oiPercentileFromHistory's own minimum
const FORWARD_BUFFER_DAYS = 7; // longest labeled horizon

interface RawAssetData {
  asset: "BTC" | "ETH";
  futuresKlines: Array<{ t: number; close: number }>;
  spotKlines: Array<{ t: number; close: number }>;
  fundingRate: Array<{ t: number; fundingRatePct: number }>;
  oiHistory: Array<{ t: number; oiUsd: number }>;
  longShortHistory: Array<{ t: number; ratio: number }>;
}

/** Nearest series entry at or before `t`, or null if the series doesn't reach back that far. */
function atOrBefore<T extends { t: number }>(series: T[], t: number): T | null {
  let result: T | null = null;
  for (const p of series) {
    if (p.t > t) break;
    result = p;
  }
  return result;
}

/** Closest entry to `targetT` within `toleranceMs`, for "price ~24h ago" style lookups. */
function closestWithin<T extends { t: number }>(series: T[], targetT: number, toleranceMs: number): T | null {
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const p of series) {
    const delta = Math.abs(p.t - targetT);
    if (delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
    if (p.t - targetT > toleranceMs) break; // series is sorted ascending; no point checking further
  }
  return bestDelta <= toleranceMs ? best : null;
}

/** Minimal LocalHistoryPoint — only the field each caller actually reads is meaningful; the rest are unused placeholders required by the shared type. */
function fundingPoint(t: number, fundingRatePct: number): LocalHistoryPoint {
  return { t, totalOpenInterestUsd: 0, weightedFundingRatePct: fundingRatePct, price: 0, longShortRatio: null, venueCount: 1 };
}
function oiPoint(t: number, oiUsd: number): LocalHistoryPoint {
  return { t, totalOpenInterestUsd: oiUsd, weightedFundingRatePct: 0, price: 0, longShortRatio: null, venueCount: 1 };
}

interface DayRecord {
  asset: string;
  date: string;
  t: number;
  weightedFundingRatePct: number;
  fundingPercentile: number | null;
  oiPercentile: number | null;
  oiChange24hPct: number | null;
  longShortRatio: number | null;
  priceChange24hPct: number;
  basisPct: number | null;
  squeezeScore: number | null;
  squeezeSide: string | null;
  thesisRegime: string | null;
  thesisConviction: number | null;
  forwardReturn1d: number | null;
  forwardReturn3d: number | null;
  forwardReturn7d: number | null;
}

function forwardReturn(futuresKlines: Array<{ t: number; close: number }>, fromT: number, days: number): number | null {
  const startPrice = closestWithin(futuresKlines, fromT, 3 * 3_600_000)?.close;
  const endPoint = closestWithin(futuresKlines, fromT + days * DAY_MS, 3 * 3_600_000);
  if (!startPrice || !endPoint) return null;
  return ((endPoint.close - startPrice) / startPrice) * 100;
}

function replayAsset(data: RawAssetData): DayRecord[] {
  const { asset, futuresKlines, spotKlines, fundingRate, oiHistory, longShortHistory } = data;
  const records: DayRecord[] = [];

  const lastEvalIndex = oiHistory.length - 1 - FORWARD_BUFFER_DAYS;

  for (let i = OI_BURN_IN_DAYS; i <= lastEvalIndex; i++) {
    const t = oiHistory[i].t;
    const priorOi = oiHistory.slice(0, i).map((p) => oiPoint(p.t, p.oiUsd));
    const priorFunding = fundingRate.filter((p) => p.t < t).map((p) => fundingPoint(p.t, p.fundingRatePct));

    const currentFunding = atOrBefore(fundingRate, t);
    if (!currentFunding) continue; // shouldn't happen inside the aligned window, but skip rather than fabricate

    const currentPrice = atOrBefore(futuresKlines, t)?.close;
    const priceOneDayAgo = closestWithin(futuresKlines, t - DAY_MS, 3 * 3_600_000)?.close;
    if (!currentPrice || !priceOneDayAgo) continue;
    const priceChange24hPct = ((currentPrice - priceOneDayAgo) / priceOneDayAgo) * 100;

    const currentOi = oiHistory[i].oiUsd;
    const oiOneDayAgo = oiHistory[i - 1]?.oiUsd ?? null;
    const oiChange24hPct = oiOneDayAgo ? ((currentOi - oiOneDayAgo) / oiOneDayAgo) * 100 : null;

    const fundingPercentile = computeFundingPercentile(currentFunding.fundingRatePct, priorFunding);
    const oiPercentile = oiPercentileFromHistory(priorOi, currentOi);

    const longShortEntry = atOrBefore(longShortHistory, t);
    const longShortRatio = longShortEntry?.ratio ?? null;

    const spotPrice = atOrBefore(spotKlines, t)?.close ?? null;
    const basisPct = spotPrice ? ((currentPrice - spotPrice) / spotPrice) * 100 : null;

    const leverageHeatScore = computeLeverageHeat({
      weightedFundingRatePct: currentFunding.fundingRatePct,
      oiChange24hPct,
      priceChange24hPct,
    });

    const squeezeRisk = computeSqueezeRisk({
      weightedFundingRatePct: currentFunding.fundingRatePct,
      fundingPercentile,
      oiPercentile,
      oiChange24hPct,
      longShortRatio,
      priceChange24hPct,
    });

    const thesisInputs: MarketThesisInputs = {
      asset: asset as "BTC" | "ETH",
      weightedFundingRatePct: currentFunding.fundingRatePct,
      longShortRatio,
      basisPct,
      coinbasePremiumPct: null, // no historical source — see plan doc
      orderFlow: null, // no historical source — OKX rubik taker-volume only retains ~4 days
      squeezeRisk,
      deribitOptions: null, // no historical source found
      exchangeFlow: null, // this app's own recorder has no depth yet
      /*
       * Left null for now even though the raw material EXISTS here — the
       * Binance klines already fetched above could be rolled up to daily
       * bars and run through buildTechnicalRead. Wiring that in is a
       * deliberate follow-up rather than a data gap like the entries above.
       *
       * Until then, every regime statistic this harness produces describes
       * the thesis WITHOUT price-action evidence, while the live site now
       * includes it at weight 0.14. The two will disagree, and the report's
       * regime table should be regenerated once this is connected.
       */
      technicals: null,
      liquidations: null,
      priceChange24hPct,
      leverageHeatScore,
    };
    const thesis = buildMarketThesis(thesisInputs, t);

    records.push({
      asset,
      date: new Date(t).toISOString().slice(0, 10),
      t,
      weightedFundingRatePct: currentFunding.fundingRatePct,
      fundingPercentile,
      oiPercentile,
      oiChange24hPct,
      longShortRatio,
      priceChange24hPct,
      basisPct,
      squeezeScore: squeezeRisk?.score ?? null,
      squeezeSide: squeezeRisk?.side ?? null,
      thesisRegime: thesis?.regime ?? null,
      thesisConviction: thesis?.conviction ?? null,
      forwardReturn1d: forwardReturn(futuresKlines, t, 1),
      forwardReturn3d: forwardReturn(futuresKlines, t, 3),
      forwardReturn7d: forwardReturn(futuresKlines, t, 7),
    });
  }

  return records;
}

function main() {
  const allRecords: DayRecord[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const filePath = path.join(DATA_DIR, `${asset}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing ${filePath} — run "npm run backtest:fetch" first.`);
      process.exit(1);
    }
    const data: RawAssetData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const records = replayAsset(data);
    console.log(`[run] ${asset}: ${records.length} evaluable days (${records[0]?.date} to ${records[records.length - 1]?.date})`);
    allRecords.push(...records);
  }

  fs.writeFileSync(path.join(DATA_DIR, "results.json"), JSON.stringify(allRecords, null, 2));
  console.log(`[run] wrote ${allRecords.length} total day-records to scripts/backtest/data/results.json`);
}

main();
