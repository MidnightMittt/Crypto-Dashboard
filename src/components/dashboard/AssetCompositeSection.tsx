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
export function AssetCompositeSection({
  data,
  selectedAsset,
}: {
  data: AssetComposites | null | undefined;
  /** The asset the decision surface above is about. Its own card must not restate that decision. */
  selectedAsset?: string;
}) {
  if (!data || (!data.btc && !data.eth && !data.altcoins)) return null;

  const current = (selectedAsset ?? "").toUpperCase();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">Rest of the market</h2>
        <span className="text-[11px] text-ink-faint">
          Comparison only — the decision for {current || "the selected asset"} is above
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {data.btc && (
          <CompositeCard
            label="Bitcoin"
            isCurrent={current === "BTC"}
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
            isCurrent={current === "ETH"}
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
      </div>
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

/**
 * `isCurrent` is the whole point of this component's redesign.
 *
 * When the strip renders the asset the page is already about, it used to
 * repeat that asset's verdict badge and its full headline sentence — so the
 * page stated one directional conclusion at the top and a second, separately
 * worded one here. Worse, this strip refreshes on a slower cadence, so the
 * two could show DIFFERENT scores for the same asset minutes apart.
 *
 * The charter allows exactly one conclusion per market. The current asset
 * therefore keeps its score purely as a COMPARISON anchor against the other
 * two, and drops both the badge and the sentence — the things that made it a
 * competing verdict rather than context.
 */
function CompositeCard({
  label,
  subLabel,
  isCurrent = false,
  score,
  verdict,
  confidence,
  priceChange24hPct,
  priceChange7dPct,
  headline,
}: {
  label: string;
  subLabel?: string;
  isCurrent?: boolean;
  score: number;
  verdict: Verdict;
  confidence: number;
  priceChange24hPct: number;
  priceChange7dPct: number | null;
  headline: string;
}) {
  return (
    <Card className={isCurrent ? "border-ink-faint/30 bg-white/[0.02]" : undefined}>
      <CardContent className="flex flex-col gap-4 py-6">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold uppercase tracking-[0.14em] text-ink">{label}</span>
            {subLabel && <span className="text-[11px] text-ink-faint">{subLabel}</span>}
          </div>
          {isCurrent ? (
            <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              Viewing
            </span>
          ) : (
            <VerdictBadge verdict={verdict} size="sm" />
          )}
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

        <p className="text-xs leading-relaxed text-ink-muted">
          {isCurrent ? "Shown for comparison against the rest of the market." : headline}
        </p>
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
