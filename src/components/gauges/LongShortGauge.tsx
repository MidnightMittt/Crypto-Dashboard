"use client";

import { useMemo } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { BandGauge } from "@/components/ui/BandGauge";
import { GaugeBase } from "./GaugeBase";
import { GaugeStat } from "./GaugeStat";
import { bandFor, LONG_SHORT_BANDS } from "@/lib/sentiment/bands";
import { getExchange } from "@/lib/exchanges/registry";
import { AggregateMarketData } from "@/types/market";
import { gaugeTrail } from "@/lib/utils/gaugeTrail";

const COLORS = ["#EF4444", "#8890A0", "#22C55E"];

export function LongShortGauge({ data }: { data: AggregateMarketData }) {
  /*
   * This gauge's own recent trajectory. Memoized on `data.history`
   * because GaugeBase is memoized — a fresh array every render would
   * defeat that and restart the needle animation on each poll.
   */
  const trail = useMemo(() => gaugeTrail(data.history, (p) =>
        p.longShortRatio !== null && p.longShortRatio !== undefined
          ? (p.longShortRatio / (p.longShortRatio + 1)) * 100
          : null), [data.history]);

  const ratio = data.longShortRatio;
  const longPct = ratio !== null ? (ratio / (ratio + 1)) * 100 : null;
  const band = longPct !== null ? bandFor(longPct, LONG_SHORT_BANDS) : null;
  const badgeVariant =
    longPct === null ? "neutral" : longPct > 65 ? "success" : longPct < 35 ? "danger" : "neutral";

  // Only some venues publish positioning data — name the ones behind this number.
  const reporting = data.exchanges
    .filter((e) => e.longShortRatio !== null)
    .map((e) => getExchange(e.exchangeId)?.name ?? e.exchangeId);
  const uniqueReporting = Array.from(new Set(reporting));

  return (
    <Card className="flex flex-col items-center">
      <CardHeader className="w-full">
        <CardTitle>Long vs Short Positioning</CardTitle>
      </CardHeader>
      <CardContent className="flex w-full flex-col items-center gap-3 pt-0">
        <GaugeBase
          gaugeId="longshort"
          value={longPct ?? 50}
          min={0}
          max={100}
          ghostValue={trail.valueAgo}
          trail={trail.values}
          colors={COLORS}
          dimmed={longPct === null}
          centerValue={ratio !== null ? `${ratio.toFixed(2)}:1` : "—"}
          centerLabel="Long : Short"
        />
        <Badge variant={badgeVariant}>{band ? band.label : "Unavailable"}</Badge>
        <p className="text-center text-xs leading-relaxed text-ink-muted">
          {band
            ? band.description
            : "Only Binance, Bybit, and OKX publish positioning data, and none are reachable from your connection. This one can't be reconstructed locally — it's not derivable from open interest or funding."}
        </p>
        {longPct !== null && (
          <div className="w-full">
            <BandGauge value={longPct} bands={LONG_SHORT_BANDS} colors={COLORS} />
          </div>
        )}
        <div className="mt-1 grid w-full grid-cols-2 gap-2 border-t border-hairline pt-3">
          <GaugeStat label="Long Share" value={longPct !== null ? `${longPct.toFixed(1)}%` : "—"} />
          <GaugeStat label="Short Share" value={longPct !== null ? `${(100 - longPct).toFixed(1)}%` : "—"} />
        </div>
        {uniqueReporting.length > 0 && (
          <p className="text-center text-[11px] text-ink-faint">
            Source: {uniqueReporting.join(", ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
