"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge } from "@/components/ui/VerdictBadge";
import { AssetComposites } from "@/lib/exchanges/assetComposites";
import { Verdict } from "@/lib/signals/types";
import { formatPct } from "@/lib/utils/format";

/**
 * "BTC/ETH/Altcoin composite scores" — the Dashboard v2 spec's Section 2.
 * Every number here is a re-read of bias.score/verdict/confidence via
 * lib/exchanges/assetComposites.ts, which itself calls the SAME
 * getAggregateForAsset() every other view reads — no second opinion
 * computed here, per the charter's "one market, one truth."
 *
 * Refreshes on a much slower cadence than the live single-asset view (see
 * useAssetComposites.ts / assetComposites.ts's own doc comments for why) —
 * a deliberate tradeoff, not a bug, so scores here can lag the live
 * per-asset card by up to ~5 minutes.
 */
export function AssetCompositeSection({ data }: { data: AssetComposites | null | undefined }) {
  if (!data || (!data.btc && !data.eth && !data.altcoins)) return null;

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {data.btc && (
        <CompositeCard
          label="Bitcoin"
          score={data.btc.score}
          verdict={data.btc.verdict}
          confidence={data.btc.confidence}
          priceChange24hPct={data.btc.priceChange24hPct}
          priceChange7dPct={data.btc.priceChange7dPct}
          headline={data.btc.headline}
        />
      )}
      {data.eth && (
        <CompositeCard
          label="Ethereum"
          score={data.eth.score}
          verdict={data.eth.verdict}
          confidence={data.eth.confidence}
          priceChange24hPct={data.eth.priceChange24hPct}
          priceChange7dPct={data.eth.priceChange7dPct}
          headline={data.eth.headline}
        />
      )}
      {data.altcoins && (
        <CompositeCard
          label="Altcoins"
          subLabel={`${data.altcoins.assets.length} assets`}
          score={data.altcoins.score}
          verdict={data.altcoins.verdict}
          confidence={data.altcoins.confidence}
          priceChange24hPct={averageOf(data.altcoins.assets.map((a) => a.priceChange24hPct))}
          priceChange7dPct={averageOfNullable(data.altcoins.assets.map((a) => a.priceChange7dPct))}
          headline={`Confidence-weighted read across ${data.altcoins.assets.length} tracked altcoins.`}
        />
      )}
    </section>
  );
}

function averageOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function averageOfNullable(values: Array<number | null>): number | null {
  const real = values.filter((v): v is number => v !== null);
  if (real.length === 0) return null;
  return real.reduce((a, b) => a + b, 0) / real.length;
}

function CompositeCard({
  label,
  subLabel,
  score,
  verdict,
  confidence,
  priceChange24hPct,
  priceChange7dPct,
  headline,
}: {
  label: string;
  subLabel?: string;
  score: number;
  verdict: Verdict;
  confidence: number;
  priceChange24hPct: number;
  priceChange7dPct: number | null;
  headline: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-6">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold uppercase tracking-[0.14em] text-ink">{label}</span>
            {subLabel && <span className="text-[11px] text-ink-faint">{subLabel}</span>}
          </div>
          <VerdictBadge verdict={verdict} size="sm" />
        </div>

        <div className="flex items-baseline gap-3">
          <span className="font-mono text-4xl font-semibold leading-none tracking-tight text-ink">{score}</span>
          <span className="text-xs text-ink-faint">/ 100</span>
        </div>

        <div className="grid grid-cols-3 gap-3 border-t border-hairline pt-3">
          <Stat label="Confidence" value={`${confidence}%`} />
          <TrendStat label="24h" pct={priceChange24hPct} />
          <TrendStat label="7d" pct={priceChange7dPct} />
        </div>

        <p className="text-xs leading-relaxed text-ink-muted">{headline}</p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-ink">{value}</dd>
    </div>
  );
}

function TrendStat({ label, pct }: { label: string; pct: number | null }) {
  const toneClass = pct === null ? "text-ink-faint" : pct > 0 ? "text-success" : pct < 0 ? "text-danger" : "text-ink";
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm ${toneClass}`}>{pct === null ? "—" : formatPct(pct, 1)}</dd>
    </div>
  );
}
