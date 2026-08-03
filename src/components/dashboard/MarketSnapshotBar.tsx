"use client";

import { useEffect, useState } from "react";
import { VerdictBadge, IntensityMeter } from "@/components/ui/VerdictBadge";
import { MarketBias } from "@/lib/signals/types";
import { intensityLabel } from "@/lib/signals/scoring";

/**
 * The 5-second read, pinned to the top of the viewport: Overall Bias,
 * Confidence, Trend Strength, Risk, Market Health. Every number here is
 * already computed by `buildMarketBias` — this is presentation only.
 *
 * Sticks directly under the existing sticky `Header` (untouched, shared
 * with /options) rather than being merged into it. Header's rendered
 * height is measured at runtime via ResizeObserver rather than assumed,
 * since it wraps to two lines below the `sm` breakpoint.
 */
export function MarketSnapshotBar({ bias }: { bias: MarketBias | null }) {
  const [headerHeight, setHeaderHeight] = useState(0);

  useEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const update = () => setHeaderHeight(header.getBoundingClientRect().height);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  if (!bias) return null;

  return (
    <div
      className="sticky z-30 -mx-4 border-b border-hairline bg-void/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6"
      style={{ top: headerHeight }}
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-8 gap-y-3">
        <Field label="Market Bias">
          <div className="flex items-center gap-2">
            <VerdictBadge verdict={bias.verdict} />
            <span className="text-xs text-ink-faint">{intensityLabel(bias.score)}</span>
          </div>
        </Field>

        <Field label="Confidence">
          <MeterValue value={bias.confidence} tone="neutral-value" />
        </Field>

        <Field label="Trend Strength">
          {bias.trendStrength ? (
            <MeterValue
              value={bias.trendStrength.value}
              tone="neutral-value"
              display={bias.trendStrength.label}
            />
          ) : (
            <span className="text-xs text-ink-faint">—</span>
          )}
        </Field>

        <Field label="Risk">
          <RiskValue level={bias.riskLevel} rationale={bias.riskRationale} />
        </Field>

        <Field label="Market Health">
          <MeterValue value={bias.healthScore} tone="neutral-value" />
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function MeterValue({
  value,
  tone,
  display,
}: {
  value: number;
  tone: "neutral-value";
  display?: string;
}) {
  return (
    <div className="flex w-24 flex-col gap-1">
      <span className="font-mono text-sm leading-none text-ink">{display ?? `${value}%`}</span>
      <IntensityMeter value={value} tone={tone} />
    </div>
  );
}

/**
 * Risk keeps its own amber/red tones rather than the 3-color direction
 * vocabulary — confirmed with the user as the one intentional exception,
 * since risk was never a directional signal in the first place.
 */
function RiskValue({ level, rationale }: { level: MarketBias["riskLevel"]; rationale: string }) {
  const tone =
    level === "high" ? "text-danger" : level === "medium" ? "text-amber" : "text-ink-faint";
  return (
    <span className={`text-sm font-semibold uppercase tracking-wide ${tone}`} title={rationale}>
      {level}
    </span>
  );
}
