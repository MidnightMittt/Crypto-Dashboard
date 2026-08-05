/**
 * "Is this actually a high-quality entry?" — the charter's third homepage
 * question, and the one genuinely missing module against its explicit
 * 7-module spec (star rating, suggested entry/stop/target, risk/reward,
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
import { SupportResistanceLevel } from "@/lib/technicals/marketStructure";
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
  supportResistance: SupportResistanceLevel[];
  /** backtestStats.ts's lookupBiasVerdictStat(stats, verdict)?.winRatePct ?? null. */
  historicalWinRatePct: number | null;
  historicalWinRateN: number | null;
}

/** Minimum reward:risk a structural resistance/support level must clear to be used as the target; below this, the level isn't a meaningfully better target than the flat fallback. */
const MIN_RR = 1.5;
/** Flat reward:risk used for the target when no structural level clears MIN_RR. */
const FALLBACK_RR = 2;
/** ATR multiple used for the stop when no structural support/resistance level qualifies. */
const ATR_STOP_MULTIPLIER = 1.5;
/** A structural level closer than this many ATRs is too close to be a meaningful stop (noise would trigger it); farther than this, it's not really "the" stop, just a distant level. */
const STRUCTURAL_STOP_MIN_ATR = 0.5;
const STRUCTURAL_STOP_MAX_ATR = 4;

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * Places a stop using the nearest qualifying support (long) or resistance
 * (short) level within [STRUCTURAL_STOP_MIN_ATR, STRUCTURAL_STOP_MAX_ATR] x
 * ATR of price, falling back to a pure ATR-based stop when nothing
 * qualifies (either no level in that band, or ATR itself is unavailable —
 * in which case no honest stop can be placed at all).
 */
function placeStop(
  isLong: boolean,
  price: number,
  atrAbs: number | null,
  levels: SupportResistanceLevel[]
): { stopPrice: number; stopBasis: string } | null {
  if (atrAbs !== null && atrAbs > 0) {
    const candidates = levels
      .filter((lvl) => (isLong ? lvl.kind === "support" && lvl.price < price : lvl.kind === "resistance" && lvl.price > price))
      .filter((lvl) => {
        const dist = Math.abs(price - lvl.price);
        return dist >= STRUCTURAL_STOP_MIN_ATR * atrAbs && dist <= STRUCTURAL_STOP_MAX_ATR * atrAbs;
      })
      .sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price));

    if (candidates.length > 0) {
      const lvl = candidates[0];
      return { stopPrice: lvl.price, stopBasis: `Nearest ${lvl.kind} level (${lvl.source})` };
    }
    return {
      stopPrice: isLong ? price - ATR_STOP_MULTIPLIER * atrAbs : price + ATR_STOP_MULTIPLIER * atrAbs,
      stopBasis: `${ATR_STOP_MULTIPLIER}x ATR — no qualifying support/resistance level nearby`,
    };
  }
  return null;
}

/**
 * Places a target using the nearest resistance (long) / support (short)
 * level that clears MIN_RR reward:risk against the given stop, falling
 * back to a flat FALLBACK_RR target when nothing qualifies.
 */
function placeTarget(
  isLong: boolean,
  price: number,
  riskDistance: number,
  levels: SupportResistanceLevel[]
): { targetPrice: number; targetBasis: string } {
  const candidates = levels
    .filter((lvl) => (isLong ? lvl.kind === "resistance" && lvl.price > price : lvl.kind === "support" && lvl.price < price))
    .filter((lvl) => Math.abs(lvl.price - price) / riskDistance >= MIN_RR)
    .sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price));

  if (candidates.length > 0) {
    const lvl = candidates[0];
    return {
      targetPrice: lvl.price,
      targetBasis: `Nearest ${lvl.kind} level clearing a ${MIN_RR}:1 reward/risk (${lvl.source})`,
    };
  }
  return {
    targetPrice: isLong ? price + FALLBACK_RR * riskDistance : price - FALLBACK_RR * riskDistance,
    targetBasis: `${FALLBACK_RR}:1 reward/risk — no resistance/support level clears ${MIN_RR}:1`,
  };
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
    historicalWinRatePct,
    historicalWinRateN,
  };
}
