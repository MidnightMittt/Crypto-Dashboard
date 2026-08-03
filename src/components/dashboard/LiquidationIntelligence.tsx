"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatCompactUsd } from "@/lib/utils/format";
import { AggregateMarketData, LiquidationBucket } from "@/types/market";

/**
 * Observed forced-close volume over the trailing window.
 *
 * Deliberately NOT a price-level heatmap. A genuine price-level liquidation
 * heatmap (which venue's book has how much stacked at which price) needs a
 * leverage-distribution model over full order-book depth — proprietary
 * methodology this app has no data source for. Faking one with estimated
 * numbers would violate the one rule this whole codebase is built around:
 * show "—" rather than a plausible-looking invented figure.
 *
 * What Coinalyze's liquidation-history endpoint actually gives us is real:
 * observed long vs short liquidation DOLLARS per hour, summed across
 * reporting venues. That is what this panel shows — a genuine history of
 * what already happened, not a simulated map of what might.
 *
 * Pairs with the squeeze-setup badge in PositioningIntelligence: that one is
 * forward-looking ("how primed is the market for the next unwind"); this one
 * is backward-looking ("what already got forced out, and which side").
 */
export function LiquidationIntelligence({ data }: { data: AggregateMarketData }) {
  const liq = data.liquidations;

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Liquidation Intelligence</CardTitle>
        {liq && <DominantBadge dominantSide={liq.dominantSide} longSharePct={liq.longSharePct} />}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {!liq ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Needs a Coinalyze key (COINALYZE_API_KEY) — it is the only source here that
            publishes actual liquidation volume. Everything else on this dashboard works
            without it; this one panel does not.
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                Forced closes · {liq.windowHours >= 1 ? `${liq.windowHours.toFixed(0)}h window` : "building history"}
              </span>
              <span className="font-mono text-[11px] text-ink-faint">
                {liq.venues.length} venue{liq.venues.length === 1 ? "" : "s"}
              </span>
            </div>

            <LiquidationBars history={liq.history} />

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <span className="text-ink-faint">
                <span className="text-danger">Longs liquidated</span>{" "}
                {formatCompactUsd(liq.totalLongUsd)}
              </span>
              <span className="text-right text-ink-faint">
                <span className="text-success">Shorts liquidated</span>{" "}
                {formatCompactUsd(liq.totalShortUsd)}
              </span>
            </div>

            <p className="text-[11px] leading-relaxed text-ink-faint">{narrate(liq)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DominantBadge({
  dominantSide,
  longSharePct,
}: {
  dominantSide: NonNullable<AggregateMarketData["liquidations"]>["dominantSide"];
  longSharePct: number;
}) {
  if (dominantSide === "balanced") return <Badge variant="neutral">Balanced</Badge>;
  const tone = dominantSide === "long" ? "danger" : "success";
  const share = dominantSide === "long" ? longSharePct : 100 - longSharePct;
  return (
    <Badge variant={tone}>
      {dominantSide === "long" ? "Longs" : "Shorts"} took {share.toFixed(0)}% of liquidations
    </Badge>
  );
}

function narrate(liq: NonNullable<AggregateMarketData["liquidations"]>): string {
  const total = liq.totalLongUsd + liq.totalShortUsd;
  if (total <= 0) {
    return "No liquidations recorded across reporting venues over this window — a quiet market.";
  }
  if (liq.dominantSide === "balanced") {
    return "Liquidations were roughly split between longs and shorts — no one-sided flush.";
  }
  return liq.dominantSide === "long"
    ? "Longs bore most of the forced closes — consistent with a downside move stopping out over-leveraged longs. This describes what already happened, not what's next."
    : "Shorts bore most of the forced closes — consistent with an upside move stopping out over-leveraged shorts. This describes what already happened, not what's next.";
}

/**
 * Plain SVG bars, matching this codebase's established "no chart library for
 * a decoration-scale visualization" rule (see Sparkline.tsx). Longs drawn
 * below the axis in red, shorts above in green/above — the same red-down /
 * green-up convention every liquidation tracker uses, so it reads correctly
 * on sight rather than needing a legend.
 */
function LiquidationBars({ history }: { history: LiquidationBucket[] }) {
  if (history.length === 0) {
    return (
      <div className="flex h-14 w-full items-center justify-center rounded border border-dashed border-hairline text-[11px] text-ink-faint">
        Collecting liquidation history…
      </div>
    );
  }

  const maxVal = Math.max(1, ...history.map((b) => Math.max(b.longUsd, b.shortUsd)));
  const barWidth = 100 / history.length;

  return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="none" className="h-14 w-full" aria-hidden="true">
      {/* zero-line */}
      <line x1={0} y1={28} x2={100} y2={28} stroke="rgba(255,255,255,0.08)" strokeWidth={0.5} />
      {history.map((b, i) => {
        const x = i * barWidth + barWidth * 0.15;
        const w = barWidth * 0.7;
        const longH = (b.longUsd / maxVal) * 26;
        const shortH = (b.shortUsd / maxVal) * 26;
        return (
          <g key={b.t}>
            {/* longs: below the axis, red */}
            <rect x={x} y={28} width={w} height={longH} fill="#EF4444" opacity={0.75} />
            {/* shorts: above the axis, green */}
            <rect x={x} y={28 - shortH} width={w} height={shortH} fill="#22C55E" opacity={0.75} />
          </g>
        );
      })}
    </svg>
  );
}
