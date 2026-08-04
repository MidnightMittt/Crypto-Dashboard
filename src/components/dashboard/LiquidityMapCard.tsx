"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { LiquidityMapRead, OrderFlowSummary } from "@/types/market";
import { MetricVerdict } from "@/lib/signals/types";
import { CATEGORY_DESCRIPTIONS } from "@/lib/signals/descriptions";
import { formatCompactUsd } from "@/lib/utils/format";

const SOURCE_LABELS: Record<string, string> = {
  "swing-high": "swing high",
  "swing-low": "swing low",
  "fib-level": "Fibonacci level",
  "volume-poc": "volume point of control",
  "value-area-edge": "value area edge",
};

/**
 * Liquidity Map's own card, not a `CategoryCard` variant — this section is a
 * structural read (where is price likely to move next) rather than a
 * directional one, so it deliberately carries no score or verdict badge. See
 * marketStructure.ts and Part 1d of the redesign plan for why.
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
  const levels = liquidityMap?.supportResistance ?? [];
  const supports = levels
    .filter((l) => l.kind === "support")
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  const resistances = levels
    .filter((l) => l.kind === "resistance")
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  const profile = liquidityMap?.volumeProfile ?? null;
  const imbalance = orderFlow?.bookImbalance ?? null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Liquidity Map
          </span>
          <InfoTooltip
            measures={CATEGORY_DESCRIPTIONS.liquidityMap}
            whyItMatters="Estimates where price is most likely to move next based on liquidity, not which direction is favored."
          />
        </div>

        {!liquidityMap ? (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Not enough daily candle history yet to map structure for this asset.
          </p>
        ) : (
          <>
            <LevelColumn title="Resistance above" levels={resistances} tone="text-danger" />
            <LevelColumn title="Support below" levels={supports} tone="text-success" />

            {profile && (
              <div className="border-t border-hairline pt-2.5">
                <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">
                  Point of control
                </span>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                  Volume has concentrated between{" "}
                  <span className="font-mono text-ink">
                    {formatPrice(profile.pointOfControl.priceLow)}
                  </span>{" "}
                  and{" "}
                  <span className="font-mono text-ink">
                    {formatPrice(profile.pointOfControl.priceHigh)}
                  </span>{" "}
                  over the trailing 90 days — the &ldquo;fair value&rdquo; area. Value area:{" "}
                  <span className="font-mono text-ink">{formatPrice(profile.valueAreaLow)}</span> to{" "}
                  <span className="font-mono text-ink">{formatPrice(profile.valueAreaHigh)}</span>.
                </p>
              </div>
            )}
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
      </CardContent>
    </Card>
  );
}

function LevelColumn({
  title,
  levels,
  tone,
}: {
  title: string;
  levels: { price: number; source: string }[];
  tone: string;
}) {
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">{title}</span>
      {levels.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">None identified nearby.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {levels.map((l, i) => (
            <li key={i} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
              <span className={`font-mono ${tone}`}>{formatPrice(l.price)}</span>
              <span className="text-ink-faint">{SOURCE_LABELS[l.source] ?? l.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  });
}
