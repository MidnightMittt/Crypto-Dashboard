"use client";

import { useMemo } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { ExchangeSnapshot } from "@/types/market";
import { getExchange } from "@/lib/exchanges/registry";
import { formatCompactUsd, formatBps, fundingPer8h } from "@/lib/utils/format";
import { ArrowRight } from "lucide-react";

interface Spread {
  asset: string;
  longVenue: string;
  shortVenue: string;
  spreadPct: number; // per-8h spread
  annualizedPct: number;
  minLiquidityUsd: number;
}

/**
 * Finds the widest funding spread per asset: you'd be paid on the venue
 * with the most negative funding (go long there) and pay on the venue with
 * the most positive funding (go short there), capturing the difference
 * while staying delta-neutral.
 *
 * Liquidity column matters — a huge spread on a venue with $2M open
 * interest usually isn't capturable at size.
 */
function findSpreads(exchanges: ExchangeSnapshot[]): Spread[] {
  const byAsset = new Map<string, ExchangeSnapshot[]>();
  exchanges.forEach((e) => {
    const list = byAsset.get(e.asset) ?? [];
    list.push(e);
    byAsset.set(e.asset, list);
  });

  const spreads: Spread[] = [];
  byAsset.forEach((list, asset) => {
    if (list.length < 2) return;
    const normalized = list.map((e) => ({
      snap: e,
      // Normalize every venue to an 8-hour equivalent so 1h-funding DEXs
      // and 8h-funding CEXs are actually comparable.
      per8h: fundingPer8h(e.fundingRatePct, e.fundingIntervalHours),
    }));
    const sorted = [...normalized].sort((a, b) => a.per8h - b.per8h);
    const cheapest = sorted[0];
    const richest = sorted[sorted.length - 1];
    const spreadPct = richest.per8h - cheapest.per8h;
    if (spreadPct <= 0) return;

    spreads.push({
      asset,
      longVenue: getExchange(cheapest.snap.exchangeId)?.name ?? cheapest.snap.exchangeId,
      shortVenue: getExchange(richest.snap.exchangeId)?.name ?? richest.snap.exchangeId,
      spreadPct,
      annualizedPct: spreadPct * 3 * 365,
      minLiquidityUsd: Math.min(cheapest.snap.openInterestUsd, richest.snap.openInterestUsd),
    });
  });

  return spreads.sort((a, b) => b.spreadPct - a.spreadPct).slice(0, 8);
}

export function ArbitrageScanner({ exchanges }: { exchanges: ExchangeSnapshot[] }) {
  const spreads = useMemo(() => findSpreads(exchanges), [exchanges]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Funding Spread Scanner</CardTitle>
        <span className="text-[10px] text-ink-faint">Normalized to 8h</span>
      </CardHeader>
      <div className="p-4 pt-2">
        {spreads.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">No meaningful spreads right now.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {spreads.map((s) => (
              <div
                key={`${s.asset}-${s.longVenue}-${s.shortVenue}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 text-xs hover:bg-white/5"
              >
                <span className="flex items-center gap-2">
                  <span className="w-10 font-semibold text-ink">{s.asset}</span>
                  <span className="flex items-center gap-1.5 text-ink-muted">
                    <span className="text-success">Long {s.longVenue}</span>
                    <ArrowRight className="h-3 w-3 text-ink-faint" />
                    <span className="text-danger">Short {s.shortVenue}</span>
                  </span>
                </span>
                <span className="flex items-center gap-4">
                  <span className="text-[10px] text-ink-faint">
                    liq. {formatCompactUsd(s.minLiquidityUsd)}
                  </span>
                  <span className="font-mono text-cyan">{formatBps(s.spreadPct)} bps</span>
                  <span className="w-16 text-right font-mono text-[11px] text-ink-muted">
                    {s.annualizedPct.toFixed(0)}%/yr
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
          Spreads shown are gross of fees, slippage, and margin costs — all three routinely eat a spread
          this size. Treat this as a screen for where to look, not a signal.
        </p>
      </div>
    </Card>
  );
}
