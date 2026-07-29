"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { GaugeBase } from "./GaugeBase";
import { GaugeStat } from "./GaugeStat";
import { TrendArrow } from "./TrendArrow";
import { bandFor, OI_BANDS } from "@/lib/sentiment/bands";
import { formatCompactUsd, formatPct, orDash } from "@/lib/utils/format";
import { AggregateMarketData } from "@/types/market";

const COLORS = ["#1B8A9A", "#2DD4E8", "#8890A0", "#F5A623", "#EF4444"];

export function OpenInterestGauge({ data }: { data: AggregateMarketData }) {
  const pctl = data.oiPercentile;
  const band = pctl !== null ? bandFor(pctl, OI_BANDS) : null;
  const badgeVariant = pctl === null ? "neutral" : pctl > 65 ? "amber" : pctl < 40 ? "cyan" : "neutral";

  return (
    <Card className="flex flex-col items-center">
      <CardHeader className="w-full">
        <CardTitle>Aggregate Open Interest</CardTitle>
        {data.oiChange24hPct !== null && <TrendArrow value={data.oiChange24hPct} />}
      </CardHeader>
      <CardContent className="flex w-full flex-col items-center gap-3 pt-0">
        <GaugeBase
          gaugeId="oi"
          value={pctl ?? 50}
          min={0}
          max={100}
          colors={COLORS}
          dimmed={pctl === null}
          centerValue={formatCompactUsd(data.totalOpenInterestUsd)}
          centerLabel="Total Open Interest"
        />
        <Badge variant={badgeVariant}>{band ? band.label : "Collecting"}</Badge>
        <p className="text-center text-xs leading-relaxed text-ink-muted">
          {band
            ? band.description
            : `No reachable venue publishes open-interest history, so this ranks against the app's own recorded data — ${data.historyHours.toFixed(1)}h so far, and it needs about 4h. Leave the server running.`}
        </p>
        <div className="mt-1 grid w-full grid-cols-2 gap-2 border-t border-hairline pt-3">
          <GaugeStat label="24h Change" value={orDash(data.oiChange24hPct, (v) => formatPct(v, 1))} />
          <GaugeStat label="Percentile" value={orDash(pctl, (v) => `${Math.round(v)}th`)} />
        </div>
      </CardContent>
    </Card>
  );
}
