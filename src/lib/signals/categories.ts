import {
  Category,
  CategoryScore,
  MetricVerdict,
  TrendStrength,
  TrendStrengthLabel,
  Verdict,
} from "./types";
import { computeWeightedScore, metricWeight, rankMetric, verdictFromScore } from "./scoring";
import { regimeAdjustedCategoryWeights } from "./regimeWeights";
import { RegimeTags } from "@/lib/technicals/regimes";
import { TechnicalRead } from "@/types/market";

/**
 * Groups the 18 flat metric verdicts into four composite sections, and
 * combines those into the overall score — a real hierarchy instead of one
 * flat list, organized by the QUESTION each section answers rather than by
 * data-source type.
 *
 * This is Dashboard V2's information-architecture redesign (the "one card
 * = one decision" mandate): the PRIOR taxonomy (leveragedPositioning /
 * spotDemand / marketStress / liquidityMap, weighted 35/30/20/15) has been
 * replaced outright, not run in parallel. That taxonomy grouped metrics by
 * data source (derivatives vs. spot vs. sentiment); this one groups them by
 * the trading question each category answers — positioning, structure,
 * macro backdrop, risk — matching the page's six-section IA one-for-one so
 * the scoring engine and the UI describe the market the same way.
 *
 * Nothing here computes a new signal. Every category score is the SAME
 * verdicts `evaluateAll()` already produces, regrouped and reweighted —
 * this is purely an aggregation layer.
 *
 * Network Health is NOT one of these four — see `Category`'s own doc
 * comment in types.ts for why.
 */

/**
 * Which categories each metric feeds. Every metric is single-homed in the
 * new taxonomy — the prior taxonomy's one dual-membership (`funding` in
 * both leveragedPositioning and marketStress, read under two different
 * framings) has been dropped to a single category; the "how extreme is the
 * cost of holding leverage" nuance is now explanatory text inside
 * Positioning's own card rather than a second scored category. Deliberate
 * simplification, not an oversight.
 *
 * - Positioning: how traders are positioned WITH LEVERAGE, how crowded
 *   that positioning is, and what's already been forced out
 *   (`liquidations` — always-neutral by design, context only, see its own
 *   evaluator doc comment — folds in here rather than a separate
 *   liquidityMap category, since it answers the same "how stretched is
 *   positioning" question).
 * - Market Structure: is real trend/momentum/participation confirming the
 *   move — `technicals` carries trend/momentum/volatility character,
 *   `sectorBreadth` asks whether the move is broadly confirmed across
 *   crypto sectors or concentrated, and `orderFlow`/`spotCvd`/
 *   `spotPerpVolume`/`coinbasePremium` are the four readings on genuine
 *   spot/taker participation vs. leveraged turnover.
 * - Leading Drivers: the macro/liquidity backdrop, upstream of anything
 *   crypto-native — `macroLiquidity` (FRED: Fed/Treasury liquidity flow,
 *   financial conditions, yield curve), `etfFlows` (TradFi capital
 *   arriving or leaving through the regulated wrapper), `stablecoins`
 *   (on-chain buying power waiting on the sidelines).
 * - Risk: fragility and hedging-demand signals — `fearGreed` is read
 *   contrarian at the extremes (a stretched-positioning signal, not a
 *   trend one), `options` put/call is a hedging-demand read, `exchangeFlow`
 *   (whale wallet netflow onto/off exchanges) is the clearest on-chain
 *   signal of intent to sell vs. hold.
 */
const CATEGORY_MAP: Record<string, Category[]> = {
  funding: ["positioning"],
  openInterest: ["positioning"],
  longShort: ["positioning"],
  squeezeRisk: ["positioning"],
  basis: ["positioning"],
  liquidations: ["positioning"],

  technicals: ["marketStructure"],
  sectorBreadth: ["marketStructure"],
  orderFlow: ["marketStructure"],
  spotCvd: ["marketStructure"],
  spotPerpVolume: ["marketStructure"],
  coinbasePremium: ["marketStructure"],

  macroLiquidity: ["leadingDrivers"],
  etfFlows: ["leadingDrivers"],
  stablecoins: ["leadingDrivers"],

  fearGreed: ["risk"],
  options: ["risk"],
  exchangeFlow: ["risk"],

  /*
   * ── EQUITY CAPABILITY SET ──────────────────────────────────────────────
   *
   * Traditional-market evidence maps into the SAME four categories rather
   * than getting a taxonomy of its own. That is what makes "one decision
   * engine" true in practice and not merely in principle: `buildMarketBias`
   * needed no equity branch, but it did need these ids to belong somewhere,
   * because an uncategorised metric is invisible to `buildAllCategories` and
   * the entire bias comes back null.
   *
   * Found exactly that way — five valid equity verdicts in, null out. The
   * evidence modules were right and the engine was right; the taxonomy was
   * the missing join.
   *
   * Crypto categories with no equity analogue (positioning: funding, OI,
   * liquidations) simply receive no metrics, and `combineCategoryScores`
   * renormalises over the categories actually populated — so an equity is
   * scored on a genuinely smaller evidence base rather than on silent zeros.
   */
  equityRelativeStrength: ["marketStructure"],
  marketStructure: ["marketStructure"], // shared module, both asset classes
  equityBreadth: ["marketStructure"],
  equityTrendQuality: ["marketStructure"],
  equityRiskAppetite: ["leadingDrivers"],
  equityVolatilityRegime: ["risk"],
};

/**
 * Sum to 1.00; ratios are what matter since an absent category renormalizes.
 * Positioning carries the most weight because it has the most (and most
 * directly directional) contributing metrics, same as the prior taxonomy's
 * leveragedPositioning. Market Structure, Leading Drivers, and Risk split
 * the remainder roughly evenly, each carrying real directional metrics
 * (unlike the prior liquidityMap, which was weighted near-zero because its
 * only scored metric was always-neutral by design).
 */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  positioning: 0.35,
  marketStructure: 0.25,
  leadingDrivers: 0.2,
  risk: 0.2,
};

export const CATEGORY_LABELS: Record<Category, string> = {
  positioning: "Positioning Intelligence",
  marketStructure: "Market Structure",
  leadingDrivers: "Leading Drivers",
  risk: "Risk Monitor",
};

/** Display order — heaviest-weighted category first. */
export const CATEGORY_ORDER: Category[] = ["positioning", "marketStructure", "leadingDrivers", "risk"];

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

/**
 * Every metric already carries its own `conflicts: string[]` — evidence
 * pointing the other way, cited per-metric (see MetricVerdict in
 * types.ts). Never aggregated anywhere before this: a category's card
 * showed its top supporting reasons, but a reader had to open every
 * metric's own row to see what contradicted the category's read. This is
 * the "Contradicting Evidence" line the Dashboard V2 card format calls
 * for — pure aggregation, no new evidence generated, deduped since the
 * same conflict sentence can legitimately appear on more than one metric
 * (e.g. two metrics both citing "price action leans bearish, against this
 * read").
 */
export function aggregateConflicts(metrics: MetricVerdict[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of metrics) {
    for (const c of m.conflicts) {
      if (seen.has(c)) continue;
      seen.add(c);
      result.push(c);
    }
  }
  return result;
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



/**
 * How much a metric actually contributed to the composite — DERIVED BY THE
 * ENGINE, never declared by the module.
 *
 * A module that reported its own score contribution would move weighting out
 * of `METRIC_WEIGHTS`/`CATEGORY_WEIGHTS` and into twenty-four independent
 * assertions with nothing reconciling them. Worse, `computeWeightedScore`
 * could no longer renormalise over ABSENT modules — and that renormalisation
 * is exactly what lets one engine score an equity on six modules and a crypto
 * asset on eighteen with no branch anywhere.
 *
 * Contribution is a property of a metric IN A CONTEXT. The same module is
 * worth more on a thin evidence base than a rich one, so only something
 * holding every metric at once can compute it.
 */
export function contributionOf(
  metric: MetricVerdict,
  all: MetricVerdict[]
): { sharePct: number; category: Category | null } {
  const effective = (m: MetricVerdict) => metricWeight(m.id) * (m.confidence / 100);
  const total = all.reduce((sum, m) => sum + effective(m), 0);
  return {
    sharePct: total > 0 ? Math.round((effective(metric) / total) * 100) : 0,
    category: CATEGORY_MAP[metric.id]?.[0] ?? null,
  };
}
