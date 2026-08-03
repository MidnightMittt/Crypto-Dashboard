"use client";

import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/Tooltip";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { ALL_ASSETS, EXCHANGES } from "@/lib/exchanges/registry";
import { ExchangeSnapshot } from "@/types/market";
import { lerpColorScale } from "@/lib/utils/color";
import { formatCompactUsd, formatCountdown, formatFundingPct } from "@/lib/utils/format";

const FUNDING_STOPS = ["#B91C1C", "#EF4444", "#5B2222", "#2A2F38", "#1F4D33", "#22C55E", "#15803D"];

/**
 * Funding intervals differ by venue (Kraken/Hyperliquid/dYdX settle hourly,
 * most CEXs every 8h), so raw rates are not comparable across columns.
 * Everything here is normalized to an 8-hour equivalent first.
 */
function per8h(s: ExchangeSnapshot): number {
  return s.fundingRatePct * (8 / s.fundingIntervalHours);
}

/** Basis points — 0.01% = 1bp. Keeps real-world funding readable as integers. */
function toBps(pct: number): number {
  return pct * 100;
}

/**
 * Typical funding clusters near the 0.01%/8h baseline while extremes reach
 * 0.15%+. A linear color ramp wastes almost its entire range on values that
 * never occur, leaving normal days uniformly grey. A signed square root
 * expands the middle so ordinary variation is visible without flattening
 * the extremes.
 */
function colorPosition(bps: number): number {
  const MAX_BPS = 15; // 0.15% per 8h — a genuinely extreme reading
  const norm = Math.max(-1, Math.min(1, bps / MAX_BPS));
  return Math.sign(norm) * Math.sqrt(Math.abs(norm));
}

export function HeatMap({ exchanges }: { exchanges: ExchangeSnapshot[] }) {
  const byKey = new Map<string, ExchangeSnapshot>();
  exchanges.forEach((e) => byKey.set(`${e.asset}:${e.exchangeId}`, e));

  // Only show venues that returned something, so the grid isn't mostly blanks.
  const activeExchanges = EXCHANGES.filter((ex) =>
    exchanges.some((e) => e.exchangeId === ex.id)
  );
  const activeAssets = ALL_ASSETS.filter((a) => exchanges.some((e) => e.asset === a));

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Funding Heat Map</CardTitle>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-ink-faint">Basis points per 8h</span>
          <Legend />
        </div>
      </CardHeader>

      <div className="overflow-x-auto p-4 pt-2">
        <TooltipProvider delayDuration={100}>
          <table className="w-full border-separate border-spacing-1">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-panel px-2 py-1 text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  Asset
                </th>
                {activeExchanges.map((ex) => (
                  <th
                    key={ex.id}
                    className="px-1 py-1 text-center text-[11px] font-medium uppercase tracking-wide text-ink-faint"
                    title={`${ex.name} — funding every ${
                      exchanges.find((e) => e.exchangeId === ex.id)?.fundingIntervalHours ?? "?"
                    }h`}
                  >
                    {ex.name.length > 9 ? ex.name.slice(0, 8) + "…" : ex.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeAssets.map((asset) => (
                <tr key={asset}>
                  <td className="sticky left-0 z-10 bg-panel px-2 py-1 text-xs font-semibold text-ink">
                    {asset}
                  </td>
                  {activeExchanges.map((ex) => {
                    const snap = byKey.get(`${asset}:${ex.id}`);
                    if (!snap) {
                      return (
                        <td key={ex.id} className="p-0">
                          <div className="flex h-9 w-14 items-center justify-center rounded bg-white/[0.02] text-[11px] text-ink-faint">
                            —
                          </div>
                        </td>
                      );
                    }

                    const normalized = per8h(snap);
                    const bps = toBps(normalized);
                    const bg = lerpColorScale(colorPosition(bps), -1, 1, FUNDING_STOPS);

                    return (
                      <td key={ex.id} className="p-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className="flex h-9 w-14 cursor-default items-center justify-center rounded font-mono text-[11px] font-semibold text-white transition-transform hover:scale-110"
                              style={{ backgroundColor: bg }}
                            >
                              {bps >= 0 ? "+" : ""}
                              {bps.toFixed(1)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="space-y-1">
                              <div className="font-semibold text-ink">
                                {asset} · {ex.name}
                              </div>
                              <div>
                                Published rate: {formatFundingPct(snap.fundingRatePct)} per{" "}
                                {snap.fundingIntervalHours}h
                              </div>
                              <div className="text-cyan">
                                Normalized: {bps >= 0 ? "+" : ""}
                                {bps.toFixed(2)} bps per 8h
                              </div>
                              <div>
                                Annualized: {(normalized * 3 * 365).toFixed(1)}%
                              </div>
                              <div>Open Interest: {formatCompactUsd(snap.openInterestUsd)}</div>
                              <div>Volume 24h: {formatCompactUsd(snap.volume24hUsd)}</div>
                              <div>Next funding: {formatCountdown(snap.nextFundingAt)}</div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </TooltipProvider>

        <p className="mt-3 border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
          1 bp = 0.01%. Venues settle funding on different schedules — hourly on Kraken, Hyperliquid, and
          dYdX; every 8h on most CEXs — so every cell is converted to an 8-hour equivalent before being
          compared. Hover any cell to see the venue&apos;s own published rate alongside it.
        </p>
      </div>
    </Card>
  );
}

function Legend() {
  const marks = [-10, -3, 0, 3, 10];
  return (
    <div className="flex items-center gap-1">
      {marks.map((bps) => (
        <span key={bps} className="flex items-center gap-1">
          <span
            className="h-3 w-3 rounded-sm"
            style={{ backgroundColor: lerpColorScale(colorPosition(bps), -1, 1, FUNDING_STOPS) }}
          />
          <span className="text-[11px] text-ink-faint">{bps > 0 ? `+${bps}` : bps}</span>
        </span>
      ))}
    </div>
  );
}
