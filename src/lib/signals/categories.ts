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
import { regimeAdjustedCategoryWeights } from "./regimeWeights";
import { RegimeTags } from "@/lib/technicals/regimes";
import { TechnicalRead } from "@/types/market";

/**
 * Groups the 15 flat metric verdicts into four composite sections, and
 * combines those into the overall score — a real hierarchy instead of one
 * flat list, organized by the QUESTION each section answers rather than by
 * data-source type (the prior taxonomy: Liquidity/Momentum/Derivatives/
 * On-chain/Sentiment, weighted 25/20/20/20/15 — replaced outright, not run
 * in parallel, per the redesign's explicit "reduce cognitive load" goal).
 *
 * Nothing here computes a new signal. Every category score is the SAME
 * verdicts `evaluateAll()` already produces, regrouped and reweighted —
 * this is purely an aggregation layer.
 *
 * Network Health is NOT one of these four — see `Category`'s own doc
 * comment in types.ts for why.
 */

/**
 * Which categories each metric feeds. A metric CAN belong to more than
 * one — see the placement reasoning below for `funding` (the one deliberate
 * dual-membership in the new taxonomy; `exchangeFlow` had this role in the
 * old one).
 *
 * - Leveraged Positioning: how traders are positioned WITH LEVERAGE, and
 *   how crowded that positioning is.
 * - Spot Demand: is real, unleveraged buying/selling power behind the
 *   move — exchange wallets, ETF wrappers, stablecoin supply, Coinbase's
 *   US-demand premium, taker flow, and spot-vs-perp turnover are the six
 *   metrics that most directly answer this.
 * - Market Stress: is this move backed by real conviction or
 *   stretched/fragile — `fearGreed`'s own evaluator already reads it as
 *   contrarian-extremes-only (a fragility signal), `options` put/call is a
 *   hedging-demand read, and `technicals` carries the market's own
 *   volatility/strength character. `funding` is read a SECOND time here
 *   under a different framing than Leveraged Positioning: "which side is
 *   crowded" (directional) vs. "how extreme is the cost of holding
 *   leverage right now" (magnitude). `computeWeightedScore` renormalizes
 *   independently per category, so this is not double-counted in the
 *   overall score.
 * - Liquidity Map: market MICROSTRUCTURE — where price is likely to move
 *   next based on liquidity, not a directional read. `liquidations` is its
 *   only member from the scored 15, and stays weight-0 (its evaluator is
 *   deliberately always-neutral, "context only, not predictive" — see
 *   evaluators.ts) — the rest of Liquidity Map's card content comes from
 *   `src/lib/technicals/marketStructure.ts`'s volume-profile/support-
 *   resistance approximation, not from this weighted-score machinery.
 */
const CATEGORY_MAP: Record<string, Category[]> = {
  funding: ["leveragedPositioning", "marketStress"],
  openInterest: ["leveragedPositioning"],
  longShort: ["leveragedPositioning"],
  squeezeRisk: ["leveragedPositioning"],
  basis: ["leveragedPositioning"],

  orderFlow: ["spotDemand"],
  spotCvd: ["spotDemand"],
  spotPerpVolume: ["spotDemand"],
  coinbasePremium: ["spotDemand"],
  exchangeFlow: ["spotDemand"],
  etfFlows: ["spotDemand"],
  stablecoins: ["spotDemand"],

  technicals: ["marketStress"],
  fearGreed: ["marketStress"],
  options: ["marketStress"],

  liquidations: ["liquidityMap"],
};

/**
 * Sum to 1.00; ratios are what matter since an absent category renormalizes.
 * Leveraged Positioning and Spot Demand carry the most weight because they
 * have the most (and most directly directional) contributing metrics;
 * Liquidity Map is weighted lowest because its only scored metric
 * (`liquidations`) is weight-0 — it barely moves the overall score by
 * design, since it's a structural read, not a directional one (see its
 * card, which doesn't show this score at all).
 */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  leveragedPositioning: 0.35,
  spotDemand: 0.3,
  marketStress: 0.2,
  liquidityMap: 0.15,
};

export const CATEGORY_LABELS: Record<Category, string> = {
  leveragedPositioning: "Leveraged Positioning",
  spotDemand: "Spot Demand",
  marketStress: "Market Stress",
  liquidityMap: "Liquidity Map",
};

/** Display order — heaviest-weighted category first. */
export const CATEGORY_ORDER: Category[] = ["leveragedPositioning", "spotDemand", "marketStress", "liquidityMap"];

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
 *
 * `regime` (default null) lets the weights shift by market regime via
 * regimeWeights.ts's regimeAdjustedCategoryWeights — null reproduces the
 * exact pre-regime-adjustment behavior, so every caller not yet passing a
 * regime sees zero change.
 */
export function combineCategoryScores(
  categories: CategoryScore[],
  regime: RegimeTags | null = null
): CombinedCategoryScore | null {
  const weights = regimeAdjustedCategoryWeights(CATEGORY_WEIGHTS, regime);
  let weightedSum = 0;
  let totalWeight = 0;
  let confWeightTotal = 0;
  let confWeightedSum = 0;

  for (const c of categories) {
    const baseWeight = weights[c.category];
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
