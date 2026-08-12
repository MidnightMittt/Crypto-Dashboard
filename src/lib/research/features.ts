import { CapabilityKey, ResearchContext, Bar, Timeframe } from "./types";
import { TradeResolution } from "./tradeExecution";

/**
 * FEATURE VECTORS — the shift from "does indicator X work?" to "which
 * combinations of conditions precede profitable trades?".
 *
 * Every completed trade emits exactly one record holding every feature
 * measurable AT ENTRY. Studies then run against records rather than against
 * bespoke per-indicator harnesses, which is what makes them comparable,
 * reproducible, and cheap to add.
 *
 * ── Two non-negotiables encoded structurally, not by convention ─────────
 *
 * 1. POINT-IN-TIME. A feature receives a `ResearchContext` carrying `asOf`
 *    and a source that refuses to serve bars past it. A feature cannot read
 *    the future without deliberately circumventing its only data access.
 *    Convention already failed once on this project; structure will not.
 *
 * 2. EXPLAINABILITY. A feature is a named, described, human-readable value —
 *    never a latent factor or an opaque score. Any conclusion decomposes
 *    into the features that produced it, which is the stated requirement
 *    that every recommendation trace back to observable evidence.
 *
 * ── What this deliberately is NOT ───────────────────────────────────────
 *
 * Not a model. Nothing here fits weights, learns, or predicts. It builds a
 * clean tabular dataset that honest statistics can be run against. The
 * search over feature combinations is a separate, heavily guarded step —
 * see `combinations.ts` and the warning in its header, because conjunction
 * mining is the single most data-snooping-prone activity in this field.
 */

export type FeatureValue = number | string | boolean | null;
export type FeatureKind = "numeric" | "categorical" | "boolean";

export interface FeatureDefinition {
  key: string;
  description: string;
  kind: FeatureKind;
  /** Same capability contract as EvidenceModule: unmet requirements mean the feature is recorded as unavailable, never fabricated. */
  requires: CapabilityKey[];
  /** Must return null rather than a default when the value genuinely cannot be computed. A fabricated zero is indistinguishable from a real zero downstream. */
  extract(ctx: ResearchContext): FeatureValue;
}

export interface FeatureVector {
  instrumentId: string;
  asOf: number;
  values: Record<string, FeatureValue>;
  /** Features skipped for missing capabilities — recorded so an absent feature can never be mistaken for a null one. */
  unavailable: string[];
  /** Features that threw. Isolated per feature so one bad extractor cannot void a whole record. */
  errored: string[];
}

/**
 * Builds one vector. Never throws: a research record with a hole in it is
 * far more useful than no record, provided the hole is labelled — which is
 * what `unavailable` and `errored` are for.
 */
export function extractFeatures(defs: FeatureDefinition[], ctx: ResearchContext): FeatureVector {
  const values: Record<string, FeatureValue> = {};
  const unavailable: string[] = [];
  const errored: string[] = [];

  for (const def of defs) {
    const missing = def.requires.filter((k) => !ctx.source.hasCapability(ctx.instrument.id, k));
    if (missing.length > 0) {
      values[def.key] = null;
      unavailable.push(def.key);
      continue;
    }
    try {
      values[def.key] = def.extract(ctx);
    } catch {
      values[def.key] = null;
      errored.push(def.key);
    }
  }

  return { instrumentId: ctx.instrument.id, asOf: ctx.asOf, values, unavailable, errored };
}

/**
 * One completed trade, as research data.
 *
 * `features` are strictly as-of entry; `outcome` is strictly forward. The
 * separation is the whole point — the two are computed by different code
 * paths with different time bounds, so a forward-looking value cannot leak
 * into the feature side by accident.
 */
export interface TradeResearchRecord {
  id: string;
  instrumentId: string;
  assetClass: string;
  side: "long" | "short";
  entryT: number;
  entryPrice: number;
  features: FeatureVector;
  outcome: TradeResolution;
}

// ── Universal feature library ───────────────────────────────────────────

/**
 * Features computable from OHLCV alone, and therefore valid for every
 * instrument in the platform's target universe. Asset-specific features
 * (funding, earnings, on-chain) live beside their providers and declare the
 * matching capability; the engine composes both lists without knowing which
 * is which.
 *
 * These also serve as the reference implementation of the contract: read
 * only through `ctx.source`, bound every read by `ctx.asOf`, return null
 * rather than guessing.
 */

const dailyBars = (ctx: ResearchContext, n: number): Bar[] => {
  // No cutoff argument exists to supply: the view is already bound to asOf.
  const bars = ctx.source.bars(ctx.instrument.id, "1D");
  return bars.slice(Math.max(0, bars.length - n));
};

/** Trailing return over `days` sessions, in percent. Null without enough history. */
function trailingReturnPct(ctx: ResearchContext, days: number): number | null {
  const bars = dailyBars(ctx, days + 1);
  if (bars.length < days + 1) return null;
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  return first > 0 ? ((last - first) / first) * 100 : null;
}

/** Kaufman efficiency ratio: net displacement over total distance. 1 = straight line, 0 = round trip. */
function efficiency(ctx: ResearchContext, days: number): number | null {
  const bars = dailyBars(ctx, days + 1);
  if (bars.length < days + 1) return null;
  const net = Math.abs(bars[bars.length - 1].close - bars[0].close);
  let distance = 0;
  for (let i = 1; i < bars.length; i++) distance += Math.abs(bars[i].close - bars[i - 1].close);
  return distance > 0 ? net / distance : 0;
}

/** Percentile of the latest true range against its own trailing history — volatility, expressed comparably across instruments. */
function atrPercentile(ctx: ResearchContext, window: number, baseline: number): number | null {
  const bars = dailyBars(ctx, baseline + window + 1);
  if (bars.length < window + 10) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trueRanges.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const current = avg(trueRanges.slice(-window));
  const history: number[] = [];
  for (let i = window; i < trueRanges.length; i++) history.push(avg(trueRanges.slice(i - window, i)));
  if (history.length < 10) return null;
  return history.filter((h) => h < current).length / history.length;
}

const numeric = (
  key: string,
  description: string,
  extract: (ctx: ResearchContext) => number | null
): FeatureDefinition => ({ key, description, kind: "numeric", requires: ["ohlcv"], extract });

const categorical = (
  key: string,
  description: string,
  extract: (ctx: ResearchContext) => string | null
): FeatureDefinition => ({ key, description, kind: "categorical", requires: ["ohlcv"], extract });

/** Direction of a trailing return, discretised. Kept alongside the raw number so studies can use whichever suits — the raw value never being discarded is the point. */
function trendLabel(ret: number | null, threshold: number): string | null {
  if (ret === null) return null;
  return ret > threshold ? "up" : ret < -threshold ? "down" : "flat";
}

export const UNIVERSAL_FEATURES: FeatureDefinition[] = [
  numeric("return_5d", "Trailing 5-session return, percent.", (c) => trailingReturnPct(c, 5)),
  numeric("return_20d", "Trailing 20-session return, percent.", (c) => trailingReturnPct(c, 20)),
  numeric("return_60d", "Trailing 60-session return, percent — the closest OHLCV-only analogue of a weekly trend.", (c) => trailingReturnPct(c, 60)),

  categorical("trend_short", "5-session direction (up/flat/down), +/-2% deadband.", (c) => trendLabel(trailingReturnPct(c, 5), 2)),
  categorical("trend_medium", "20-session direction, +/-5% deadband.", (c) => trendLabel(trailingReturnPct(c, 20), 5)),
  categorical("trend_long", "60-session direction, +/-10% deadband.", (c) => trendLabel(trailingReturnPct(c, 60), 10)),

  numeric("efficiency_20d", "Kaufman efficiency ratio over 20 sessions: 1 is a straight line, 0 a round trip.", (c) => efficiency(c, 20)),
  numeric("atr_percentile", "Current 14-session ATR ranked against its own trailing 180-session history, 0-1.", (c) => atrPercentile(c, 14, 180)),

  numeric(
    "dist_from_20d_high_pct",
    "How far below the trailing 20-session high price sits, percent. 0 means at the high.",
    (c) => {
      const bars = dailyBars(c, 20);
      if (bars.length < 20) return null;
      const high = Math.max(...bars.map((b) => b.high));
      const last = bars[bars.length - 1].close;
      return high > 0 ? ((high - last) / high) * 100 : null;
    }
  ),
  numeric(
    "dist_from_20d_low_pct",
    "How far above the trailing 20-session low price sits, percent.",
    (c) => {
      const bars = dailyBars(c, 20);
      if (bars.length < 20) return null;
      const low = Math.min(...bars.map((b) => b.low));
      const last = bars[bars.length - 1].close;
      return low > 0 ? ((last - low) / low) * 100 : null;
    }
  ),
  numeric(
    "volume_ratio_20d",
    "Latest session volume over its trailing 20-session average. Null where the instrument has no meaningful volume.",
    (c) => {
      const bars = dailyBars(c, 21);
      if (bars.length < 21) return null;
      const vols = bars.map((b) => b.volume).filter((v): v is number => v !== null && v > 0);
      if (vols.length < 21) return null;
      const recent = vols[vols.length - 1];
      const avg = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
      return avg > 0 ? recent / avg : null;
    }
  ),
];

/** Every timeframe the universal library reads, so a data source knows what to make available. */
export const UNIVERSAL_FEATURE_TIMEFRAMES: Timeframe[] = ["1D"];
