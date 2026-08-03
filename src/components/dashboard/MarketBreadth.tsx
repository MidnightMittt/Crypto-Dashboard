"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { LeanGauge } from "@/components/ui/LeanGauge";
import { BandGauge } from "@/components/ui/BandGauge";
import { formatCompactUsd, formatPct } from "@/lib/utils/format";
import { stablecoinFlowLean } from "@/lib/sentiment/leans";
import { DOMINANCE_ROTATION_BANDS } from "@/lib/sentiment/bands";
import { StablecoinSummary } from "@/lib/providers/stablecoins";
import { GlobalMarketSummary } from "@/lib/providers/globalMarket";
import { ALTSEASON_WINDOW_DAYS } from "@/lib/providers/globalMarket";

// Amber (BTC-heavy) - gray (neither) - cyan (alt-heavy). Deliberately NOT
// red/green: this axis isn't bullish/bearish, it's a rotation read, and
// using the same colors as the directional gauges elsewhere on this
// dashboard would visually imply a direction this doesn't have.
const DOMINANCE_ROTATION_COLORS = ["#F5A623", "#8890A0", "#2DD4E8"];

/**
 * Market-wide context that no per-asset card here can provide: total crypto
 * market cap and BTC dominance (is capital consolidating into BTC or
 * rotating into alts), and stablecoin supply (is capital entering crypto as
 * dry powder, or leaving it entirely). Same for every asset tab — this
 * doesn't change when you switch from BTC to SOL.
 */
export function MarketBreadth({
  stablecoins,
  globalMarket,
}: {
  stablecoins: StablecoinSummary | null;
  globalMarket: GlobalMarketSummary | null;
}) {
  if (!stablecoins && !globalMarket) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Market Breadth</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-0">
        {globalMarket && (
          <div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Total mcap" value={formatCompactUsd(globalMarket.totalMcapUsd)} />
              <Stat label="BTC dominance" value={`${globalMarket.btcDominancePct.toFixed(1)}%`} />
              <Stat
                label="Altseason index"
                value={`${globalMarket.altseasonIndex.toFixed(0)}/100`}
                tone={
                  globalMarket.altseasonIndex >= 75
                    ? "success"
                    : globalMarket.altseasonIndex <= 25
                      ? "danger"
                      : "neutral"
                }
              />
            </div>
            <div className="mt-3">
              <BandGauge
                value={globalMarket.altseasonIndex}
                bands={DOMINANCE_ROTATION_BANDS}
                colors={DOMINANCE_ROTATION_COLORS}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              {narrateAltseason(globalMarket.altseasonIndex)} 24h market cap{" "}
              {globalMarket.mcapChange24hPct >= 0 ? "+" : ""}
              {formatPct(globalMarket.mcapChange24hPct, 1)}.
            </p>
          </div>
        )}

        {stablecoins && (
          <div className="border-t border-hairline pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                Stablecoin supply
              </span>
              <span className="font-mono text-sm text-ink">
                {formatCompactUsd(stablecoins.totalMcapUsd)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <span className="text-ink-faint">
                24h{" "}
                <span className={stablecoins.netChange24hUsd >= 0 ? "text-success" : "text-danger"}>
                  {stablecoins.netChange24hUsd >= 0 ? "+" : ""}
                  {formatCompactUsd(stablecoins.netChange24hUsd)}
                </span>
              </span>
              <span className="text-right text-ink-faint">
                7d{" "}
                <span className={stablecoins.netChange7dUsd >= 0 ? "text-success" : "text-danger"}>
                  {stablecoins.netChange7dUsd >= 0 ? "+" : ""}
                  {formatCompactUsd(stablecoins.netChange7dUsd)}
                </span>
              </span>
            </div>
            <div className="mt-3">
              <LeanGauge lean={stablecoinFlowLean(stablecoins.netChange7dPct)} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              {narrateStablecoins(stablecoins)}{" "}
              {stablecoins.topIssuers
                .slice(0, 2)
                .map((i) => `${i.symbol} ${i.dominancePct.toFixed(0)}%`)
                .join(", ")}
              .
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "success" | "danger" | "neutral";
}) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div>
      <div className={`font-mono text-lg ${color}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-widest text-ink-faint">{label}</div>
    </div>
  );
}

function narrateAltseason(index: number): string {
  const window = ALTSEASON_WINDOW_DAYS;
  if (index >= 75) return `${index.toFixed(0)}% of the top 50 alts outperformed BTC over ${window}d — broad alt strength.`;
  if (index <= 25) return `Only ${index.toFixed(0)}% of the top 50 alts outperformed BTC over ${window}d — BTC-led market.`;
  return `${index.toFixed(0)}% of the top 50 alts outperformed BTC over ${window}d — no clear rotation either way.`;
}

function narrateStablecoins(s: StablecoinSummary): string {
  if (s.netChange7dUsd > 0) {
    return "Net stablecoin minting over 7d — capital entering as dry powder, historically read as a risk-on precursor. Led by";
  }
  if (s.netChange7dUsd < 0) {
    return "Net stablecoin burning over 7d — capital leaving crypto entirely, not just rotating between assets. Led by";
  }
  return "Stablecoin supply roughly flat over 7d. Led by";
}
