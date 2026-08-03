import {
  Category,
  CategoryScore,
  MetricVerdict,
  RiskLevel,
  TrendStrength,
  TrendStrengthLabel,
  Verdict,
} from "./types";
import { computeWeightedScore, metricWeight, rankMetric, verdictFromScore } from "./scoring";
import { TechnicalRead } from "@/types/market";

/**
 * Groups the 15 flat metric verdicts into five categories, and combines
 * those into the overall score — a real hierarchy instead of one flat
 * list, per the user's explicit spec (Liquidity/Momentum/Derivatives/
 * On-chain/Sentiment, weighted 25/20/20/20/15).
 *
 * Nothing here computes a new signal. Every category score is the SAME
 * verdicts `evaluateAll()` already produces, regrouped and reweighted —
 * this is purely an aggregation layer.
 */

/**
 * Which categories each metric feeds. A metric CAN belong to more than
 * one — `exchangeFlow` genuinely is both a liquidity signal (coins moving
 * to/from exchanges) and an on-chain one (wallet-level netflow), and
 * forcing a single owner would just be a worse model of what the metric
 * actually measures.
 */
const CATEGORY_MAP: Record<string, Category[]> = {
  openInterest: ["liquidity"],
  stablecoins: ["liquidity"],
  exchangeFlow: ["liquidity", "onchain"],
  liquidations: ["liquidity"],

  technicals: ["momentum"],
  orderFlow: ["momentum"],

  funding: ["derivatives"],
  squeezeRisk: ["derivatives"],
  longShort: ["derivatives"],
  basis: ["derivatives"],
  spotPerpVolume: ["derivatives"],

  etfFlows: ["onchain"],

  fearGreed: ["sentiment"],
  coinbasePremium: ["sentiment"],
  options: ["sentiment"],
};

/** The user's explicit weights. Sum to 1.00; ratios are what matter since an absent category renormalizes. */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  liquidity: 0.25,
  momentum: 0.2,
  derivatives: 0.2,
  onchain: 0.2,
  sentiment: 0.15,
};

export const CATEGORY_LABELS: Record<Category, string> = {
  liquidity: "Liquidity",
  momentum: "Momentum",
  derivatives: "Derivatives",
  onchain: "On-Chain",
  sentiment: "Sentiment",
};

/** Display order — heaviest-weighted category first. */
export const CATEGORY_ORDER: Category[] = ["liquidity", "momentum", "derivatives", "onchain", "sentiment"];

function metricsForCategory(metrics: MetricVerdict[], category: Category): MetricVerdict[] {
  return metrics.filter((m) => CATEGORY_MAP[m.id]?.includes(category));
}

/**
 * One category's rollup. Reuses `computeWeightedScore` with each metric's
 * SAME overall importance (`metricWeight`) — a metric's relative weight
 * within its category mirrors its weight in the whole engine, rather than
 * inventing a second, competing weighting scheme just for categories.
 *
 * Returns null when no metric with real weight belongs to this category —
 * distinct from a genuinely neutral category, so the UI can say "not
 * enough data" rather than claim a calm reading it doesn't have.
 */
export function buildCategoryScore(metrics: MetricVerdict[], category: Category): CategoryScore | null {
  const contributing = metricsForCategory(metrics, category);
  const result = computeWeightedScore(contributing, metricWeight);
  if (!result) return null;

  const weighted = contributing.filter((m) => metricWeight(m.id) > 0);
  const top = weighted.length
    ? weighted.reduce((best, m) => (rankMetric(m) > rankMetric(best) ? m : best))
    : null;

  return {
    category,
    label: CATEGORY_LABELS[category],
    score: result.score,
    verdict: result.verdict,
    confidence: result.confidence,
    topReason: top ? `${top.label}: ${top.explanation}` : "No contributing metric currently reports.",
    metrics: contributing,
  };
}

/** Every category with at least one contributing metric, in display order. */
export function buildAllCategories(metrics: MetricVerdict[]): CategoryScore[] {
  return CATEGORY_ORDER.map((c) => buildCategoryScore(metrics, c)).filter(
    (c): c is CategoryScore => c !== null
  );
}

export interface CombinedCategoryScore {
  score: number;
  verdict: Verdict;
  confidence: number;
}

/**
 * The overall score, built by combining CATEGORY rollups via
 * CATEGORY_WEIGHTS — replacing the old flat per-metric weighting.
 * Same shape of math as `computeWeightedScore`, one level up: each
 * category's pull is its weight x its own confidence, missing categories
 * renormalize rather than defaulting to neutral.
 */
export function combineCategoryScores(categories: CategoryScore[]): CombinedCategoryScore | null {
  let weightedSum = 0;
  let totalWeight = 0;
  let confWeightTotal = 0;
  let confWeightedSum = 0;

  for (const c of categories) {
    const baseWeight = CATEGORY_WEIGHTS[c.category];
    confWeightTotal += baseWeight;
    confWeightedSum += c.confidence * baseWeight;

    const w = baseWeight * (c.confidence / 100);
    if (w <= 0) continue;
    totalWeight += w;
    // c.score is already 0-100 around a 50 midpoint; convert back to a
    // signed -1..+1 pull before combining, then remap once at the end.
    weightedSum += ((c.score - 50) / 50) * w;
  }

  if (totalWeight <= 0) return null;

  const normalized = weightedSum / totalWeight;
  const score = Math.round(50 + normalized * 50);

  return {
    score,
    verdict: verdictFromScore(score),
    confidence: confWeightTotal > 0 ? Math.round(confWeightedSum / confWeightTotal) : 0,
  };
}

const TREND_STRENGTH_BUCKETS: Array<{ max: number; label: TrendStrengthLabel }> = [
  { max: 20, label: "Very Weak" },
  { max: 40, label: "Weak" },
  { max: 60, label: "Moderate" },
  { max: 80, label: "Strong" },
  { max: 101, label: "Very Strong" },
];

/**
 * Buckets `technicals.strength` (0-100) into five labels. No separate ADX
 * check needed here — `buildTechnicalRead` already damps `strength` itself
 * when ADX shows a ranging market (see sentiment/technicals.ts), so ADX's
 * influence is already inside the number being bucketed.
 */
export function buildTrendStrength(technicals: TechnicalRead | null): TrendStrength | null {
  if (!technicals) return null;
  const bucket = TREND_STRENGTH_BUCKETS.find((b) => technicals.strength < b.max);
  return { label: bucket?.label ?? "Very Strong", value: technicals.strength };
}

/** Points subtracted from a perfect 100 by each risk tier. */
const RISK_PENALTY: Record<RiskLevel, number> = { low: 0, medium: 25, high: 55 };

/**
 * Direction-agnostic "how much can this read be trusted right now" —
 * confidence, agreement, and the inverse of risk, averaged. Kept separate
 * from the directional bias score on purpose: a market can be confidently,
 * calmly bearish (high health, low score) or be a coin-flip in a volatile,
 * contradictory market (low health, score near 50) — those are different
 * situations a single number would blur together.
 */
export function buildMarketHealth(confidence: number, agreement: number, riskLevel: RiskLevel): number {
  const riskScore = 100 - RISK_PENALTY[riskLevel];
  return Math.round((confidence + agreement + riskScore) / 3);
}
