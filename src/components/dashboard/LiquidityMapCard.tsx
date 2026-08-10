"use client";

import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { LiquidityMapRead, OrderFlowSummary } from "@/types/market";
import { MetricVerdict } from "@/lib/signals/types";
import { SupportResistanceZone, ZoneStatus } from "@/lib/technicals/marketStructure";
import { formatCompactUsd, formatPrice } from "@/lib/utils/format";

const STATUS_LABELS: Record<ZoneStatus, string> = {
  approaching: "approaching",
  testing: "testing now",
  rejecting: "rejected recently",
  reclaiming: "reclaiming",
  breaking: "breaking",
  inactive: "inactive",
};

const CONFLUENCE_LABELS: Record<string, string> = {
  "swing-cluster": "swing cluster",
  "volume-poc": "volume point of control",
  "value-area-edge": "value area edge",
};

/**
 * Structural read (where is price likely to move next) rather than a
 * directional one, so it deliberately carries no score or verdict badge —
 * see marketStructure.ts. Dashboard V2: no longer its own top-level card;
 * embedded as expandable raw detail behind Positioning Intelligence's
 * CategoryCard (see page.tsx), so no outer Card wrapper here.
 *
 * The zone list already surfaces the volume profile's point of control and
 * value-area edges (as their own zones, or as confluence tags on swing
 * clusters that overlap them) — no separate "Point of control" block, which
 * would just restate the same information a second way.
 */
export function LiquidityMapCard({
  liquidityMap,
  orderFlow,
  liquidationsMetric,
}: {
  liquidityMap: LiquidityMapRead | null;
  orderFlow: OrderFlowSummary | null;
  liquidationsMetric: MetricVerdict | null;
}) {
  const zones = liquidityMap?.supportResistance ?? [];
  const supports = zones
    .filter((z) => z.kind === "support")
    .sort((a, b) => b.priceHigh - a.priceHigh)
    .slice(0, 3);
  const resistances = zones
    .filter((z) => z.kind === "resistance")
    .sort((a, b) => a.priceLow - b.priceLow)
    .slice(0, 3);
  const imbalance = orderFlow?.bookImbalance ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
          Liquidity Map
        </span>
        <InfoTooltip
          measures="Where price structure suggests the market is likely to move next — clustered swing highs/lows and the volume profile's point of control, not arbitrary lines."
          whyItMatters="Estimates where price is most likely to move next based on structure, not which direction is favored."
        />
      </div>

      {!liquidityMap ? (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Not enough daily candle history yet to map structure for this asset.
        </p>
      ) : (
        <>
          <ZoneColumn title="Resistance above" zones={resistances} tone="text-danger" />
          <ZoneColumn title="Support below" zones={supports} tone="text-success" />
        </>
      )}

      {imbalance && (
        <div className="border-t border-hairline pt-2.5">
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            Order book imbalance
          </span>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            Bid depth {formatCompactUsd(imbalance.bid.usd)} vs. ask depth{" "}
            {formatCompactUsd(imbalance.ask.usd)} (
            {imbalance.imbalancePct >= 0 ? "+" : ""}
            {imbalance.imbalancePct.toFixed(1)}% toward {imbalance.imbalancePct >= 0 ? "bids" : "asks"}
            ) across {imbalance.depthLevels} price levels.
          </p>
        </div>
      )}

      {liquidationsMetric && (
        <div className="border-t border-hairline pt-2.5">
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            Recent flushes
          </span>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            {liquidationsMetric.explanation}
          </p>
        </div>
      )}

      <p className="border-t border-hairline pt-2.5 text-[10px] leading-relaxed text-ink-faint/75">
        Structure is estimated from trailing daily OHLCV and top-of-book depth, not a
        tick-level order book reconstruction. Support/resistance levels are historical
        reaction zones, not guarantees.
      </p>
    </div>
  );
}

function ZoneColumn({ title, zones, tone }: { title: string; zones: SupportResistanceZone[]; tone: string }) {
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">{title}</span>
      {zones.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">None identified nearby.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1.5">
          {zones.map((z, i) => (
            <li key={i} className="text-[11px] leading-relaxed">
              <span className={`font-mono ${tone}`}>{formatZoneRange(z)}</span>{" "}
              <span className="text-ink-faint">
                {z.reactionCount > 0 ? `${z.reactionCount} touch${z.reactionCount === 1 ? "" : "es"}` : "volume-based"}
                {z.confluence.length > 0 && ` · ${z.confluence.map((c) => CONFLUENCE_LABELS[c] ?? c).join(", ")}`}
                {z.status !== "inactive" && ` · ${STATUS_LABELS[z.status]}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A zone with no real width (e.g. a degenerate single-bucket volume zone) collapses to one price rather than showing a redundant "$100–$100" range. */
function formatZoneRange(zone: SupportResistanceZone): string {
  if (zone.priceLow === zone.priceHigh) return formatPrice(zone.priceLow);
  return `${formatPrice(zone.priceLow)}–${formatPrice(zone.priceHigh)}`;
}
