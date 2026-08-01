"use client";

import { useMemo } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { BandGauge } from "@/components/ui/BandGauge";
import { GaugeBase } from "./GaugeBase";
import { GaugeStat } from "./GaugeStat";
import { TrendArrow } from "./TrendArrow";
import { bandFor, OI_BANDS } from "@/lib/sentiment/bands";
import { formatCompactUsd, formatPct, orDash } from "@/lib/utils/format";
import { AggregateMarketData } from "@/types/market";
import { gaugeTrail } from "@/lib/utils/gaugeTrail";

const COLORS = ["#1B8A9A", "#2DD4E8", "#8890A0", "#F5A623", "#EF4444"];

/**
 * The percentile has two distinct reasons for being unavailable, and the old
 * copy conflated them into one sentence that contradicted itself — it claimed
 * "no reachable venue publishes open-interest history" while OKX does supply
 * it, and then said "19.9h so far, and it needs about 4h", which reads as an
 * unmet requirement that had already been met.
 *
 * Enough history is a necessary but not sufficient condition. A percentile
 * also needs the SAME set of venues reporting across the whole window,
 * otherwise it ranks today's cross-venue total against a series built from
 * fewer venues and pins itself at 100. See computeAggregateOiPercentile.
 */
const MIN_HOURS_FOR_PERCENTILE = 4;

function unavailableLabel(data: AggregateMarketData): string {
  return data.historyHours < MIN_HOURS_FOR_PERCENTILE ? "Collecting" : "Unavailable";
}

function unavailableReason(data: AggregateMarketData): string {
  const hours = data.historyHours;

  if (hours < MIN_HOURS_FOR_PERCENTILE) {
    return (
      `Ranking today's open interest needs a trailing window to compare against. ` +
      `${hours.toFixed(1)}h recorded so far, of roughly ${MIN_HOURS_FOR_PERCENTILE}h. ` +
      `The dollar figure above is live and unaffected.`
    );
  }

  return (
    `${hours.toFixed(1)}h of history is recorded, but a percentile needs the same ` +
    `set of venues reporting across the whole window — ranking today's total against ` +
    `a series built from fewer venues would pin this at 100. It resolves as coverage ` +
    `settles. The dollar figure above is live and unaffected.`
  );
}

export function OpenInterestGauge({ data }: { data: AggregateMarketData }) {
  /*
   * This gauge's own recent trajectory. Memoized on `data.history`
   * because GaugeBase is memoized — a fresh array every render would
   * defeat that and restart the needle animation on each poll.
   */
  const trail = useMemo(() => gaugeTrail(data.history, (p) => p.oiPercentile), [data.history]);

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
          ghostValue={trail.valueAgo}
          trail={trail.values}
          colors={COLORS}
          dimmed={pctl === null}
          centerValue={formatCompactUsd(data.totalOpenInterestUsd)}
          centerLabel="Total Open Interest"
        />
        <Badge variant={badgeVariant}>{band ? band.label : unavailableLabel(data)}</Badge>
        <p className="text-center text-xs leading-relaxed text-ink-muted">
          {band ? band.description : unavailableReason(data)}
        </p>
        {pctl !== null && (
          <div className="w-full">
            <BandGauge value={pctl} bands={OI_BANDS} colors={COLORS} />
          </div>
        )}
        <div className="mt-1 grid w-full grid-cols-2 gap-2 border-t border-hairline pt-3">
          <GaugeStat label="24h Change" value={orDash(data.oiChange24hPct, (v) => formatPct(v, 1))} />
          <GaugeStat label="Percentile" value={orDash(pctl, (v) => `${Math.round(v)}th`)} />
        </div>
      </CardContent>
    </Card>
  );
}
