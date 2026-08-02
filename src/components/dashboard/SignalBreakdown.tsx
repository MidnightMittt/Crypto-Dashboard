"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { MetricVerdict } from "@/lib/signals/types";

/**
 * Every metric, each answering the same question in the same shape:
 * verdict, confidence, one-sentence why, why it matters, and when it was
 * observed.
 *
 * One uniform table rather than a verdict header bolted onto each existing
 * card. That was the alternative, and it would have scattered the same five
 * fields across a dozen components with a dozen slightly different layouts —
 * the opposite of the "learn the format once, scan anything" goal. The
 * existing cards keep their detailed views; this is the scannable index.
 */
export function SignalBreakdown({ metrics }: { metrics: MetricVerdict[] }) {
  if (metrics.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Signal Breakdown</CardTitle>
        <span className="text-[10px] uppercase tracking-widest text-ink-muted">
          {metrics.length} metrics
        </span>
      </CardHeader>

      <CardContent className="pt-0">
        <ul className="flex flex-col divide-y divide-hairline">
          {metrics.map((m) => (
            <SignalRow key={m.id} metric={m} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SignalRow({ metric }: { metric: MetricVerdict }) {
  return (
    <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-ink">{metric.label}</span>
        <div className="flex items-center gap-3">
          <ConfidenceLabel confidence={metric.confidence} basis={metric.confidenceBasis} />
          <VerdictBadge verdict={metric.verdict} />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">{metric.explanation}</p>

      <p className="text-[10px] leading-relaxed text-ink-faint/70">
        <span className="text-ink-muted">Why it matters:</span> {metric.whyItMatters}
      </p>

      {/*
        Surfaced rather than smoothed over. A metric whose related signals
        disagree is a genuinely weaker read, and hiding that would make the
        card look more decisive than the data is.
      */}
      {metric.conflicts.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-1">
          {metric.conflicts.map((c, i) => (
            <li key={i} className="text-[10px] leading-relaxed text-amber/80">
              ⚠ {c}
            </li>
          ))}
        </ul>
      )}

      <span className="font-mono text-[9px] text-ink-faint/60">
        Updated {new Date(metric.asOf).toLocaleTimeString()}
      </span>
    </li>
  );
}
