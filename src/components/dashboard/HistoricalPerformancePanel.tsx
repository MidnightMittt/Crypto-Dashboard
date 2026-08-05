"use client";

import { lookupMetricPerformance, BacktestMetricStats } from "@/lib/sentiment/backtestStats";
import { regimeTagLabel } from "@/lib/technicals/regimes";
import backtestMetricStatsJson from "@/data/backtestMetricStats.json";

/**
 * JSON imports widen string-literal union fields (`sampleSizeLabel`,
 * `confidenceLabel`) to plain `string` — a cast here, not a runtime check,
 * since report.ts's `deriveSampleSizeLabel`/`deriveConfidenceLabel` are the
 * single source of truth for what values this field can hold and both
 * write directly into this exact JSON file.
 */
const backtestMetricStats = backtestMetricStatsJson as BacktestMetricStats;

/**
 * The per-metric "has this actually worked historically" panel — the
 * concrete answer to "every bullish/bearish conclusion should carry
 * measurable historical performance." Slots into existing per-metric rows
 * (SignalBreakdown, CategoryCard's "Why?" list) rather than a new
 * top-level card, per the "keep the current UI/layout" constraint.
 *
 * Reads the small live-bundled `backtestMetricStats.json` (~10KB, not the
 * 1MB+ research file) via `lookupMetricPerformance`, which enforces the
 * same MIN_SAMPLE_N floor every other backtest stat in this app already
 * enforces — renders nothing at all below that floor, never a number with
 * false confidence.
 */
function regimeLabel(tag: string | undefined): string {
  return tag ? regimeTagLabel(tag) : "—";
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

const CONFIDENCE_TONE: Record<string, string> = {
  High: "text-success",
  Medium: "text-amber",
  Low: "text-ink-faint",
};

export function HistoricalPerformancePanel({
  metricId,
  /** The live regime tags for TODAY, if available — lets a matching best/worst environment be marked "(current)" rather than left as an abstract table. */
  currentRegimeTags,
}: {
  metricId: string;
  currentRegimeTags?: string[];
}) {
  const perf = lookupMetricPerformance(backtestMetricStats, metricId);
  if (!perf) return null;

  const bestIsCurrent = !!perf.bestRegime && !!currentRegimeTags?.includes(perf.bestRegime.tag);
  const worstIsCurrent = !!perf.worstRegime && !!currentRegimeTags?.includes(perf.worstRegime.tag);

  return (
    <div className="mt-1 rounded-md border border-hairline/60 bg-white/[0.02] p-2.5">
      <span className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">Historical Performance</span>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        <Stat label="Occurrences" value={String(perf.n24h)} />
        <Stat label="24 Hour Win Rate" value={pct(perf.winRate24h)} />
        <Stat label="7 Day Win Rate" value={pct(perf.winRate7d)} />
        <Stat
          label="Best Environment"
          value={regimeLabel(perf.bestRegime?.tag)}
          suffix={bestIsCurrent ? " (current)" : undefined}
        />
        <Stat
          label="Worst Environment"
          value={regimeLabel(perf.worstRegime?.tag)}
          suffix={worstIsCurrent ? " (current)" : undefined}
        />
        <Stat
          label="Confidence"
          value={perf.confidenceLabel ?? "—"}
          tone={perf.confidenceLabel ? CONFIDENCE_TONE[perf.confidenceLabel] : undefined}
        />
        <Stat label="Sample Size" value={perf.sampleSizeLabel ?? "—"} />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: string;
}) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`font-mono text-[11px] ${tone ?? "text-ink"}`}>
        {value}
        {suffix && <span className="text-ink-faint">{suffix}</span>}
      </dd>
    </div>
  );
}
