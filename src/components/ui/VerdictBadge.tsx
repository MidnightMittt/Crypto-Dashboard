import { Verdict } from "@/lib/signals/types";

/**
 * The dashboard's single visual vocabulary for direction: 🟢 bullish,
 * 🟡 neutral, 🔴 bearish. Nothing else on a decision surface should invent
 * its own colour language — the whole point is that a reader learns three
 * symbols once and can then scan any card without re-reading a legend.
 */

const CONFIG: Record<Verdict, { dot: string; label: string; text: string }> = {
  bullish: { dot: "🟢", label: "BULLISH", text: "text-success" },
  neutral: { dot: "🟡", label: "NEUTRAL", text: "text-amber" },
  bearish: { dot: "🔴", label: "BEARISH", text: "text-danger" },
};

export function VerdictBadge({
  verdict,
  size = "sm",
}: {
  verdict: Verdict;
  size?: "sm" | "lg";
}) {
  const c = CONFIG[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold tracking-wider ${c.text} ${
        size === "lg" ? "text-base" : "text-[11px]"
      }`}
    >
      <span aria-hidden>{c.dot}</span>
      {c.label}
    </span>
  );
}

/**
 * Confidence, always rendered with the word "Signal" attached and a title
 * attribute spelling out what it measures.
 *
 * This is not decoration. A bare "72%" next to a directional call reads as
 * "72% chance this happens", which is precisely the claim this codebase
 * refuses to make — see MetricVerdict's doc comment in lib/signals/types.ts.
 */
export function ConfidenceLabel({ confidence, basis }: { confidence: number; basis?: string }) {
  return (
    <span
      className="font-mono text-[11px] text-ink-faint"
      title={`Signal confidence measures how much evidence supports this read — data completeness, agreement between sources, and whether any backtest covers it. It is NOT the probability of a price move.${basis ? ` ${basis}` : ""}`}
    >
      {confidence}% signal confidence
    </span>
  );
}

/**
 * A filled bar carrying magnitude — the intensity dimension that would
 * otherwise need a fourth, fifth, sixth color. `tone` picks the fill color;
 * pass "neutral" for a direction-agnostic value (e.g. Market Health) so it
 * never gets misread as bullish or bearish.
 */
export function IntensityMeter({
  value,
  tone,
}: {
  /** 0-100. */
  value: number;
  tone: Verdict | "neutral-value";
}) {
  const fill =
    tone === "bullish" ? "bg-success" : tone === "bearish" ? "bg-danger" : "bg-ink-faint";
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}
