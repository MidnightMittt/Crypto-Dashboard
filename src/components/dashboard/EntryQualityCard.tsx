"use client";

import { Star, Target as TargetIcon, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge } from "@/components/ui/VerdictBadge";
import { AggregateMarketData } from "@/types/market";
import { buildEntryQuality, StarRating } from "@/lib/signals/entryQuality";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { buildTradeRecommendation } from "@/lib/signals/tradeRecommendation";
import { lookupBiasVerdictStat } from "@/lib/sentiment/backtestStats";
import { formatUsd } from "@/lib/utils/format";
import backtestStats from "@/data/backtestStats.json";

/**
 * "Is this actually a high-quality entry?" — homepage module #3 from the
 * project charter's explicit spec. A pure derived view over data already
 * computed elsewhere (marketBias, technicals, liquidityMap, the backtested
 * biasVerdict win rate) — see lib/signals/entryQuality.ts's own doc comment
 * for exactly what feeds it and why nothing here is a fabricated
 * probability or a trade recommendation.
 *
 * Gated on `buildTradeRecommendation()`, not bare `bias.verdict` — a
 * directional bias alone isn't enough to show a setup; technical
 * confirmation must ALSO agree (see tradeRecommendation.ts's two-layer
 * gate), otherwise this card would show a full long/short plan with stars
 * even while price action is actively fighting the thesis.
 */
export function EntryQualityCard({ aggregate }: { aggregate: AggregateMarketData }) {
  const bias = aggregate.marketBias;

  if (!bias) {
    return (
      <EmptyState message="Not enough metrics have reported yet to assess entry quality." />
    );
  }

  const recommendation = buildTradeRecommendation(bias, aggregate.marketThesis, aggregate.technicals, aggregate.technicals4h);

  if (recommendation.action !== "enter-long" && recommendation.action !== "enter-short") {
    return (
      <EmptyState
        headline={recommendation.label}
        message={`${recommendation.reason}${recommendation.nextTrigger ? ` Next trigger: ${recommendation.nextTrigger}` : ""}`}
      />
    );
  }

  const winStat = lookupBiasVerdictStat(backtestStats, bias.verdict);
  // Same "first exchange with a price" fallback aggregator.ts itself already
  // uses internally (buildAggregate's base price) when a single representative
  // price is needed and nothing more specific applies — this dashboard has no
  // existing "the" price field, since it's funding/positioning-focused rather
  // than a price-chart tool.
  const price = aggregate.exchanges[0]?.price ?? 0;

  const eq = buildEntryQuality({
    verdict: bias.verdict,
    confidence: bias.confidence,
    agreement: bias.agreement,
    price,
    atrPct: aggregate.technicals?.atrPct ?? null,
    supportResistance: aggregate.liquidityMap?.supportResistance ?? [],
    historicalWinRatePct: winStat?.winRatePct ?? null,
    historicalWinRateN: winStat?.n ?? null,
  });

  if (!eq) {
    return (
      <EmptyState
        headline="Not enough data to place a reference stop"
        message={`The overall read is ${bias.verdict}, but technical volatility data (ATR) isn't available yet, so there's no honest way to size a stop.`}
      />
    );
  }

  const isLong = eq.verdict === "bullish";

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CardLabel />
            <VerdictBadge verdict={eq.verdict} size="sm" />
          </div>
          <StarDisplay stars={eq.stars} />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <PriceStat label="Entry" value={eq.entryPrice} tone="neutral" />
          <PriceStat label="Stop" value={eq.stopPrice} tone="bear" caption={eq.stopBasis} />
          <PriceStat label="TP1" value={eq.targetPrice} tone="bull" caption={eq.targetBasis} />
          <PriceStat label="TP2" value={eq.target2Price} tone="bull" caption={eq.target2Basis} />
          <div>
            <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Reward / Risk</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-mono text-lg text-ink">
              <TargetIcon className="h-3.5 w-3.5 text-ink-faint" />
              {eq.riskRewardRatio.toFixed(1)}:1
            </dd>
            <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">at TP2: {eq.riskRewardRatio2.toFixed(1)}:1</dd>
          </div>
        </div>

        {/*
          Support/resistance shown explicitly, right alongside the
          entry/stop/target numbers derived from it — not just implied by
          the basis captions above. Real zones (a range, not a point), with
          the same strength/reaction-count/status context the Liquidity
          Map card shows, so the trader can see WHY these specific levels
          matter without leaving this card.
        */}
        <div className="grid grid-cols-2 gap-4 border-t border-hairline pt-4">
          <ZoneStat label="Support" zone={eq.nearestSupport} tone="bull" />
          <ZoneStat label="Resistance" zone={eq.nearestResistance} tone="bear" />
        </div>

        <p className="text-sm leading-relaxed text-ink-muted">{eq.starRationale}</p>

        <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
          Reference levels derived from {isLong ? "support/resistance below" : "support/resistance above"}{" "}
          the current price and recent volatility (ATR) — not a trade recommendation. The
          stop above is the TRADE invalidation, not the broader market thesis — see the
          Invalidation level section above for what would change the thesis itself. The
          historical win rate describes how often this verdict&apos;s direction has been right over
          the next day across the backtested window, not the odds of this specific setup.
        </p>
      </CardContent>
    </Card>
  );
}

/** Consistent title across every branch (populated or empty) so the card is always identifiable as "Entry Quality," regardless of whether today's read has a qualifying setup. */
function CardLabel() {
  return <span className="text-[11px] uppercase tracking-[0.22em] text-ink-muted">Entry Quality</span>;
}

function EmptyState({ headline, message }: { headline?: string; message: string }) {
  return (
    <Card>
      <CardContent className="py-8">
        <div className="mb-2 flex items-center gap-3">
          <CardLabel />
        </div>
        {headline && (
          <div className="flex items-center gap-2 text-ink-muted">
            <ShieldAlert className="h-4 w-4" />
            <span className="text-sm font-medium">{headline}</span>
          </div>
        )}
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-faint">{message}</p>
      </CardContent>
    </Card>
  );
}

function StarDisplay({ stars }: { stars: StarRating }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${i <= stars ? "fill-amber text-amber" : "text-ink-faint"}`}
        />
      ))}
    </div>
  );
}

function ZoneStat({ label, zone, tone }: { label: string; zone: SupportResistanceZone | null; tone: "bull" | "bear" }) {
  const toneClass = tone === "bull" ? "text-success" : "text-danger";
  if (!zone) {
    return (
      <div>
        <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
        <dd className="mt-0.5 text-sm text-ink-faint">None identified nearby</dd>
      </div>
    );
  }
  const range = zone.priceLow === zone.priceHigh ? formatUsd(zone.priceLow) : `${formatUsd(zone.priceLow)}–${formatUsd(zone.priceHigh)}`;
  const detail = [
    zone.reactionCount > 0 ? `${zone.reactionCount} touch${zone.reactionCount === 1 ? "" : "es"}` : "volume-based",
    zone.status !== "inactive" ? zone.status : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm ${toneClass}`}>{range}</dd>
      <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">{detail}</dd>
    </div>
  );
}

function PriceStat({
  label,
  value,
  tone,
  caption,
}: {
  label: string;
  value: number;
  tone: "bull" | "bear" | "neutral";
  caption?: string;
}) {
  const toneClass = tone === "bull" ? "text-success" : tone === "bear" ? "text-danger" : "text-ink";
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg ${toneClass}`}>{formatUsd(value)}</dd>
      {caption && <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">{caption}</dd>}
    </div>
  );
}
