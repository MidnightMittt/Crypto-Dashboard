"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LeanGauge } from "@/components/ui/LeanGauge";
import { formatCompactUsd, formatUsd } from "@/lib/utils/format";
import { deribitOptionsLean } from "@/lib/sentiment/leans";
import { AggregateMarketData, DeribitOptionsSummary } from "@/types/market";

/**
 * BTC/ETH options positioning from Deribit — put/call ratio, max pain, and
 * ATM IV for one specific expiry. Genuinely different from every other card
 * on this dashboard, which is entirely perpetual futures: this describes
 * options-market structure, not perp positioning skew.
 *
 * Only ever populated for BTC and ETH — Deribit doesn't list options on the
 * other 8 assets. See DeribitOptionsSummary in types/market.ts for why
 * putCallRatio/maxPain are computed for one expiry rather than blended
 * across every listed date.
 */
export function DeribitOptionsIntelligence({ data }: { data: AggregateMarketData }) {
  const opt = data.deribitOptions;
  const trackable = data.asset === "BTC" || data.asset === "ETH";

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Deribit Options</CardTitle>
        {opt && <SkewBadge putCallRatio={opt.putCallRatio} />}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {!trackable ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Only tracked for BTC and ETH — Deribit, the dominant venue for crypto options, doesn&apos;t
            list options on the other 8 assets here.
          </p>
        ) : !opt ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Deribit didn&apos;t return usable options data this cycle, or no expiry currently has enough
            open interest to compute a meaningful reading. No key needed — this reads Deribit&apos;s
            public book-summary endpoint and fills in on its own.
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                {opt.expiry} expiry
              </span>
              <span className="font-mono text-[11px] text-ink-faint">
                {formatCompactUsd(opt.totalOpenInterestUsd)} total OI
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="font-mono text-2xl text-ink">{opt.putCallRatio.toFixed(2)}</div>
                <div className="text-[11px] uppercase tracking-widest text-ink-faint">Put/Call ratio</div>
              </div>
              <div>
                <div className="font-mono text-2xl text-ink">{formatUsd(opt.maxPain, 0)}</div>
                <div className="text-[11px] uppercase tracking-widest text-ink-faint">Max pain</div>
              </div>
            </div>

            <LeanGauge lean={deribitOptionsLean(opt.putCallRatio)} />

            {opt.atmIvPct !== null && (
              <div className="text-[11px] text-ink-faint">
                ATM implied vol <span className="font-mono text-ink-muted">{opt.atmIvPct.toFixed(1)}%</span>
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-ink-faint">{narrate(opt)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Dead zone matches the same "reuse an existing threshold, don't invent one" convention used elsewhere. */
const PUT_CALL_NEUTRAL_LOW = 0.8;
const PUT_CALL_NEUTRAL_HIGH = 1.2;

function SkewBadge({ putCallRatio }: { putCallRatio: number }) {
  if (putCallRatio > PUT_CALL_NEUTRAL_HIGH) return <Badge variant="amber">Put-heavy</Badge>;
  if (putCallRatio < PUT_CALL_NEUTRAL_LOW) return <Badge variant="cyan">Call-heavy</Badge>;
  return <Badge variant="neutral">Balanced</Badge>;
}

function narrate(opt: DeribitOptionsSummary): string {
  const skewLine =
    opt.putCallRatio > PUT_CALL_NEUTRAL_HIGH
      ? `More puts than calls are open (${opt.putCallRatio.toFixed(2)}) — positioning leans toward hedging or downside protection. A lot of put open interest is holders protecting spot, not a bearish bet, so don't read this alone as conviction.`
      : opt.putCallRatio < PUT_CALL_NEUTRAL_LOW
        ? `More calls than puts are open (${opt.putCallRatio.toFixed(2)}) — positioning leans toward upside speculation or covered-call writing against held spot.`
        : `Puts and calls are roughly balanced (${opt.putCallRatio.toFixed(2)}) — no clear skew in options positioning.`;

  const maxPainLine = ` Max pain for this expiry sits at ${formatUsd(opt.maxPain, 0)} — where open interest is concentrated, not a price target or a magnet with predictive power.`;

  return skewLine + maxPainLine;
}
