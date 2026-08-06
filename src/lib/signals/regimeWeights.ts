import { Category } from "./types";
import { RegimeTags } from "@/lib/technicals/regimes";

/**
 * Small, deliberately conservative multipliers (+/-10-20%) applied to
 * CATEGORY_WEIGHTS before renormalizing, based on the SAME RegimeTags
 * classifyRegime() already computes for the live regime badge and backtest
 * bucketing — no new classification, only a new consumer of it.
 *
 * UNVALIDATED HYPOTHESIS, not a backtested edge. Rationale for each
 * (updated for Dashboard V2's taxonomy — the mapping below preserves the
 * ORIGINAL reasoning against its new category home, not a fresh guess):
 *  - risk (fragility/hedging-demand: Fear&Greed, options, exchange flow)
 *    matters more when volatility is already high — the same positioning
 *    is riskier. Was `marketStress` under the prior taxonomy.
 *  - marketStructure (trend/momentum/participation) matters more when
 *    range-bound — mean-reversion context is more informative than in a
 *    strong trend, where structure gets run over. Was `liquidityMap`
 *    under the prior taxonomy, but that category's only scored member
 *    (liquidations) never carried real weight — marketStructure is the
 *    more honest new home for this rationale, since it's the category
 *    that actually contains the trend/momentum signals whose
 *    informativeness genuinely varies with range-bound vs. trending
 *    conditions.
 *  - positioning matters slightly less when range-bound — positioning
 *    extremes resolve less directionally in chop. Was `leveragedPositioning`.
 *
 * These specific numbers must be checked against a real backtest
 * comparison (regime-adjusted vs. fixed weights) before being treated as
 * anything more than a first-pass hypothesis — see report.ts's regime
 * win-rate stats.
 */
export const REGIME_WEIGHT_MULTIPLIERS: {
  volatility: Record<RegimeTags["volatility"], Partial<Record<Category, number>>>;
  rangeBound: Partial<Record<Category, number>>;
} = {
  volatility: {
    high: { risk: 1.2 },
    low: {},
    normal: {},
  },
  rangeBound: {
    marketStructure: 1.15,
    positioning: 0.9,
  },
};

/**
 * CATEGORY_WEIGHTS adjusted for the given regime, renormalized to sum to 1.
 * Multiple applicable multipliers (e.g. high volatility AND range-bound)
 * compose multiplicatively, not additively. `regime: null` returns `base`
 * completely unchanged — the exact pre-Phase-1 behavior, so every existing
 * call site that hasn't been updated to pass a regime yet sees zero drift.
 */
export function regimeAdjustedCategoryWeights(
  base: Record<Category, number>,
  regime: RegimeTags | null
): Record<Category, number> {
  if (regime === null) return base;

  const multipliers: Partial<Record<Category, number>> = {};
  const applyMultipliers = (m: Partial<Record<Category, number>>) => {
    for (const [cat, factor] of Object.entries(m) as [Category, number][]) {
      multipliers[cat] = (multipliers[cat] ?? 1) * factor;
    }
  };

  applyMultipliers(REGIME_WEIGHT_MULTIPLIERS.volatility[regime.volatility]);
  if (regime.rangeBound) applyMultipliers(REGIME_WEIGHT_MULTIPLIERS.rangeBound);

  const categories = Object.keys(base) as Category[];
  const adjusted: Record<Category, number> = { ...base };
  for (const cat of categories) {
    adjusted[cat] = base[cat] * (multipliers[cat] ?? 1);
  }

  const total = categories.reduce((sum, cat) => sum + adjusted[cat], 0);
  const renormalized: Record<Category, number> = { ...adjusted };
  for (const cat of categories) {
    renormalized[cat] = total > 0 ? adjusted[cat] / total : 0;
  }
  return renormalized;
}
