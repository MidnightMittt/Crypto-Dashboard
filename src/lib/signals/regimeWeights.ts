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
export interface RegimeMultiplierTable {
  volatility: Record<RegimeTags["volatility"], Partial<Record<Category, number>>>;
  rangeBound: Partial<Record<Category, number>>;
}

export const REGIME_WEIGHT_MULTIPLIERS: RegimeMultiplierTable = {
  /*
   * PHASE 4 RESULT: emptied. The hypothesis documented above was finally
   * tested, and it did not earn its place.
   *
   * The comment this file has carried since Phase 1 asked for exactly one
   * thing — "a real backtest comparison (regime-adjusted vs. fixed
   * weights)". That ablation now exists (scripts/backtest/ablation.ts),
   * replaying the full production engine with these multipliers on and off
   * across the same five purged walk-forward folds:
   *
   *   fixed weights   +0.073%/trade, 4 of 5 folds positive, worst -0.573%
   *   these weights   -0.004%/trade, 3 of 5 folds positive, worst -0.584%
   *
   * Worse on return, worse on robustness, better on nothing.
   *
   * The caveat matters for how that is read: the difference is NOT
   * statistically established. On the 1,331 days both variants traded,
   * outcomes were byte-identical; the whole gap comes from 51 trades only
   * the fixed variant took (+1.374%, 95% CI [-0.603, +3.351]) and 19 only
   * this variant took (-1.921%, 95% CI [-4.928, +1.086]). Both intervals
   * straddle zero, and n=19 is below this codebase's own MIN_SAMPLE_N.
   *
   * So these are removed for PARSIMONY, not because they are proven
   * harmful: an explicitly unvalidated hypothesis that has now been
   * measured and shown no benefit does not belong in the live decision
   * path. Empty multipliers make regimeAdjustedCategoryWeights an identity
   * function, so the mechanism, its call site and its tests all survive —
   * repopulating this table is the only step needed to re-enable regime
   * weighting if a larger sample ever justifies it.
   */
  volatility: {
    high: {},
    low: {},
    normal: {},
  },
  rangeBound: {},
};

/**
 * CATEGORY_WEIGHTS adjusted for the given regime, renormalized to sum to 1.
 * Multiple applicable multipliers (e.g. high volatility AND range-bound)
 * compose multiplicatively, not additively. `regime: null` returns `base`
 * completely unchanged — the exact pre-Phase-1 behavior, so every existing
 * call site that hasn't been updated to pass a regime yet sees zero drift.
 *
 * `table` is injectable purely so the composition/renormalization mechanism
 * stays under test after Phase 4 emptied the production multipliers. With
 * the live table the function is currently an identity; tests supply their
 * own table to prove the machinery still behaves correctly, which is what
 * makes re-enabling regime weighting a data decision rather than a rewrite.
 */
export function regimeAdjustedCategoryWeights(
  base: Record<Category, number>,
  regime: RegimeTags | null,
  table: RegimeMultiplierTable = REGIME_WEIGHT_MULTIPLIERS
): Record<Category, number> {
  if (regime === null) return base;

  const multipliers: Partial<Record<Category, number>> = {};
  const applyMultipliers = (m: Partial<Record<Category, number>>) => {
    for (const [cat, factor] of Object.entries(m) as [Category, number][]) {
      multipliers[cat] = (multipliers[cat] ?? 1) * factor;
    }
  };

  applyMultipliers(table.volatility[regime.volatility]);
  if (regime.rangeBound) applyMultipliers(table.rangeBound);

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
