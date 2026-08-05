/**
 * Small, simple 5-level directional gauge — a horizontal bar with a marker
 * and a text label, not the big circular GaugeBase used for Funding/OI/
 * Leverage Heat/Long-Short. Those already exist for the metrics that
 * warranted a full radial gauge; this is deliberately smaller and plainer
 * for cards where the ask is "just tell me which way this leans, at a
 * glance" rather than a detailed 0-100 read.
 *
 * Only wire this onto a metric that has a genuine, defensible bullish/
 * bearish direction. Not every number does — correlation, for instance,
 * measures whether assets move together, which isn't inherently bullish or
 * bearish, and forcing a lean onto it would be the same "looks precise but
 * means nothing" trap this app avoids everywhere else (see why
 * fundingDivergence/squeezeRisk/cexDex/arbitrage spreads carry no
 * directional weight in lib/signals/scoring.ts's METRIC_WEIGHTS for the
 * same reason).
 */

export type Lean = "extreme-bearish" | "bearish" | "neutral" | "bullish" | "extreme-bullish";

const LEAN_CONFIG: Record<Lean, { label: string; color: string; position: number }> = {
  "extreme-bearish": { label: "Extremely Bearish", color: "#7A1E1E", position: 0 },
  bearish: { label: "Bearish", color: "#EF4444", position: 25 },
  neutral: { label: "Neutral", color: "#6B7684", position: 50 },
  bullish: { label: "Bullish", color: "#22C55E", position: 75 },
  "extreme-bullish": { label: "Extremely Bullish", color: "#14532D", position: 100 },
};

export function LeanGauge({ lean }: { lean: Lean }) {
  const config = LEAN_CONFIG[lean];

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative h-1.5 w-full rounded-full bg-gradient-to-r from-[#7A1E1E] via-[#6B7684] to-[#14532D]">
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-void"
          style={{ left: `${config.position}%`, backgroundColor: config.color }}
        />
      </div>
      <span
        className="text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: config.color }}
      >
        {config.label}
      </span>
    </div>
  );
}
