"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { GaugeBase } from "@/components/gauges/GaugeBase";
import { MarketBias } from "@/lib/signals/types";
import { findConfidenceDrivers } from "@/lib/signals/confidence";
import { CATEGORY_WEIGHTS } from "@/lib/signals/categories";
import { Gauge } from "lucide-react";

/** Low confidence reads red, high reads green — a unidirectional "how good is this reading" scale, the same gradient shape LeverageHeatGauge uses for its own 0-100 unidirectional metric, just inverted (there, high is bad; here, high is good). */
const COLORS = ["#EF4444", "#F5A623", "#8890A0", "#2DD4E8", "#22C55E"];

/**
 * "AI Confidence Gauge" — homepage module #7 from the project charter's
 * explicit spec: a speedometer for confidence, with an explanation of what
 * increased or decreased it. Reuses GaugeBase directly (the same speedometer
 * every other 0-100 gauge on this page already uses) rather than building a
 * new visual pattern, and lib/signals/confidence.ts's findConfidenceDrivers
 * for the explanation — both already-computed data, nothing new derived.
 *
 * Confidence here is EVIDENCE QUALITY (completeness x agreement x backtest
 * coverage), never the odds of a price move — see MetricVerdict's own doc
 * comment in lib/signals/types.ts for why that distinction matters
 * throughout this app.
 */
export function ConfidenceGauge({ bias }: { bias: MarketBias | null }) {
  if (!bias) {
    return (
      <Card className="flex flex-col items-center">
        <CardHeader className="w-full">
          <CardTitle>AI Confidence</CardTitle>
          <Gauge className="h-4 w-4 text-ink-faint" />
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-center text-xs leading-relaxed text-ink-muted">
            Not enough metrics have reported yet to score confidence.
          </p>
        </CardContent>
      </Card>
    );
  }

  const drivers = findConfidenceDrivers(
    bias.categories.map((c) => ({
      label: c.label,
      confidence: c.confidence,
      weight: CATEGORY_WEIGHTS[c.category],
      metrics: c.metrics,
    }))
  );

  return (
    <Card className="flex flex-col items-center">
      <CardHeader className="w-full">
        <CardTitle>AI Confidence</CardTitle>
        <Gauge className="h-4 w-4 text-ink-faint" />
      </CardHeader>
      <CardContent className="flex w-full flex-col items-center gap-3 pt-0">
        <GaugeBase
          gaugeId="confidence"
          value={bias.confidence}
          min={0}
          max={100}
          colors={COLORS}
          centerValue={`${bias.confidence}`}
          centerLabel="Confidence"
        />
        <p className="text-center text-xs leading-relaxed text-ink-muted">
          How good the evidence behind this read is — how complete the data is, how well
          independent sources agree, and whether a backtest covers it. Not the odds of a move.
        </p>
        {drivers && (
          <div className="mt-1 grid w-full grid-cols-2 gap-3 border-t border-hairline pt-3">
            <div>
              <dt className="text-[9px] uppercase tracking-[0.14em] text-success">Pulling Up</dt>
              <dd className="mt-0.5 text-xs leading-snug text-ink-muted">
                <span className="font-medium text-ink">
                  {drivers.booster.categoryLabel} ({drivers.booster.categoryConfidence}%)
                </span>{" "}
                — {drivers.booster.weightPct}% of the overall weight. Best-supported: {drivers.booster.metricLabel} (
                {drivers.booster.metricConfidenceBasis})
              </dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-[0.14em] text-danger">Pulling Down</dt>
              <dd className="mt-0.5 text-xs leading-snug text-ink-muted">
                <span className="font-medium text-ink">
                  {drivers.drag.categoryLabel} ({drivers.drag.categoryConfidence}%)
                </span>{" "}
                — {drivers.drag.weightPct}% of the overall weight. Weakest link: {drivers.drag.metricLabel} (
                {drivers.drag.metricConfidenceBasis})
              </dd>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
