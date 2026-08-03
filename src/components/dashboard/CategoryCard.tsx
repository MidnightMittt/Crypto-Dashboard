"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, IntensityMeter, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Collapsible } from "@/components/ui/Collapsible";
import { CategoryScore } from "@/lib/signals/types";
import { intensityLabel } from "@/lib/signals/scoring";
import { CATEGORY_DESCRIPTIONS, METRIC_DESCRIPTIONS } from "@/lib/signals/descriptions";
import { lookupCategoryStat } from "@/lib/sentiment/backtestStats";
import backtestStats from "@/data/backtestStats.json";

/**
 * One shared card for all five categories — same component, five instances,
 * rather than five bespoke layouts. Headline score, intensity meter, the
 * single top-ranked contributing metric's own explanation, and a
 * Collapsible "Why?" listing every metric that fed the score.
 *
 * Nothing here is a new computation: `score`/`verdict`/`confidence`/
 * `topReason` all come straight from `buildCategoryScore` in
 * lib/signals/categories.ts.
 */
export function CategoryCard({ category }: { category: CategoryScore }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
              {category.label}
            </span>
            <InfoTooltip
              measures={CATEGORY_DESCRIPTIONS[category.category]}
              whyItMatters={`Combines ${category.metrics.length} metric${category.metrics.length === 1 ? "" : "s"} into one read for this category.`}
            />
          </div>
          <VerdictBadge verdict={category.verdict} />
        </div>

        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold leading-none text-ink">
            {category.score}
          </span>
          <span className="text-[11px] text-ink-faint">{intensityLabel(category.score)}</span>
        </div>

        <IntensityMeter value={category.score} tone={category.verdict} />

        <p className="text-[11px] leading-relaxed text-ink-faint">{category.topReason}</p>

        <div className="flex items-center justify-between">
          <ConfidenceLabel confidence={category.confidence} />
        </div>

        <BacktestStatLine category={category} />

        <Collapsible title="Why?" summary={`${category.metrics.length} metrics`}>
          <ul className="flex flex-col gap-2.5 pt-1">
            {category.metrics.map((m) => (
              <li key={m.id} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-xs font-medium text-ink">
                    {m.label}
                    <InfoTooltip
                      measures={METRIC_DESCRIPTIONS[m.id] ?? ""}
                      whyItMatters={m.whyItMatters}
                      trigger={m.nextTrigger}
                    />
                  </span>
                  <VerdictBadge verdict={m.verdict} />
                </div>
                <p className="text-[11px] leading-relaxed text-ink-faint">{m.explanation}</p>
              </li>
            ))}
          </ul>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

/**
 * Same pattern already shipped on PositioningIntelligence's squeeze read:
 * only renders once the backtested bucket clears MIN_SAMPLE_N, so a thin
 * bucket says nothing rather than stating a number with false confidence.
 */
function BacktestStatLine({ category }: { category: CategoryScore }) {
  const stat = lookupCategoryStat(backtestStats, category.category, category.verdict);
  if (!stat) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint">
      Historically, in the backtested window ({backtestStats.coverageStart} to{" "}
      {backtestStats.coverageEnd}, N={stat.n} days this category read {category.verdict}): price
      moved a mean {stat.mean1dPct >= 0 ? "+" : ""}
      {stat.mean1dPct.toFixed(1)}% over the next 24h. One narrow window, not a guarantee.
    </p>
  );
}
