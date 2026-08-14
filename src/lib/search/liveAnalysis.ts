import { Bar } from "@/lib/research/types";
import { MetricVerdict } from "@/lib/signals/types";
import {
  EquityInstrumentInput,
  evaluateRelativeStrength,
  evaluateVolatilityRegime,
  evaluateTrendQuality,
  evaluateMarketStructure,
} from "@/lib/markets/equityEvidence";
import { buildMarketBias } from "@/lib/signals/marketBias";
import { buildTradePlanOutcome, TradePlan, TradePlanRefusal } from "@/lib/signals/tradePlan";
import {
  buildSupportResistanceZones,
  buildVolumeProfile,
  SupportResistanceZone,
} from "@/lib/technicals/marketStructure";
import { atr, Candle } from "@/lib/technicals/indicators";
import { buildTechnicalRead } from "@/lib/sentiment/technicals";
import { buildHarmonicEvidence, selectBestHarmonic } from "@/lib/signals/harmonicEvidence";
import { harmonicMetric, technicalsMetric } from "./chartEvidence";
import { earningsVeto, EarningsCalendar, EarningsVetoResult } from "@/lib/markets/earningsVeto";
import { MarketBias } from "@/lib/signals/types";

/**
 * ANY TICKER, THROUGH THE SAME ENGINE.
 *
 * The precomputed surfaces score a fixed handful of instruments from
 * validated, committed bars. This scores whatever the user typed, from bars
 * fetched a moment ago — and it must reach the SAME answer the snapshot
 * would, or the platform has two engines and one of them is lying.
 *
 * It therefore imports the identical evaluators, the identical
 * `buildMarketBias`, and the identical `buildTradePlanOutcome`. Nothing is
 * reimplemented here. What this module actually owns is narrower and more
 * important:
 *
 *   1. ASSEMBLY — which evidence can be produced for an arbitrary symbol.
 *   2. COVERAGE — saying out loud which families were available and which
 *      were not, so a thin read is visibly thin instead of quietly thin.
 *   3. REFUSAL — declining outright when the history is too short to
 *      support any honest reading at all.
 *
 * ── Why coverage is a first-class output ──────────────────────────────
 *
 * A searched micro-cap and a searched mega-cap render the same layout. The
 * difference between them is not the score, it is what the score was built
 * from — and the reader cannot see that unless it is printed. An unqualified
 * verdict on four modules looks exactly like an unqualified verdict on
 * eighteen, which is how confident-looking pages get built on nothing.
 */

/** Below this many daily bars, no percentile band or structure read is meaningful. */
export const MIN_BARS_FOR_ANALYSIS = 120;

/** Below this, a plan may still be refused but a description is possible. */
export const MIN_BARS_FOR_PLAN = 260;

export interface CoverageFamily {
  label: string;
  available: boolean;
  /** Why it is missing, when it is. Never blank — absence always has a reason. */
  note: string;
}

export interface LiveAnalysis {
  symbol: string;
  name: string;
  assetClass: "equity" | "crypto";
  lastClose: number;
  change24hPct: number;
  asOf: number;
  bias: MarketBias;
  plan: TradePlan | null;
  planRefusal: TradePlanRefusal | null;
  earnings: EarningsVetoResult | null;
  zones: SupportResistanceZone[];
  atrPct: number | null;
  /** What backed this read, and what did not. Always rendered. */
  coverage: CoverageFamily[];
  /** Sessions of history the read is built on. */
  barsUsed: number;
}

export type LiveAnalysisResult =
  | { ok: true; analysis: LiveAnalysis }
  | { ok: false; reason: string };

export interface LiveAnalysisInputs {
  symbol: string;
  name: string;
  assetClass: "equity" | "crypto";
  bars: Bar[];
  /** Trailing benchmark closes for relative strength. Null for crypto, which is not measured against the S&P. */
  benchmarkCloses: Array<{ t: number; close: number }> | null;
  benchmarkSymbol: string;
  /** Breadth and risk appetite — identical for every equity, so they are supplied rather than recomputed. */
  marketWide: MetricVerdict[];
  earningsCalendar: EarningsCalendar | null;
  /** True when this asset genuinely has a funding/open-interest picture. */
  hasDerivatives: boolean;
  now: number;
}

/** Benchmark closes carry no OHLC; the evaluator only reads `t` and `close`, so this shape is sufficient. */
function asBars(closes: Array<{ t: number; close: number }>): Bar[] {
  return closes.map((c) => ({ t: c.t, open: c.close, high: c.close, low: c.close, close: c.close, volume: null }));
}

/**
 * `Bar` (ingest shape, volume may be absent) to `Candle` (technicals shape,
 * USD volume required). Converted explicitly rather than cast: the volume
 * profile weights levels BY volume, so a missing column silently becoming
 * `undefined` would produce levels that look measured and are not. A null
 * volume becomes 0, which contributes no weight — the honest reading of
 * "no volume reported for this bar".
 */
function toCandles(bars: Bar[]): Candle[] {
  return bars.map((b) => ({
    t: b.t,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volumeUsd: (b.volume ?? 0) * b.close,
  }));
}

export function buildLiveAnalysis(inputs: LiveAnalysisInputs): LiveAnalysisResult {
  const { symbol, name, assetClass, bars, benchmarkCloses, benchmarkSymbol, marketWide, earningsCalendar, hasDerivatives, now } =
    inputs;

  if (bars.length === 0) {
    return {
      ok: false,
      reason: `No price history came back for ${symbol}. Either the ticker does not exist, or it is not carried by the data provider this platform uses.`,
    };
  }
  if (bars.length < MIN_BARS_FOR_ANALYSIS) {
    /*
     * REFUSE RATHER THAN SCORE. Every band in this engine is a percentile of
     * the instrument's own history; with a few weeks of bars those bands are
     * computed against almost nothing and would produce extreme readings from
     * noise. A recent listing is a real answer, not a failure.
     */
    return {
      ok: false,
      reason:
        `${symbol} has only ${bars.length} sessions of price history, and this engine needs at least ${MIN_BARS_FOR_ANALYSIS} ` +
        `before any reading is meaningful — every threshold it uses is measured against an instrument's own past, ` +
        `and there is not enough past here yet. Recently listed names genuinely cannot be scored, and inventing a ` +
        `verdict from six weeks of data would be the false precision this engine exists to refuse.`,
    };
  }

  const asOf = bars[bars.length - 1].t;
  const lastClose = bars[bars.length - 1].close;
  const prevClose = bars[bars.length - 2]?.close ?? lastClose;
  const instrument: EquityInstrumentInput = { symbol, bars };

  /*
   * ── Geometry FIRST ─────────────────────────────────────────────────
   * Zones and ATR were previously computed after the evidence, which was
   * fine while no evidence needed them. The harmonic engine does — its
   * completion zones are checked for confluence against the structure
   * engine's own levels, so geometry has to exist before evidence runs.
   */
  const candles = toCandles(bars);
  const volumeProfile = buildVolumeProfile(candles);
  const zones = buildSupportResistanceZones(candles, volumeProfile, "1D");
  const atrAbs = atr(candles);
  const atrPct = atrAbs !== null && lastClose > 0 ? (atrAbs / lastClose) * 100 : null;

  // ── Evidence, each module contributing only if its inputs exist ──────
  const metrics: MetricVerdict[] = [];

  /*
   * THE DEEP TECHNICAL LAYER — RSI, MACD, EMA alignment, ADX, Bollinger,
   * supertrend, Ichimoku, divergence, combined into one vote by the same
   * buildTechnicalRead the crypto page has always used. This was the
   * platform's richest untapped module for searched tickers: fully built,
   * fully tested, and simply never run on this path.
   */
  const techRead = buildTechnicalRead(candles);
  if (techRead) metrics.push(technicalsMetric(techRead, asOf));

  /*
   * THE HARMONIC ENGINE — pattern completion zones from ratio-measured
   * swings, confluence-checked against the structure zones above. Displayed
   * evidence, deliberately non-voting: the incremental-value study measured
   * limited extra edge over plain structure, and a module keeps only the
   * weight its record earns.
   */
  if (techRead && atrAbs !== null && atrAbs > 0) {
    const harmonics = buildHarmonicEvidence({
      candles,
      timeframe: "1D",
      atrAbs,
      price: lastClose,
      zones,
      biasVerdict: null,
      metricVerdicts: new Map(),
      currentDivergence: { rsi: techRead.rsiDivergence, macd: techRead.macdDivergence },
    });
    const best = selectBestHarmonic(harmonics, []);
    if (best) metrics.push(harmonicMetric(best, asOf));
  }

  const relativeStrength =
    benchmarkCloses && benchmarkCloses.length > 0
      ? evaluateRelativeStrength(instrument, { symbol: benchmarkSymbol, bars: asBars(benchmarkCloses) }, asOf)
      : null;
  if (relativeStrength) metrics.push(relativeStrength);

  const volatility = evaluateVolatilityRegime(instrument, asOf);
  if (volatility) metrics.push(volatility);

  const trend = evaluateTrendQuality(instrument, asOf);
  if (trend) metrics.push(trend);

  const structure = evaluateMarketStructure(instrument, asOf);
  if (structure) metrics.push(structure);

  /*
   * Market-wide evidence applies to equities only. Bolting the S&P's breadth
   * onto a crypto asset would import an unrelated market's condition into
   * its score — the kind of category error that produced "bullish 96" gold
   * readings before cross-asset instruments were removed from the snapshot.
   */
  if (assetClass === "equity") metrics.push(...marketWide);

  const bias = buildMarketBias({
    asset: symbol,
    metrics,
    // The full TechnicalRead, not just its vote — the risk assessment reads
    // ATR and squeeze character from it, and trendStrength surfaces from it.
    technicals: techRead,
    squeezeScore: null,
    previous: null,
    now: asOf,
    basis: "state",
  } as never);

  if (!bias) {
    return {
      ok: false,
      reason: `${symbol} returned price history, but no evidence module could produce a reading from it. That usually means the series has gaps or is not actually traded.`,
    };
  }

  const earnings = assetClass === "equity" ? earningsVeto(symbol, earningsCalendar, now) : null;
  const direction = bias.verdict === "bullish" ? "long" : bias.verdict === "bearish" ? "short" : null;

  /*
   * A plan needs enough history for the structure it is anchored to to mean
   * something, which is a higher bar than a description needs. Below it the
   * read still publishes and the plan does not — the same
   * describe-but-refuse split the rest of the engine uses.
   */
  const outcome =
    direction && earnings
      ? ({ plan: null, refusal: "earnings-imminent" } as const)
      : direction && bars.length >= MIN_BARS_FOR_PLAN
        ? buildTradePlanOutcome({
            direction,
            anchorPrice: lastClose,
            atrPct,
            zones,
            quality: {
              confidence: bias.confidence,
              agreement: bias.agreement,
              historicalWinRatePct: null,
              historicalWinRateN: null,
            },
          })
        : direction
          ? ({ plan: null, refusal: "no-structure" } as const)
          : null;

  return {
    ok: true,
    analysis: {
      symbol,
      name,
      assetClass,
      lastClose,
      change24hPct: prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0,
      asOf,
      bias,
      plan: outcome?.plan ?? null,
      planRefusal: outcome?.refusal ?? null,
      earnings,
      zones,
      atrPct,
      barsUsed: bars.length,
      coverage: buildCoverage({
        assetClass,
        relativeStrength,
        structure,
        hasDerivatives,
        marketWideCount: marketWide.length,
        hasTechnicals: techRead !== null,
      }),
    },
  };
}

/**
 * WHAT BACKED THIS READ — the honesty layer.
 *
 * Rendered on every searched ticker, present or absent. The distinction that
 * matters is between "measured and unremarkable" and "not available at all",
 * and only naming the second prevents a four-module read from wearing the
 * authority of an eighteen-module one.
 */
function buildCoverage(o: {
  assetClass: "equity" | "crypto";
  relativeStrength: MetricVerdict | null;
  structure: MetricVerdict | null;
  hasDerivatives: boolean;
  marketWideCount: number;
  hasTechnicals: boolean;
}): CoverageFamily[] {
  const crypto = o.assetClass === "crypto";
  return [
    {
      label: "Price trend & volatility",
      available: true,
      note: "Measured from this asset's own daily history.",
    },
    {
      label: "Chart signals & patterns",
      available: o.hasTechnicals,
      note: o.hasTechnicals
        ? "RSI, MACD, moving averages, volatility bands, trend structure and harmonic completion zones, from the same engine the crypto page uses."
        : "Not enough continuous history for the indicator stack to compute.",
    },
    {
      label: "Support & resistance",
      available: o.structure !== null,
      note: o.structure
        ? "Levels built from swing highs and lows plus where volume actually traded."
        : "Not enough swing points yet to identify levels price has genuinely reacted to.",
    },
    {
      label: "Strength vs the market",
      available: o.relativeStrength !== null,
      note: o.relativeStrength
        ? "Compared against the S&P 500 over the same window."
        : crypto
          ? "Crypto is not measured against the S&P — it is a different market with a different driver."
          : "No benchmark history available to compare against.",
    },
    {
      label: "Market backdrop",
      available: !crypto && o.marketWideCount > 0,
      note: crypto
        ? "Equity breadth and credit appetite describe the stock market, so they are deliberately not applied here."
        : o.marketWideCount > 0
          ? "How broad the market is and whether money is paying up for risk."
          : "The shared market context could not be loaded.",
    },
    {
      label: "Positioning & derivatives",
      available: crypto && o.hasDerivatives,
      note:
        crypto && o.hasDerivatives
          ? "Funding, open interest and basis are available for this asset."
          : crypto
            ? "This asset has no liquid perpetual market on the venues tracked here, so there is no positioning read."
            : "Funding and open interest have no equity equivalent — structurally absent, not missing.",
    },
    {
      label: "Social & news attention",
      available: false,
      note: "NOT BUILT. No provider for it is ingested yet, so nothing on this page reflects sentiment, mentions or coverage. Stated rather than silently omitted.",
    },
  ];
}
