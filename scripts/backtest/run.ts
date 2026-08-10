import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeSqueezeRisk, computeFundingPercentile } from "../../src/lib/sentiment/positioning";
import { oiPercentileFromHistory } from "../../src/lib/history/store";
import { computeLeverageHeat } from "../../src/lib/sentiment/compositeIndex";
import { buildMarketThesis, MarketThesisInputs } from "../../src/lib/sentiment/marketThesis";
import { buildTechnicalRead } from "../../src/lib/sentiment/technicals";
import { Candle } from "../../src/lib/technicals/indicators";
import { evaluateAll, SignalContext } from "../../src/lib/signals/evaluators";
import { classifyRegime, regimeTagsToStrings } from "../../src/lib/technicals/regimes";
import { buildMarketBias } from "../../src/lib/signals/marketBias";
import { buildVolumeProfile, buildSupportResistanceZones } from "../../src/lib/technicals/marketStructure";
import { buildTradeRecommendation } from "../../src/lib/signals/tradeRecommendation";
import { buildEntryQuality } from "../../src/lib/signals/entryQuality";
import { technicalAgreement } from "../../src/lib/sentiment/technicals";
import { resolveTrade, HourBar } from "./execution";
import { applyCosts, DEFAULT_COST_CONFIG } from "./costs";
import { LocalHistoryPoint, AggregateMarketData, ExchangeSnapshot, FearGreed, EtfFlowSummary } from "../../src/types/market";
import type { StablecoinSummary } from "../../src/lib/providers/stablecoins";
import { classifyLiquidityRegime, classifyRiskRegime, MacroLiquiditySnapshot } from "../../src/lib/providers/macroLiquidity";

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

/**
 * How many candles the LIVE dashboard actually sees — okxCandles.ts's
 * `CANDLE_LIMIT`, which OKX hard-caps with no pagination.
 *
 * This matters far more than it looks. Handing the replay every candle
 * since 2021 while the live site only ever sees the last 300 doesn't make
 * the backtest "more informed" — it makes it a backtest of a DIFFERENT
 * engine. Measured directly before this constant was introduced: at one
 * sampled day, unbounded history produced 25 support/resistance zones
 * where the live 300-bar window produced 12, so a backtested stop could be
 * placed against a four-year-old swing level today's dashboard physically
 * cannot see.
 *
 * Applied to the two series whose output genuinely changes with window
 * length (S/R zones and the 4H read). Deliberately NOT applied to the
 * existing daily `buildTechnicalRead` call below: the same measurement
 * showed its differences are pure EMA warm-up convergence — RSI agreeing
 * to ten significant figures, identical divergence classifications — so
 * capping it would rewrite every already-published statistic in exchange
 * for no behavioural difference at all.
 */
const LIVE_CANDLE_LIMIT = 300;

/** Longest a replayed trade is held before being closed at market — matches the forward buffer above, so every ENTER day has the bars needed to resolve it. */
const MAX_HOLD_MS = FORWARD_BUFFER_DAYS * DAY_MS;

interface HourlyBar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

interface SpotBar {
  t: number;
  close: number;
  volumeUsd: number;
}

export interface RawAssetData {
  asset: "BTC" | "ETH";
  futuresKlines: HourlyBar[];
  spotKlines: SpotBar[];
  fundingRate: Array<{ t: number; fundingRatePct: number }>;
  oiHistory: Array<{ t: number; oiUsd: number }>;
  longShortHistory: Array<{ t: number; ratio: number }>;
  etfFlows: Array<{ t: number; netFlowUsd: number }>;
}

export interface MarketWideData {
  fearGreed: Array<{ t: number; value: number }>;
  stablecoins: Array<{ t: number; totalUsd: number }>;
  nfci: Array<{ t: number; value: number }>;
  t10y2y: Array<{ t: number; value: number }>;
  rrp: Array<{ t: number; value: number }>; // billions of USD
  tga: Array<{ t: number; value: number }>; // millions of USD (WTREGEN units)
  effr: Array<{ t: number; value: number }>;
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

/**
 * Switches for ABLATION ONLY. Defaults reproduce the shipped engine
 * byte-for-byte, so `npm run backtest` is unaffected — every variant below
 * exists so a component can be measured against its own absence, not so the
 * production engine can be quietly reconfigured.
 */
export interface ReplayConfig {
  /**
   * false passes `regimeTags: null` into buildMarketBias, which is exactly
   * how regimeAdjustedCategoryWeights disables itself (see regimeWeights.ts).
   * Regime tags are still RECORDED on every DayRecord either way, so the
   * two variants stay directly comparable segment-for-segment.
   */
  useRegimeWeights: boolean;
  /**
   * Downgrades an ENTER to its wait state when the 4H read WEAKENS the
   * thesis. Phase 3 measured "weakens" as the worst multi-timeframe state
   * (-0.248%/trade vs +0.039% for confirms); Phase 1 already treats it as a
   * caveat. This tests whether it should be a gate instead.
   */
  requireMtfNotWeakening: boolean;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  useRegimeWeights: true,
  requireMtfNotWeakening: false,
};

export interface DayRecord {
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
  /** The decision engine's overall read — buildMarketBias, not buildMarketThesis. */
  biasScore: number | null;
  biasVerdict: string | null;
  biasConfidence: number | null;
  /** How much the metrics concur with each other — a DIFFERENT number from biasConfidence (evidence quality), see marketBias.ts's own doc comment. */
  biasAgreement: number | null;
  /** One entry per category that reported, for the category-level backtest report. */
  categories: Array<{ category: string; score: number; verdict: string }>;
  /**
   * One entry per metric that fired that day (evaluateAll's output, id +
   * verdict only) — the raw material report.ts's hypothesis section needs
   * to bucket occurrences by metric, paired with the forward returns below.
   * Not stored anywhere else: `categories` is a rollup, this is the flat
   * per-metric list underneath it.
   */
  metrics: Array<{ id: string; verdict: string }>;
  /** Independent trend/volatility/range-bound tags for this day — see regimes.ts. */
  regimeTags: string[];
  /**
   * The Phase 1 execution layer, replayed rather than re-derived:
   * `buildTradeRecommendation`'s own 5-state action and, when it cleared to
   * an ENTER, `buildEntryQuality`'s own levels. Until this existed, the
   * dashboard's actual instructions ("ENTER LONG, stop here, target there")
   * had never been measured against history at all — only the directional
   * verdict underneath them had.
   */
  action: string | null;
  /** How the 4H read lined up with the thesis — the MTF caveat's own input, kept for regime/failure-mode segmentation. */
  agreement4h: string | null;
  entryStars: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  target2Price: number | null;
  riskRewardRatio: number | null;
  /**
   * What actually became of that plan, resolved against real forward hourly
   * bars (see execution.ts). Null when the day produced no ENTER, when no
   * honest plan could be placed, or when the forward window had no bars —
   * never a fabricated flat outcome.
   */
  trade: {
    side: "long" | "short";
    outcome: string;
    grossReturnPct: number;
    netReturnPct: number;
    feeAndSlippagePct: number;
    fundingCostPct: number;
    mfePct: number;
    maePct: number;
    hoursToTarget: number | null;
    hoursToStop: number | null;
    hoursHeld: number;
    tp2ReachedBeforeStop: boolean;
    ambiguousBar: boolean;
  } | null;
  forwardReturn1h: number | null;
  forwardReturn4h: number | null;
  forwardReturn1d: number | null;
  forwardReturn3d: number | null;
  forwardReturn7d: number | null;
}

/**
 * `toleranceMs` is deliberately half the series' own bar spacing: wide
 * enough to tolerate a bar landing a bit early/late, tight enough that a 1h
 * lookup can never silently match a bar meant for a neighboring hour.
 * Daily forwardReturn calls (1d/3d/7d) keep the original 3h tolerance
 * against hourly bars; the new 1h/4h calls use 30 minutes, half an hourly
 * bar's spacing, for the same reason.
 */
function forwardReturn(
  series: Array<{ t: number; close: number }>,
  fromT: number,
  horizonMs: number,
  toleranceMs: number
): number | null {
  const startPrice = closestWithin(series, fromT, toleranceMs)?.close;
  const endPoint = closestWithin(series, fromT + horizonMs, toleranceMs);
  if (!startPrice || !endPoint) return null;
  return ((endPoint.close - startPrice) / startPrice) * 100;
}

/**
 * Rolls hourly bars up into daily candles, so the replay can run the SAME
 * `buildTechnicalRead` the live site uses (which expects daily bars from
 * OKX). Grouped by UTC calendar day: open from the first hour, close from
 * the last, high/low as extremes, volume summed.
 *
 * Partial days are dropped. The live provider discards OKX's unconfirmed
 * bar for the same reason — a half-finished day understates volume badly
 * enough to flip the volume-ratio read on its own.
 */
function rollUpToDaily(hourly: HourlyBar[]): Candle[] {
  const byDay = new Map<string, HourlyBar[]>();
  for (const bar of hourly) {
    const key = new Date(bar.t).toISOString().slice(0, 10);
    const existing = byDay.get(key);
    if (existing) existing.push(bar);
    else byDay.set(key, [bar]);
  }

  const out: Candle[] = [];
  for (const [key, bars] of Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (bars.length < 24) continue; // incomplete day
    bars.sort((a, b) => a.t - b.t);
    out.push({
      t: Date.parse(`${key}T00:00:00Z`),
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volumeUsd: bars.reduce((s, b) => s + b.volumeUsd, 0),
    });
  }
  return out;
}

/**
 * Rolls hourly bars up into 4-hour candles, so the replay can run the same
 * `buildTechnicalRead` against a higher timeframe that the live site runs
 * against OKX's native 4H series — closing the multi-timeframe gap that
 * previously forced `technicals4h: null` here.
 *
 * Buckets are aligned to UTC 00:00 and only complete 4-bar groups are kept,
 * the same "no partial candles" rule `rollUpToDaily` already applies and
 * for the same reason. Disclosed methodology difference: these are
 * Binance-derived where the live 4H read is OKX-native, exactly the venue
 * difference the daily series above already carries.
 */
function rollUpTo4h(hourly: HourlyBar[]): Candle[] {
  const FOUR_HOURS_MS = 4 * 3_600_000;
  const byBucket = new Map<number, HourlyBar[]>();
  for (const bar of hourly) {
    const key = Math.floor(bar.t / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    const existing = byBucket.get(key);
    if (existing) existing.push(bar);
    else byBucket.set(key, [bar]);
  }

  const out: Candle[] = [];
  for (const [key, bars] of Array.from(byBucket.entries()).sort((a, b) => a[0] - b[0])) {
    if (bars.length < 4) continue; // incomplete bucket
    bars.sort((a, b) => a.t - b.t);
    out.push({
      t: key,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volumeUsd: bars.reduce((s, b) => s + b.volumeUsd, 0),
    });
  }
  return out;
}

/**
 * Reconstructs a `FearGreed` reading as of `t` from the daily alternative.me
 * series. Classification buckets match the service's own published
 * thresholds — cosmetic text only, since `evaluateFearGreed` scores purely
 * off the numeric value, never the label.
 */
function fearGreedAt(series: MarketWideData["fearGreed"], t: number): FearGreed | null {
  const point = closestWithin(series, t, DAY_MS);
  if (!point) return null;
  const classification =
    point.value <= 25 ? "Extreme Fear" : point.value <= 45 ? "Fear" : point.value <= 55 ? "Neutral" : point.value <= 75 ? "Greed" : "Extreme Greed";
  return { value: point.value, classification, updatedAt: point.t };
}

/**
 * Reconstructs a MacroLiquiditySnapshot as of `t` from each FRED series'
 * most recently published value at or before `t`, then calls the REAL
 * production classifier functions (classifyLiquidityRegime,
 * classifyRiskRegime) — not reimplemented here, matching this file's own
 * rule of calling the real scoring logic rather than duplicating it.
 */
function macroLiquidityAt(marketWide: MarketWideData, t: number): MacroLiquiditySnapshot | null {
  const nfci = atOrBefore(marketWide.nfci, t);
  const t10y2y = atOrBefore(marketWide.t10y2y, t);
  const effr = atOrBefore(marketWide.effr, t);
  const rrpNow = atOrBefore(marketWide.rrp, t);
  const rrpPrior = atOrBefore(marketWide.rrp, t - 14 * DAY_MS);
  const tgaNow = atOrBefore(marketWide.tga, t);
  const tgaPrior = atOrBefore(marketWide.tga, t - 14 * DAY_MS);

  const rrpChangeBn = rrpNow && rrpPrior ? rrpNow.value - rrpPrior.value : null;
  const tgaChangeBn = tgaNow && tgaPrior ? (tgaNow.value - tgaPrior.value) / 1000 : null;
  const combinedSinkChangeBn = rrpChangeBn === null && tgaChangeBn === null ? null : (rrpChangeBn ?? 0) + (tgaChangeBn ?? 0);

  if (!nfci && !t10y2y && rrpChangeBn === null && tgaChangeBn === null) return null;

  return {
    nfci: nfci ? { date: new Date(nfci.t).toISOString().slice(0, 10), value: nfci.value } : null,
    t10y2y: t10y2y ? { date: new Date(t10y2y.t).toISOString().slice(0, 10), value: t10y2y.value } : null,
    effr: effr ? { date: new Date(effr.t).toISOString().slice(0, 10), value: effr.value } : null,
    rrpChangeBn,
    tgaChangeBn,
    liquidityRegime: classifyLiquidityRegime(combinedSinkChangeBn),
    riskRegime: classifyRiskRegime(nfci?.value ?? null, t10y2y?.value ?? null),
    updatedAt: t,
  };
}

/** Reconstructs `netChange7dPct` exactly as providers/stablecoins.ts defines it: (now - 7d ago) / 7d ago. */
function stablecoinsAt(series: MarketWideData["stablecoins"], t: number): StablecoinSummary | null {
  const now = closestWithin(series, t, DAY_MS);
  const weekAgo = closestWithin(series, t - 7 * DAY_MS, DAY_MS);
  if (!now || !weekAgo || weekAgo.totalUsd <= 0) return null;
  const netChange7dUsd = now.totalUsd - weekAgo.totalUsd;
  return {
    totalMcapUsd: now.totalUsd,
    // Not computed historically — the evaluator's verdict only reads the
    // 7-day figure below, never the 24h one.
    netChange24hUsd: 0,
    netChange24hPct: 0,
    netChange7dUsd,
    netChange7dPct: (netChange7dUsd / weekAgo.totalUsd) * 100,
    topIssuers: [],
    updatedAt: now.t,
  };
}

/** Mean absolute flow over the ~60 sessions strictly before `t` — mirrors etfFlows.ts's own definition. */
function typicalAbsFlow(series: RawAssetData["etfFlows"], t: number): number {
  const prior = series.filter((p) => p.t < t).slice(-60);
  if (prior.length === 0) return 0;
  return prior.reduce((s, p) => s + Math.abs(p.netFlowUsd), 0) / prior.length;
}

function etfFlowsAt(series: RawAssetData["etfFlows"], t: number, asset: "BTC" | "ETH"): EtfFlowSummary | null {
  const latest = atOrBefore(series, t);
  if (!latest) return null;
  const window = series.filter((p) => p.t <= t).slice(-5);
  const netFlow5dUsd = window.reduce((s, p) => s + p.netFlowUsd, 0);
  const ageDays = Math.round((t - latest.t) / DAY_MS);
  return {
    asset,
    latestDate: new Date(latest.t).toISOString().slice(0, 10),
    netFlowUsd: latest.netFlowUsd,
    netFlow5dUsd,
    totalNetAssetsUsd: 0, // not fetched historically; never read by the evaluator
    typicalAbsFlowUsd: typicalAbsFlow(series, t),
    isStale: ageDays > 4,
    ageDays,
  };
}

/**
 * A single fixed venue, standing in for "how many independent sources back
 * this reading" — the funding evaluator's confidence scales with
 * `exchanges.length`. Using exactly one is the honest answer for this
 * backtest: funding here comes from Binance alone (see report.ts's
 * methodology note), so claiming more venues than that would overstate
 * confidence beyond what the historical data actually supports.
 */
function singleVenueExchanges(asset: "BTC" | "ETH", t: number): ExchangeSnapshot[] {
  return [
    {
      exchangeId: "binance",
      asset,
      fundingRatePct: 0,
      fundingIntervalHours: 8,
      nextFundingAt: t,
      openInterestUsd: 0,
      openInterestChange24hPct: null,
      volume24hUsd: 0,
      longShortRatio: null,
      price: 0,
      priceChange24hPct: 0,
      sparkline: [],
      fundingHistory: [],
      updatedAt: t,
    },
  ];
}

/**
 * `windowStart`/`windowEnd` (ms, inclusive/exclusive) restrict WHICH days get
 * evaluated and reported — not what data backs each day's computation. Every
 * percentile/prior-history read below still draws on the FULL underlying
 * series regardless of the window, exactly as a live, non-windowed run
 * would: a rolling window asks "how did the signals behave during this
 * stretch," using the model's normal history-relative math, not an
 * artificially amnesiac version of it. `undefined` (the default) evaluates
 * every day the burn-in/buffer bounds allow — byte-for-byte the same as
 * before this parameter existed, so the single-window `backtest` script
 * needs zero changes.
 */
export function replayAsset(
  data: RawAssetData,
  marketWide: MarketWideData,
  windowStart?: number,
  windowEnd?: number,
  config: ReplayConfig = DEFAULT_REPLAY_CONFIG
): DayRecord[] {
  const { asset, futuresKlines, spotKlines, fundingRate, oiHistory, longShortHistory, etfFlows } = data;
  const records: DayRecord[] = [];

  const dailyCandles = rollUpToDaily(futuresKlines);
  const fourHourCandles = rollUpTo4h(futuresKlines);
  // Date-string -> index, so each evaluated day can look up its OWN candle
  // (not a prior one) for regime classification — describing conditions AS
  // OF t is not lookahead; only forward returns (computed from data AFTER
  // t) would be.
  const dailyCandleIndex = new Map(dailyCandles.map((c, idx) => [new Date(c.t).toISOString().slice(0, 10), idx]));
  const lastEvalIndex = oiHistory.length - 1 - FORWARD_BUFFER_DAYS;

  for (let i = OI_BURN_IN_DAYS; i <= lastEvalIndex; i++) {
    const t = oiHistory[i].t;
    if (windowStart !== undefined && t < windowStart) continue;
    if (windowEnd !== undefined && t >= windowEnd) continue;
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

    // Computed here (not just at record-push time below) so the SAME
    // classification feeds both thesisInputs.regimeTags and DayRecord's
    // string-tag array — one classification per day, not two.
    const candleIdx = dailyCandleIndex.get(new Date(t).toISOString().slice(0, 10));
    const regime = candleIdx !== undefined ? classifyRegime(dailyCandles, candleIdx) : null;

    /*
     * Every candle series the decision engine reads, cut off strictly
     * before this evaluation day. Hoisted so the technical read, the 4H
     * read and the support/resistance zones all provably share ONE cutoff
     * — three separate inline filters would be three separate chances to
     * get the boundary wrong.
     */
    const priorDaily = dailyCandles.filter((c) => c.t < t);
    const liveWindowDaily = priorDaily.slice(-LIVE_CANDLE_LIMIT);
    const prior4h = fourHourCandles.filter((c) => c.t < t).slice(-LIVE_CANDLE_LIMIT);

    const technicals4h = prior4h.length > 0 ? buildTechnicalRead(prior4h) : null;
    const volumeProfile = buildVolumeProfile(liveWindowDaily);
    const supportResistance = buildSupportResistanceZones(liveWindowDaily, volumeProfile);

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
       * Only bars that CLOSED strictly before this evaluation day, so the
       * technical read can't see the day it is being used to score.
       */
      technicals: buildTechnicalRead(priorDaily),
      liquidations: null,
      priceChange24hPct,
      leverageHeatScore,
      regimeTags: regime,
    };
    const thesis = buildMarketThesis(thesisInputs, t);

    /*
     * The decision engine's own read — evaluateAll() + buildMarketBias(),
     * the exact production functions, never a reimplementation. Requires an
     * AggregateMarketData-shaped object; fields with no historical source
     * (liquidations, poolExposure, fundingDivergence, cexDex, deribitOptions,
     * orderFlow, exchangeFlow, coinbasePremiumPct) are null/empty, exactly
     * like the live aggregator already sends when a provider fails —
     * evaluators already handle this by returning null and being dropped.
     */
    const technicals = thesisInputs.technicals;
    const etfSummary = etfFlowsAt(etfFlows, t, asset as "BTC" | "ETH");
    const spotBar = atOrBefore(spotKlines, t);
    const spotPerpVolume =
      spotBar && spotBar.volumeUsd > 0 && currentPrice
        ? {
            spotVolumeUsd: spotBar.volumeUsd,
            // Same-venue principle as the live fix (see aggregator.ts's
            // buildSpotPerpVolume comment): both legs come from Binance
            // here, since that's the only venue with deep historical OHLCV.
            // The live site pairs OKX/OKX instead — a disclosed venue
            // difference, not a methodology difference.
            perpVolumeUsd: atOrBefore(futuresKlines, t)?.volumeUsd ?? 0,
            spotToPerpRatio:
              (atOrBefore(futuresKlines, t)?.volumeUsd ?? 0) > 0
                ? spotBar.volumeUsd / (atOrBefore(futuresKlines, t)?.volumeUsd ?? 1)
                : 0,
          }
        : null;

    const fakeAggregate: AggregateMarketData = {
      asset: asset as "BTC" | "ETH",
      weightedFundingRatePct: currentFunding.fundingRatePct,
      fundingAnnualizedPct: 0,
      fundingChange24hPct: null,
      totalOpenInterestUsd: currentOi,
      oiChange24hPct,
      oiPercentile,
      longShortRatio,
      leverageHeatScore,
      priceChange24hPct,
      exchanges: singleVenueExchanges(asset as "BTC" | "ETH", t),
      unavailableExchanges: [],
      spotPriceUsd: spotPrice,
      spotSource: spotPrice ? "binance-archive" : null,
      basisPct,
      spotDisagreementPct: null,
      spotSourceCount: spotPrice ? 1 : 0,
      coinbasePremiumPct: null,
      poolExposure: null,
      fundingPercentile,
      fundingDivergence: null,
      cexDex: null,
      squeezeRisk,
      liquidations: null,
      orderFlow: null,
      spotCvd: null, // live-only metric, no historical source — see spotCvd.ts
      exchangeFlow: null,
      exchangeFlowConfigured: false,
      deribitOptions: null,
      marketThesis: thesis,
      technicals,
      /*
       * Both of these were `null` until Phase 3, on the belief that neither
       * had a historical source. Both beliefs were wrong:
       *
       *  - 4H candles don't need OKX's 300-bar live endpoint at all; they
       *    roll up from the hourly klines already on disk (rollUpTo4h).
       *  - Support/resistance is a pure function of daily candles
       *    (buildSupportResistanceZones), which this replay already builds.
       *
       * Filling them in is what makes an execution backtest possible: the
       * action gate reads technicals4h for its MTF caveat, and every
       * entry/stop/target level is derived from these zones.
       */
      technicals4h,
      liquidityMap: { volumeProfile, supportResistance },
      etfFlows: etfSummary,
      spotPerpVolume,
      marketBias: null,
      biasTimeline: [],
      history: [],
      historyHours: 0,
      updatedAt: t,
    };

    const signalContext: SignalContext = {
      technicals,
      stablecoins: stablecoinsAt(marketWide.stablecoins, t),
      fearGreed: fearGreedAt(marketWide.fearGreed, t),
      sectorBreadth: null, // live-only metric, no historical source — see sectorBreadth.ts
      macroLiquidity: macroLiquidityAt(marketWide, t),
      hyperliquidConfirm: null, // point-in-time order book + live-only confirmation modifier, no historical source — see hyperliquidConfirm.ts
      priceChange24hPct,
      now: t,
    };

    const metricVerdicts = evaluateAll(fakeAggregate, signalContext);
    const bias = buildMarketBias({
      asset,
      metrics: metricVerdicts,
      technicals,
      squeezeScore: squeezeRisk?.score ?? null,
      previous: null, // no sequential "what changed" concept in a batch replay
      now: t,
      // Same `regime` this loop already computes for DayRecord.regimeTags
      // below. Nulled under the fixed-weight ablation variant, which is
      // precisely how regimeWeights.ts turns itself off.
      regimeTags: config.useRegimeWeights ? regime : null,
    });

    const regimeTags = regime ? regimeTagsToStrings(regime) : [];

    /*
     * The Phase 1 execution layer, replayed through the REAL production
     * functions — same rule this file has always followed for the scoring
     * layer. This is the part of the dashboard a trader actually acts on,
     * and until now it was the only part never measured.
     */
    const recommendation = bias ? buildTradeRecommendation(bias, thesis, technicals, technicals4h) : null;
    const agreement4h = thesis && technicals4h ? technicalAgreement(technicals4h, thesis.dominant) : null;

    /*
     * The selectivity ablation. `buildTradeRecommendation` ships this as a
     * non-blocking caveat by explicit Phase 1 design; this variant asks
     * what would have happened had it blocked. Applied AFTER the real
     * function runs, so the production logic is never edited to serve a
     * backtest.
     */
    const mtfBlocked = config.requireMtfNotWeakening && agreement4h === "weakens";
    const isEnter =
      !mtfBlocked && (recommendation?.action === "enter-long" || recommendation?.action === "enter-short");

    /*
     * `historicalWinRatePct` is deliberately null rather than read from the
     * shipped backtestStats.json. Those stats are computed ACROSS THE WHOLE
     * WINDOW, so feeding them to a 2023 replay day would leak that day's
     * own future into its star rating — textbook look-ahead. The win rate
     * only feeds the star score, never the levels, so entry/stop/targets
     * here are identical to live; only the stars differ, and they differ in
     * the honest direction (a neutral 0.5 component instead of a
     * future-informed one).
     */
    const entryQuality =
      bias && isEnter
        ? buildEntryQuality({
            verdict: bias.verdict,
            confidence: bias.confidence,
            agreement: bias.agreement,
            price: currentPrice,
            atrPct: technicals?.atrPct ?? null,
            supportResistance,
            historicalWinRatePct: null,
            historicalWinRateN: null,
          })
        : null;

    const side = recommendation?.action === "enter-long" ? "long" : "short";
    const resolution =
      entryQuality &&
      resolveTrade(
        {
          side,
          entryPrice: entryQuality.entryPrice,
          stopPrice: entryQuality.stopPrice,
          targetPrice: entryQuality.targetPrice,
          target2Price: entryQuality.target2Price,
          entryT: t,
        },
        futuresKlines as HourBar[],
        MAX_HOLD_MS
      );

    const costed = resolution ? applyCosts(resolution.grossReturnPct, side, t, resolution.exitT, fundingRate, DEFAULT_COST_CONFIG) : null;

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
      biasScore: bias?.score ?? null,
      biasVerdict: bias?.verdict ?? null,
      biasConfidence: bias?.confidence ?? null,
      biasAgreement: bias?.agreement ?? null,
      categories: (bias?.categories ?? []).map((c) => ({ category: c.category, score: c.score, verdict: c.verdict })),
      metrics: metricVerdicts.map((m) => ({ id: m.id, verdict: m.verdict })),
      regimeTags,
      action: mtfBlocked
        ? recommendation?.action === "enter-long"
          ? "wait-long-confirmation"
          : "wait-short-confirmation"
        : (recommendation?.action ?? null),
      agreement4h,
      entryStars: entryQuality?.stars ?? null,
      entryPrice: entryQuality?.entryPrice ?? null,
      stopPrice: entryQuality?.stopPrice ?? null,
      targetPrice: entryQuality?.targetPrice ?? null,
      target2Price: entryQuality?.target2Price ?? null,
      riskRewardRatio: entryQuality?.riskRewardRatio ?? null,
      trade:
        resolution && costed
          ? {
              side,
              outcome: resolution.outcome,
              grossReturnPct: costed.grossReturnPct,
              netReturnPct: costed.netReturnPct,
              feeAndSlippagePct: costed.feeAndSlippagePct,
              fundingCostPct: costed.fundingCostPct,
              mfePct: resolution.mfePct,
              maePct: resolution.maePct,
              hoursToTarget: resolution.hoursToTarget,
              hoursToStop: resolution.hoursToStop,
              hoursHeld: resolution.hoursHeld,
              tp2ReachedBeforeStop: resolution.tp2ReachedBeforeStop,
              ambiguousBar: resolution.ambiguousBar,
            }
          : null,
      forwardReturn1h: forwardReturn(futuresKlines, t, 1 * 3_600_000, 30 * 60_000),
      forwardReturn4h: forwardReturn(futuresKlines, t, 4 * 3_600_000, 30 * 60_000),
      forwardReturn1d: forwardReturn(futuresKlines, t, 1 * DAY_MS, 3 * 3_600_000),
      forwardReturn3d: forwardReturn(futuresKlines, t, 3 * DAY_MS, 3 * 3_600_000),
      forwardReturn7d: forwardReturn(futuresKlines, t, 7 * DAY_MS, 3 * 3_600_000),
    });
  }

  return records;
}

function main() {
  const marketPath = path.join(DATA_DIR, "MARKET.json");
  if (!fs.existsSync(marketPath)) {
    console.error(`Missing ${marketPath} — run "npm run backtest:fetch" first.`);
    process.exit(1);
  }
  const marketWide: MarketWideData = JSON.parse(fs.readFileSync(marketPath, "utf8"));

  const allRecords: DayRecord[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const filePath = path.join(DATA_DIR, `${asset}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing ${filePath} — run "npm run backtest:fetch" first.`);
      process.exit(1);
    }
    const data: RawAssetData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const records = replayAsset(data, marketWide);
    console.log(`[run] ${asset}: ${records.length} evaluable days (${records[0]?.date} to ${records[records.length - 1]?.date})`);
    allRecords.push(...records);
  }

  fs.writeFileSync(path.join(DATA_DIR, "results.json"), JSON.stringify(allRecords, null, 2));
  console.log(`[run] wrote ${allRecords.length} total day-records to scripts/backtest/data/results.json`);
}

// Guarded, not unconditional: rolling.ts imports `replayAsset` from this
// module, and an unconditional call here would run this file's OWN full
// unbounded replay (plus overwrite results.json) as a side effect of that
// import — confirmed happening before this guard was added. Same pattern
// already used in combinations.ts/weightReview.ts.
if (process.argv[1] && process.argv[1].endsWith("run.ts")) {
  main();
}
