"use client";

import { Star, Target as TargetIcon, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge } from "@/components/ui/VerdictBadge";
import { AggregateMarketData } from "@/types/market";
import { buildEntryQuality, StarRating } from "@/lib/signals/entryQuality";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { executionDistanceContext, ExecutionWallContext } from "@/lib/technicals/liquidityWalls";
import { buildTradeRecommendation } from "@/lib/signals/tradeRecommendation";
import { lookupTradeStatsBySide, ExecutionStatsSnapshot } from "@/lib/sentiment/backtestStats";
import { formatPrice, formatCompactUsd } from "@/lib/utils/format";
import executionStatsJson from "@/data/executionStats.json";

const executionStats = executionStatsJson as unknown as ExecutionStatsSnapshot;

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
    /*
     * Deliberately NOT repeating recommendation.reason/nextTrigger here —
     * that full sentence is already the first thing on the page, in the
     * Decision block. Restating it verbatim would be pure duplication.
     *
     * But structure IS shown, even with no qualifying entry. Support and
     * resistance don't depend on whether a trade cleared the gate, and a
     * trader waiting for a trigger needs "where is price relative to
     * structure" more than anyone — previously this branch rendered a
     * single sentence and the levels vanished from the page entirely.
     */
    return (
      <EmptyState
        headline={recommendation.label}
        message="No qualifying entry — see the action above for the current read."
        structure={
          <MarketStructureRow
            price={aggregate.exchanges[0]?.price ?? 0}
            zones={aggregate.liquidityMap?.supportResistance ?? []}
          />
        }
      />
    );
  }

  /*
   * Trade-level, not directional. The star rating implies "would this trade
   * have worked," and only a measured trade outcome answers that — a
   * directional win rate counts a signal as correct even when the position
   * built on it stopped out first. Direction-specific because longs and
   * shorts behaved very differently over the backtested window.
   */
  const isEnterLong = recommendation.action === "enter-long";
  const tradeStats = lookupTradeStatsBySide(executionStats, isEnterLong ? "long" : "short");
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
    historicalWinRatePct: tradeStats?.winRatePct ?? null,
    historicalWinRateN: tradeStats?.n ?? null,
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

  /*
   * Real order-book wall context for this specific plan — computed here,
   * not in the aggregator, because entry/stop/TP1/TP2 only exist once
   * buildEntryQuality() above has run. See liquidityWalls.ts's own header:
   * the visible book spans ~0.01% of price while these levels sit 0.5-4
   * ATR away, so `withinVisibleDepth` will be true for ENTRY alone in the
   * large majority of real setups — that is the expected, honest result.
   */
  const walls = aggregate.liquidityMap?.walls ?? null;
  const wallContext = walls
    ? executionDistanceContext(
        [
          { point: "entry", price: eq.entryPrice },
          { point: "stop", price: eq.stopPrice },
          { point: "tp1", price: eq.targetPrice },
          { point: "tp2", price: eq.target2Price },
        ],
        walls.bidWalls,
        walls.askWalls,
        walls.bookPriceRange
      )
    : [];

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

        <LiquidityContextLine context={wallContext} />

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

        {/*
          Given its own labeled block, not a clause buried in the
          disclaimer paragraph below — paired visually and lexically with
          the Executive Summary card's "Thesis invalidation" section, so
          both concepts are equally discoverable, per the charter's
          explicit "keep trade invalidation and thesis invalidation
          visually and conceptually distinct" requirement.
        */}
        <div className="flex flex-col gap-1 rounded-md border border-danger/20 bg-danger/[0.04] px-3 py-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-danger">
            Trade invalidation
          </span>
          <p className="text-xs leading-relaxed text-ink-muted">
            <span className="font-mono text-ink">{formatPrice(eq.stopPrice)}</span> — {eq.stopBasis}. This
            stops the TRADE; the broader market thesis can still hold even if this level breaks — see
            Thesis invalidation above for what would change the thesis itself.
          </p>
        </div>

        {tradeStats && (
          /*
            The "why should I trust this setup" line — measured trade
            outcomes, not a directional drift statistic. Deliberately leads
            with the sample size and reports the excursions, because the
            headline rate alone hides how much heat a winning trade took.
          */
          <p className="text-[11px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Historically:</span> of {tradeStats.n} comparable{" "}
            {isLong ? "long" : "short"} setups in the backtested window, {tradeStats.winRatePct.toFixed(0)}% finished
            in profit after fees, slippage and funding. {tradeStats.targetHitRatePct.toFixed(0)}% reached TP1 before
            the stop, {tradeStats.stopHitRatePct.toFixed(0)}% stopped out, and{" "}
            {tradeStats.timeoutRatePct.toFixed(0)}% were still open at the 7-day limit.
            {tradeStats.mae && tradeStats.mfe && (
              <>
                {" "}
                The median trade drew down {Math.abs(tradeStats.mae.median).toFixed(1)}% against the position before
                resolving, and ran {tradeStats.mfe.median.toFixed(1)}% in favour at best.
              </>
            )}
          </p>
        )}

        <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
          Reference levels derived from {isLong ? "support/resistance below" : "support/resistance above"}{" "}
          the current price and recent volatility (ATR) — not a trade recommendation. The
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

function EmptyState({ headline, message, structure }: { headline?: string; message: string; structure?: React.ReactNode }) {
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
        {structure}
      </CardContent>
    </Card>
  );
}

/**
 * Where price sits relative to structure, shown even when no trade
 * qualifies. The levels come from the same `supportResistance` zones
 * buildEntryQuality() would use for a real setup — nothing is recomputed
 * or invented, it's the identical canonical zone list the Liquidity Map
 * renders. Renders nothing at all when there are no zones, rather than
 * showing empty scaffolding.
 */
function MarketStructureRow({ price, zones }: { price: number; zones: SupportResistanceZone[] }) {
  const support = zones.filter((z) => z.kind === "support" && z.priceHigh < price).sort((a, b) => b.priceHigh - a.priceHigh)[0] ?? null;
  const resistance = zones.filter((z) => z.kind === "resistance" && z.priceLow > price).sort((a, b) => a.priceLow - b.priceLow)[0] ?? null;
  if (!support && !resistance) return null;

  return (
    <div className="mt-5 grid grid-cols-3 gap-4 border-t border-hairline pt-4">
      <ZoneStat label="Support" zone={support} tone="bull" />
      <div>
        <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Price now</dt>
        <dd className="mt-0.5 font-mono text-sm text-ink">{price > 0 ? formatPrice(price) : "—"}</dd>
      </div>
      <ZoneStat label="Resistance" zone={resistance} tone="bear" />
    </div>
  );
}

const POINT_LABEL: Record<ExecutionWallContext["point"], string> = {
  entry: "Entry",
  stop: "Stop",
  tp1: "TP1",
  tp2: "TP2",
};

/**
 * Renders nothing when the book found no wall at any of the four prices —
 * the expected, common outcome for stop/TP1/TP2 (see liquidityWalls.ts's
 * header). Silence here is the honest behavior, not a fallback state to
 * explain away.
 */
function LiquidityContextLine({ context }: { context: ExecutionWallContext[] }) {
  const hits = context.filter((c) => c.wall !== null);
  if (hits.length === 0) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint">
      <span className="text-ink-muted">Order book:</span>{" "}
      {hits
        .map((h) => {
          const w = h.wall!;
          return `a significant ${w.side} wall (${formatCompactUsd(w.usd)}) sits right at ${POINT_LABEL[h.point].toLowerCase()} (${formatPrice(w.price)})`;
        })
        .join("; ")}
      .
    </p>
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
  const range = zone.priceLow === zone.priceHigh ? formatPrice(zone.priceLow) : `${formatPrice(zone.priceLow)}–${formatPrice(zone.priceHigh)}`;
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
      <dd className={`mt-0.5 font-mono text-lg ${toneClass}`}>{formatPrice(value)}</dd>
      {caption && <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">{caption}</dd>}
    </div>
  );
}
