"use client";

import { useEffect, useState } from "react";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { Card } from "@/components/ui/Card";
import { ExchangeSnapshot } from "@/types/market";
import { getExchange } from "@/lib/exchanges/registry";
import { formatCompactUsd, formatCountdown, formatBps, formatPct, fundingPer8h, orDash } from "@/lib/utils/format";

export function ExchangeCard({
  snapshot,
}: {
  snapshot: ExchangeSnapshot & { marketCount?: number };
}) {
  // Set when this card represents many markets rolled up (whole-market view).
  const marketCount = snapshot.marketCount;
  const meta = getExchange(snapshot.exchangeId);
  const [countdown, setCountdown] = useState(formatCountdown(snapshot.nextFundingAt));

  useEffect(() => {
    const id = setInterval(() => setCountdown(formatCountdown(snapshot.nextFundingAt)), 1000);
    return () => clearInterval(id);
  }, [snapshot.nextFundingAt]);

  if (!meta) return null;

  const fundingTone =
    snapshot.fundingRatePct > 0.004 ? "success" : snapshot.fundingRatePct < -0.004 ? "danger" : "neutral";
  const sparkData = snapshot.sparkline.map((v, i) => ({ i, v }));

  return (
    <Card className="group flex flex-col gap-3 p-4 transition-colors hover:border-cyan/30">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-void"
            style={{ backgroundColor: meta.color }}
          >
            {meta.name.slice(0, 1)}
          </span>
          <div>
            <div className="text-sm font-medium text-ink">{meta.name}</div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">
              {meta.type} · {marketCount ? `${marketCount} markets` : snapshot.asset}
            </div>
          </div>
        </div>
        <span className="flex flex-col items-end gap-0.5">
          <span className="font-mono text-[11px] text-ink-muted">
            {snapshot.fundingIntervalHours}h
          </span>
          {snapshot.source && snapshot.source !== "direct" && (
            <span className="text-[9px] uppercase tracking-wide text-cyan/70">
              via {snapshot.source}
            </span>
          )}
        </span>
      </div>

      {marketCount ? null : sparkData.length > 1 ? (
        <div className="h-10 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={fundingTone === "success" ? "#22C55E" : fundingTone === "danger" ? "#EF4444" : "#8890A0"}
                strokeWidth={1.75}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-10 w-full items-center justify-center rounded border border-dashed border-hairline text-[10px] text-ink-faint">
          Collecting funding history…
        </div>
      )}

      <div className="grid grid-cols-2 gap-y-2 text-xs">
        <Stat
          label={marketCount ? "Funding /8h (wtd)" : "Funding /8h"}
          value={`${formatBps(fundingPer8h(snapshot.fundingRatePct, snapshot.fundingIntervalHours))} bps`}
          tone={fundingTone}
        />
        {marketCount ? (
          <Stat label="Markets" value={String(marketCount)} />
        ) : (
          <Stat label="Next Funding" value={countdown} mono />
        )}
        <Stat label="Open Interest" value={formatCompactUsd(snapshot.openInterestUsd)} />
        <Stat label="OI Δ 24h" value={orDash(snapshot.openInterestChange24hPct, (v) => formatPct(v, 1))} />
        <Stat label="Volume 24h" value={snapshot.volume24hUsd > 0 ? formatCompactUsd(snapshot.volume24hUsd) : "—"} />
        <Stat label="L/S Ratio" value={orDash(snapshot.longShortRatio, (v) => v.toFixed(2))} />
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger" | "neutral";
  mono?: boolean;
}) {
  const color =
    value === "—"
      ? "text-ink-faint"
      : tone === "success"
        ? "text-success"
        : tone === "danger"
          ? "text-danger"
          : "text-ink";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</span>
      <span className={`${mono ? "font-mono" : ""} text-[13px] font-medium ${color}`}>{value}</span>
    </div>
  );
}
