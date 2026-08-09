/**
 * "Is this actually a high-quality entry?" — the charter's third homepage
 * question, and the one genuinely missing module against its explicit
 * 7-module spec (star rating, suggested entry/stop/TP1/TP2, risk/reward,
 * win probability, reasoning). Everything here is derived from data that
 * already exists elsewhere on the dashboard — current price, ATR, the
 * liquidity map's support/resistance levels, marketBias's confidence and
 * agreement, and the real backtested win rate for the current bias verdict
 * (backtestStats.ts's biasVerdict RegimeStat.winRatePct) — nothing new is
 * fetched or invented.
 *
 * Explicitly NOT a trade recommendation, matching MetricVerdict's own
 * opportunity/counterRisk fields: these are REFERENCE levels derived from
 * structure and volatility, not a signal to act on. The win-rate figure is
 * a historical statistic about how often this bias verdict's direction has
 * been right over the last 1 day — never a probability of this specific
 * setup succeeding (the same distinction MetricVerdict.confidence's own doc
 * comment draws between evidence quality and price-move odds).
 */

import { Verdict } from "./types";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { clamp } from "@/lib/sentiment/compositeIndex";

export type StarRating = 1 | 2 | 3 | 4 | 5;

export interface EntryQuality {
  verdict: Verdict;
  stars: StarRating;
  starRationale: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskRewardRatio: number;
  stopBasis: string;
  targetBasis: string;
  /**
   * A second, farther-out reference target (TP1 stays the primary,
   * higher-probability level the star rating is built on) — for the
   * position size a trader might leave running past TP1. Same honesty rule
   * as TP1: a real structural level when one qualifies, an explicit flat
   * multiple when none does, never silently identical to TP1.
   */
  target2Price: number;
  target2Basis: string;
  riskRewardRatio2: number;
  /**
   * The full nearest support/resistance ZONE below/above price — not just
   * the single trade-relevant edge already captured in stopPrice/
   * targetPrice above. Exists so the UI can show the real range (and its
   * strength/reaction count/status), not a single number dressed up as
   * more precise than the underlying structure actually is. Independent of
   * which zone (if any) actually ended up qualifying as the stop/target —
   * this is simply "what's nearest," for context.
   */
  nearestSupport: SupportResistanceZone | null;
  nearestResistance: SupportResistanceZone | null;
  historicalWinRatePct: number | null;
  historicalWinRateN: number | null;
}

export interface EntryQualityInputs {
  verdict: Verdict;
  /** MarketBias.confidence, 0-100 — evidence quality, not a probability. */
  confidence: number;
  /** MarketBias.agreement, 0-100 — how much metrics concur with each other. */
  agreement: number;
  /** Current price — the "entry" is simply "if entering now," not a limit order suggestion. */
  price: number;
  /** TechnicalRead.atrPct — ATR as % of price. Null when technicals aren't available. */
  atrPct: number | null;
  supportResistance: SupportResistanceZone[];
  /** backtestStats.ts's lookupBiasVerdictStat(stats, verdict)?.winRatePct ?? null. */
  historicalWinRatePct: number | null;
  historicalWinRateN: number | null;
}

/** Minimum reward:risk a structural resistance/support level must clear to be used as the target; below this, the level isn't a meaningfully better target than the flat fallback. */
const MIN_RR = 1.5;
/** Flat reward:risk used for the target when no structural level clears MIN_RR. */
const FALLBACK_RR = 2;
/** Minimum reward:risk TP2 must clear — higher than TP1's bar, since TP2 is explicitly the farther, lower-probability "let it run" level. */
const MIN_RR_TP2 = 3;
/** Flat reward:risk used for TP2 when no structural level beyond TP1 clears MIN_RR_TP2. */
const FALLBACK_RR_TP2 = 4;
/** ATR multiple used for the stop when no structural support/resistance level qualifies. */
const ATR_STOP_MULTIPLIER = 1.5;
/** A structural level closer than this many ATRs is too close to be a meaningful stop (noise would trigger it); farther than this, it's not really "the" stop, just a distant level. */
const STRUCTURAL_STOP_MIN_ATR = 0.5;
const STRUCTURAL_STOP_MAX_ATR = 4;

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * The single price a zone contributes to a trade: for a stop (using the
 * protective-side zone — support for a long, resistance for a short) this
 * is the edge CLOSEST to price; for a target (using the opposing-side
 * zone) this is the edge FARTHEST from price — "fully cleared," not just
 * "touched." Both reduce to the same edge relative to trade direction:
 * the zone's upper edge for a long, lower edge for a short — a genuine
 * coincidence of geometry (protective zones sit below a long/above a
 * short, opposing zones sit above a long/below a short), not a hack.
 */
function tradeRelevantEdge(zone: SupportResistanceZone, isLong: boolean): number {
  return isLong ? zone.priceHigh : zone.priceLow;
}

/** Qualitative description of a zone for a basis string — never embeds a formatted price, matching this file's existing convention of leaving price formatting to the UI. */
function describeZone(zone: SupportResistanceZone): string {
  const touches = zone.reactionCount > 0 ? `${zone.reactionCount} touch${zone.reactionCount === 1 ? "" : "es"}` : null;
  const confluence = zone.confluence.length > 0 ? `confluence: ${zone.confluence.join(", ")}` : null;
  const details = [touches, confluence].filter(Boolean).join(", ");
  return details ? `${zone.kind} zone, ${details}` : `${zone.kind} zone`;
}

/**
 * Places a stop using the nearest qualifying support (long) or resistance
 * (short) zone within [STRUCTURAL_STOP_MIN_ATR, STRUCTURAL_STOP_MAX_ATR] x
 * ATR of price, falling back to a pure ATR-based stop when nothing
 * qualifies (either no zone in that band, or ATR itself is unavailable —
 * in which case no honest stop can be placed at all).
 */
function placeStop(
  isLong: boolean,
  price: number,
  atrAbs: number | null,
  zones: SupportResistanceZone[]
): { stopPrice: number; stopBasis: string } | null {
  if (atrAbs !== null && atrAbs > 0) {
    const candidates = zones
      .filter((z) => (isLong ? z.kind === "support" && z.priceHigh < price : z.kind === "resistance" && z.priceLow > price))
      .filter((z) => {
        const dist = Math.abs(price - tradeRelevantEdge(z, isLong));
        return dist >= STRUCTURAL_STOP_MIN_ATR * atrAbs && dist <= STRUCTURAL_STOP_MAX_ATR * atrAbs;
      })
      .sort((a, b) => Math.abs(price - tradeRelevantEdge(a, isLong)) - Math.abs(price - tradeRelevantEdge(b, isLong)));

    if (candidates.length > 0) {
      const zone = candidates[0];
      return { stopPrice: tradeRelevantEdge(zone, isLong), stopBasis: `Nearest ${describeZone(zone)}` };
    }
    return {
      stopPrice: isLong ? price - ATR_STOP_MULTIPLIER * atrAbs : price + ATR_STOP_MULTIPLIER * atrAbs,
      stopBasis: `${ATR_STOP_MULTIPLIER}x ATR — no qualifying support/resistance zone nearby`,
    };
  }
  return null;
}

/**
 * Places a target using the nearest resistance (long) / support (short)
 * zone that clears MIN_RR reward:risk against the given stop, falling
 * back to a flat FALLBACK_RR target when nothing qualifies.
 */
function placeTarget(
  isLong: boolean,
  price: number,
  riskDistance: number,
  zones: SupportResistanceZone[]
): { targetPrice: number; targetBasis: string } {
  const candidates = zones
    .filter((z) => (isLong ? z.kind === "resistance" && z.priceLow > price : z.kind === "support" && z.priceHigh < price))
    .filter((z) => Math.abs(tradeRelevantEdge(z, isLong) - price) / riskDistance >= MIN_RR)
    .sort((a, b) => Math.abs(price - tradeRelevantEdge(a, isLong)) - Math.abs(price - tradeRelevantEdge(b, isLong)));

  if (candidates.length > 0) {
    const zone = candidates[0];
    return {
      targetPrice: tradeRelevantEdge(zone, isLong),
      targetBasis: `Nearest ${describeZone(zone)}, clearing a ${MIN_RR}:1 reward/risk`,
    };
  }
  return {
    targetPrice: isLong ? price + FALLBACK_RR * riskDistance : price - FALLBACK_RR * riskDistance,
    targetBasis: `${FALLBACK_RR}:1 reward/risk — no resistance/support zone clears ${MIN_RR}:1`,
  };
}

/**
 * Places TP2 using the nearest resistance (long) / support (short) zone
 * BEYOND target1Price that clears MIN_RR_TP2, falling back to a flat
 * FALLBACK_RR_TP2 target when nothing qualifies — always farther from price
 * than TP1, whichever way TP1 itself was placed (structural or fallback).
 */
function placeSecondTarget(
  isLong: boolean,
  price: number,
  riskDistance: number,
  target1Price: number,
  zones: SupportResistanceZone[]
): { target2Price: number; target2Basis: string } {
  const candidates = zones
    .filter((z) => (isLong ? z.kind === "resistance" && z.priceLow > target1Price : z.kind === "support" && z.priceHigh < target1Price))
    .filter((z) => Math.abs(tradeRelevantEdge(z, isLong) - price) / riskDistance >= MIN_RR_TP2)
    .sort((a, b) => Math.abs(price - tradeRelevantEdge(a, isLong)) - Math.abs(price - tradeRelevantEdge(b, isLong)));

  if (candidates.length > 0) {
    const zone = candidates[0];
    return {
      target2Price: tradeRelevantEdge(zone, isLong),
      target2Basis: `Next ${describeZone(zone)} beyond TP1, clearing a ${MIN_RR_TP2}:1 reward/risk`,
    };
  }
  return {
    target2Price: isLong ? price + FALLBACK_RR_TP2 * riskDistance : price - FALLBACK_RR_TP2 * riskDistance,
    target2Basis: `${FALLBACK_RR_TP2}:1 reward/risk — no further resistance/support zone beyond TP1 clears ${MIN_RR_TP2}:1`,
  };
}

/** Nearest support zone below price / resistance zone above price, regardless of whether it qualified as the actual stop/target — for the UI's own "where is support/resistance" display. */
function nearestZones(price: number, zones: SupportResistanceZone[]): { support: SupportResistanceZone | null; resistance: SupportResistanceZone | null } {
  // Nearest support: the highest priceHigh below price. Nearest resistance: the lowest priceLow above price.
  const support = zones.filter((z) => z.kind === "support" && z.priceHigh < price).sort((a, b) => b.priceHigh - a.priceHigh)[0];
  const resistance = zones.filter((z) => z.kind === "resistance" && z.priceLow > price).sort((a, b) => a.priceLow - b.priceLow)[0];
  return { support: support ?? null, resistance: resistance ?? null };
}

function buildStarRationale(
  stars: StarRating,
  rr: number,
  confidence: number,
  agreement: number,
  winRatePct: number | null,
  winRateN: number | null
): string {
  const winRatePart =
    winRatePct === null
      ? "the historical win rate isn't available yet (fewer than 10 recorded days for this verdict)"
      : `this verdict has historically been right ${winRatePct.toFixed(0)}% of the time over the next day (n=${winRateN})`;
  return `${stars} star${stars === 1 ? "" : "s"} — reward/risk is ${rr.toFixed(1)}:1, evidence confidence is ${confidence.toFixed(0)}/100, metrics agree ${agreement.toFixed(0)}%, and ${winRatePart}.`;
}

/**
 * Returns null for a neutral verdict (no directional entry exists to rate)
 * or when there isn't enough data to honestly place a stop (no ATR). Never
 * fabricates a setup where none exists.
 */
export function buildEntryQuality(inputs: EntryQualityInputs): EntryQuality | null {
  const { verdict, confidence, agreement, price, atrPct, supportResistance, historicalWinRatePct, historicalWinRateN } = inputs;
  if (verdict === "neutral" || price <= 0) return null;

  const isLong = verdict === "bullish";
  const atrAbs = atrPct !== null ? (atrPct / 100) * price : null;

  const stop = placeStop(isLong, price, atrAbs, supportResistance);
  if (stop === null) return null;

  const riskDistance = Math.abs(price - stop.stopPrice);
  if (riskDistance <= 0) return null;

  const target = placeTarget(isLong, price, riskDistance, supportResistance);
  const rewardDistance = Math.abs(target.targetPrice - price);
  const riskRewardRatio = rewardDistance / riskDistance;

  const target2 = placeSecondTarget(isLong, price, riskDistance, target.targetPrice, supportResistance);
  const riskRewardRatio2 = Math.abs(target2.target2Price - price) / riskDistance;

  const { support: nearestSupport, resistance: nearestResistance } = nearestZones(price, supportResistance);

  const confidenceComponent = clamp01(confidence / 100);
  const agreementComponent = clamp01(agreement / 100);
  const rrComponent = clamp01(riskRewardRatio / 3);
  const winRateComponent = historicalWinRatePct !== null ? clamp01((historicalWinRatePct - 50) / 20) : 0.5;

  const score01 = 0.25 * confidenceComponent + 0.2 * agreementComponent + 0.3 * rrComponent + 0.25 * winRateComponent;
  const stars = clamp(Math.round(1 + score01 * 4), 1, 5) as StarRating;

  return {
    verdict,
    stars,
    starRationale: buildStarRationale(stars, riskRewardRatio, confidence, agreement, historicalWinRatePct, historicalWinRateN),
    entryPrice: price,
    stopPrice: stop.stopPrice,
    targetPrice: target.targetPrice,
    riskRewardRatio,
    stopBasis: stop.stopBasis,
    targetBasis: target.targetBasis,
    target2Price: target2.target2Price,
    target2Basis: target2.target2Basis,
    riskRewardRatio2,
    nearestSupport,
    nearestResistance,
    historicalWinRatePct,
    historicalWinRateN,
  };
}
