"use client";

import { useMemo } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { BandGauge } from "@/components/ui/BandGauge";
import { GaugeBase } from "./GaugeBase";
import { GaugeStat } from "./GaugeStat";
import { bandFor, LEVERAGE_HEAT_BANDS } from "@/lib/sentiment/bands";
import { formatPct, orDash } from "@/lib/utils/format";
import { AggregateMarketData } from "@/types/market";
import { gaugeTrail } from "@/lib/utils/gaugeTrail";
import { Flame } from "lucide-react";

const COLORS = ["#2DD4E8", "#8890A0", "#F5A623", "#EF4444", "#7A1E1E"];

export function LeverageHeatGauge({ data }: { data: AggregateMarketData }) {
  /*
   * This gauge's own recent trajectory. Memoized on `data.history`
   * because GaugeBase is memoized — a fresh array every render would
   * defeat that and restart the needle animation on each poll.
   */
  const trail = useMemo(() => gaugeTrail(data.history, (p) => p.leverageHeatScore), [data.history]);

  const heat = data.leverageHeatScore;
  const band = heat !== null ? bandFor(heat, LEVERAGE_HEAT_BANDS) : null;
  const badgeVariant = heat === null ? "neutral" : heat > 60 ? "danger" : heat < 30 ? "cyan" : "amber";
  const priceStalled = Math.abs(data.priceChange24hPct) < 2;

  return (
    <Card className="flex flex-col items-center">
      <CardHeader className="w-full">
        <CardTitle>Leverage Heat</CardTitle>
        <Flame className={badgeVariant === "danger" ? "h-4 w-4 text-danger" : "h-4 w-4 text-ink-faint"} />
      </CardHeader>
      <CardContent className="flex w-full flex-col items-center gap-3 pt-0">
        <GaugeBase
          gaugeId="heat"
          value={heat ?? 50}
          min={0}
          max={100}
          ghostValue={trail.valueAgo}
          trail={trail.values}
          colors={COLORS}
          dimmed={heat === null}
          centerValue={heat === null ? "—" : String(heat)}
          centerLabel="Heat Score"
        />
        <Badge variant={badgeVariant}>{band ? band.label : "Collecting"}</Badge>
        <p className="text-center text-xs leading-relaxed text-ink-muted">
          {band
            ? band.description
            : `Needs a 24-hour open-interest trend to tell whether leverage is building. No reachable venue publishes one, so it comes from the app's own recorded data — ${data.historyHours.toFixed(1)}h of the 20h needed.`}
        </p>
        {heat !== null && (
          <div className="w-full">
            <BandGauge value={heat} bands={LEVERAGE_HEAT_BANDS} colors={COLORS} />
          </div>
        )}
        <div className="mt-1 grid w-full grid-cols-3 gap-2 border-t border-hairline pt-3">
          <GaugeStat label="OI Trend" value={orDash(data.oiChange24hPct, (v) => formatPct(v, 1))} />
          <GaugeStat label="Price 24h" value={formatPct(data.priceChange24hPct, 1)} />
          <GaugeStat
            label="Squeeze Risk"
            value={heat === null ? "—" : priceStalled && heat > 55 ? "Elevated" : "Normal"}
          />
        </div>
      </CardContent>
    </Card>
  );
}
