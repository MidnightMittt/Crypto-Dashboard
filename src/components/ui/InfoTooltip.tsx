"use client";

import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

/**
 * The hover/focus explainer every metric and category should carry: what it
 * measures, why it matters, and what would flip it bullish or bearish.
 *
 * Wraps its own TooltipProvider rather than assuming one exists at the app
 * root — HeatMap.tsx, the only other consumer of ui/Tooltip.tsx, does the
 * same, and there is no root-level provider mounted today.
 *
 * Deliberately built from fields the engine ALREADY computes
 * (`whyItMatters`, `nextTrigger`) rather than a second, hand-written copy —
 * a tooltip that quietly drifted from the metric's real logic would be
 * worse than no tooltip at all.
 */
export function InfoTooltip({
  measures,
  whyItMatters,
  trigger,
}: {
  /** One line: what this number actually is. */
  measures: string;
  whyItMatters: string;
  /**
   * The metric's own `nextTrigger` — already states both the bullish AND
   * bearish threshold in one sentence (see bandTrigger in sentiment/bands.ts),
   * so this is passed through as-is rather than split into two props that
   * would have to be reverse-engineered from one string.
   */
  trigger?: string | null;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="More about this metric" className="inline-flex align-middle">
            <Info className="h-3 w-3 text-ink-faint hover:text-ink-muted" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <dl className="flex flex-col gap-1.5 text-[11px] leading-relaxed">
            <div>
              <dt className="text-ink-muted">Measures</dt>
              <dd className="text-ink">{measures}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Why it matters</dt>
              <dd className="text-ink">{whyItMatters}</dd>
            </div>
            {trigger && (
              <div>
                <dt className="text-ink-muted">What would change this</dt>
                <dd className="text-ink">{trigger}</dd>
              </div>
            )}
          </dl>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
