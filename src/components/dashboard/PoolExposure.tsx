"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { getExchange } from "@/lib/exchanges/registry";
import { formatCompactUsd } from "@/lib/utils/format";
import { AggregateMarketData } from "@/types/market";

/**
 * Net notional positioning at peer-to-pool venues.
 *
 * Kept separate from the Long/Short gauge on purpose, and the distinction is
 * worth stating plainly because the two look interchangeable and aren't:
 *
 *   Long/Short gauge  — how many TRADERS are on each side (OKX account ratio)
 *   This panel        — how many DOLLARS are on each side (pool notional)
 *
 * An order book can only publish the first: its notional is balanced by
 * construction, since every long is matched by a short. A peer-to-pool venue
 * can publish the second, because the pool itself absorbs the imbalance.
 */
export function PoolExposure({ data }: { data: AggregateMarketData }) {
  const exposure = data.poolExposure;

  if (!exposure) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pool Net Exposure</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs leading-relaxed text-ink-muted">
            No peer-to-pool venue reported this asset. Only venues where a
            liquidity pool takes the other side — Jupiter, GMX, Synthetix —
            can publish a notional long/short split. On an order book the two
            sides are always equal, which is why the positioning gauge above
            counts traders rather than dollars.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { longUsd, shortUsd, netSkewPct, venues } = exposure;
  const total = longUsd + shortUsd;
  const longPct = total > 0 ? (longUsd / total) * 100 : 50;

  const traderSide = netSkewPct >= 0 ? "long" : "short";
  const tone = Math.abs(netSkewPct) < 10 ? "neutral" : netSkewPct > 0 ? "success" : "danger";

  const venueNames = venues.map((v) => getExchange(v)?.name ?? v);

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Pool Net Exposure</CardTitle>
        <Badge variant={tone}>
          {Math.abs(netSkewPct) < 10
            ? "Balanced"
            : `Traders net ${traderSide} ${Math.abs(netSkewPct).toFixed(0)}%`}
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pt-0">
        {/* Proportional bar — the whole point is the gap between the sides. */}
        <div>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/[0.04]">
            <div className="bg-success/70" style={{ width: `${longPct}%` }} />
            <div className="bg-danger/70" style={{ width: `${100 - longPct}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-[11px]">
            <span className="text-success">
              Long {formatCompactUsd(longUsd)} · {longPct.toFixed(1)}%
            </span>
            <span className="text-danger">
              Short {formatCompactUsd(shortUsd)} · {(100 - longPct).toFixed(1)}%
            </span>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-ink-muted">
          Traders are net <span className="text-ink">{traderSide}</span> by{" "}
          <span className="text-ink">{formatCompactUsd(Math.abs(longUsd - shortUsd))}</span>,
          which is the same as saying the pool is net{" "}
          {traderSide === "long" ? "short" : "long"} by that amount. Unlike the
          positioning gauge — which counts traders — this counts dollars, and it
          only exists because a pool, not another trader, is on the other side.
        </p>

        <p className="text-[11px] text-ink-faint">Source: {venueNames.join(", ")}</p>
      </CardContent>
    </Card>
  );
}
