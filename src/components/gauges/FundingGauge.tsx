"use client";

import { useMemo } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LeanGauge } from "@/components/ui/LeanGauge";
import { BandGauge } from "@/components/ui/BandGauge";
import { GaugeBase } from "./GaugeBase";
import { GaugeStat } from "./GaugeStat";
import { TrendArrow } from "./TrendArrow";
import { bandFor, FUNDING_BANDS } from "@/lib/sentiment/bands";
import { coinbasePremiumLean } from "@/lib/sentiment/leans";
import { formatFundingPct, formatPct, orDash } from "@/lib/utils/format";
import { AggregateMarketData } from "@/types/market";
import { gaugeTrail } from "@/lib/utils/gaugeTrail";

const COLORS = ["#7A1E1E", "#EF4444", "#F59E0B", "#6B7684", "#86EFAC", "#22C55E", "#14532D"];
// FUNDING_BANDS has 5 tiers (Extreme Shorts/Bearish/Neutral/Bullish/Crowded
// Longs); the 7-color array above is a continuous radial-gauge gradient.
// Sampling every other stop (skipping the two intermediate amber/light-
// green gradient waypoints) gives exactly 5 colors, index-matched to the
// 5 bands, reusing the same hex values rather than inventing new ones.
const FUNDING_BAND_COLORS = [COLORS[0], COLORS[1], COLORS[3], COLORS[5], COLORS[6]];

/**
 * Funding and basis normally point the same way — both reflect whether
 * leverage demand is long or short. A sign mismatch is worth flagging;
 * it usually means positioning is shifting faster than funding has repriced.
 */
function disagreesWithFunding(basisPct: number, fundingPct: number): boolean {
  if (Math.abs(basisPct) < 0.02 || Math.abs(fundingPct) < 0.002) return false;
  return Math.sign(basisPct) !== Math.sign(fundingPct);
}

export function FundingGauge({ data }: { data: AggregateMarketData }) {
  /*
   * This gauge's own recent trajectory. Memoized on `data.history`
   * because GaugeBase is memoized — a fresh array every render would
   * defeat that and restart the needle animation on each poll.
   */
  const trail = useMemo(() => gaugeTrail(data.history, (p) => p.weightedFundingRatePct), [data.history]);

  const band = bandFor(data.weightedFundingRatePct, FUNDING_BANDS);
  const badgeVariant =
    data.weightedFundingRatePct > 0.04 ? "success" : data.weightedFundingRatePct < -0.04 ? "danger" : "neutral";

  return (
    <Card className="flex flex-col items-center">
      <CardHeader className="w-full">
        <CardTitle>Aggregate Funding Rate</CardTitle>
        {data.fundingChange24hPct !== null && <TrendArrow value={data.fundingChange24hPct} />}
      </CardHeader>
      <CardContent className="flex w-full flex-col items-center gap-3 pt-0">
        <GaugeBase
          gaugeId="funding"
          value={data.weightedFundingRatePct}
          min={-0.3}
          max={0.3}
          ghostValue={trail.valueAgo}
          trail={trail.values}
          colors={COLORS}
          centerValue={formatFundingPct(data.weightedFundingRatePct)}
          centerLabel="Funding /8h (OI-weighted)"
        />
        <Badge variant={badgeVariant}>{band.label}</Badge>
        <p className="text-center text-xs leading-relaxed text-ink-muted">{band.description}</p>
        <div className="w-full">
          <BandGauge value={data.weightedFundingRatePct} bands={FUNDING_BANDS} colors={FUNDING_BAND_COLORS} />
        </div>
        <div className="mt-1 grid w-full grid-cols-3 gap-3 border-t border-hairline pt-3">
          <GaugeStat label="Annualized" value={formatPct(data.fundingAnnualizedPct, 1)} />
          <GaugeStat label="24h Δ" value={orDash(data.fundingChange24hPct, (v) => formatPct(v, 3))} />
          <GaugeStat label="Venues" value={data.exchanges.length} />
        </div>

        {/* Basis: perp price vs on-chain spot. A second read on the same
            question funding answers, from an independent source. */}
        <div className="w-full border-t border-hairline pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint">
              Basis vs spot
            </span>
            <span
              className={`font-mono text-sm ${
                data.basisPct === null
                  ? "text-ink-faint"
                  : data.basisPct > 0
                    ? "text-success"
                    : "text-danger"
              }`}
            >
              {orDash(data.basisPct, (v) => formatPct(v, 3))}
            </span>
          </div>
          {data.coinbasePremiumPct !== null && (
            <div className="mt-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                  Coinbase premium
                </span>
                <span
                  className={`font-mono text-xs ${
                    data.coinbasePremiumPct > 0 ? "text-success" : "text-danger"
                  }`}
                >
                  {formatPct(data.coinbasePremiumPct, 3)}
                </span>
              </div>
              <div className="mt-1.5">
                <LeanGauge lean={coinbasePremiumLean(data.coinbasePremiumPct)} />
              </div>
            </div>
          )}
          {data.spotDisagreementPct !== null && data.spotDisagreementPct > 1 && (
            <p className="mt-1 text-[11px] leading-relaxed text-amber">
              Spot sources disagree by {data.spotDisagreementPct.toFixed(2)}% — treat this basis figure
              with caution.
            </p>
          )}
          {data.basisPct !== null && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              {data.basisPct > 0
                ? "Perps trade above spot — longs paying up for leverage."
                : "Perps trade below spot — short pressure."}
              {disagreesWithFunding(data.basisPct, data.weightedFundingRatePct) &&
                " Note: basis and funding disagree, which is unusual."}
              {data.spotSource &&
                ` Spot: ${data.spotSource}${
                  data.spotSourceCount > 1 ? ` (${data.spotSourceCount} sources cross-checked)` : ""
                }.`}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
