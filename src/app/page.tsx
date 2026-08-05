"use client";

import { AlertTriangle } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { AiMarketSummary } from "@/components/dashboard/AiMarketSummary";
import { CategoryCard } from "@/components/dashboard/CategoryCard";
import { LiquidityMapCard } from "@/components/dashboard/LiquidityMapCard";
import { MarketThesisTimeline } from "@/components/dashboard/MarketThesisTimeline";
import { SignalBreakdown } from "@/components/dashboard/SignalBreakdown";
import { FundingGauge } from "@/components/gauges/FundingGauge";
import { OpenInterestGauge } from "@/components/gauges/OpenInterestGauge";
import { LeverageHeatGauge } from "@/components/gauges/LeverageHeatGauge";
import { LongShortGauge } from "@/components/gauges/LongShortGauge";
import { ExchangeGrid } from "@/components/dashboard/ExchangeGrid";
import { HeatMap } from "@/components/dashboard/HeatMap";
import { Leaderboards } from "@/components/dashboard/Leaderboards";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { AiSummary } from "@/components/dashboard/AiSummary";
import { ArbitrageScanner } from "@/components/dashboard/ArbitrageScanner";
import { PoolExposure } from "@/components/dashboard/PoolExposure";
import { PositioningIntelligence } from "@/components/dashboard/PositioningIntelligence";
import { LiquidationIntelligence } from "@/components/dashboard/LiquidationIntelligence";
import { OrderFlowIntelligence } from "@/components/dashboard/OrderFlowIntelligence";
import { ExchangeFlowIntelligence } from "@/components/dashboard/ExchangeFlowIntelligence";
import { DeribitOptionsIntelligence } from "@/components/dashboard/DeribitOptionsIntelligence";
import { MarketBreadth } from "@/components/dashboard/MarketBreadth";
import { CorrelationHeatmap } from "@/components/dashboard/CorrelationHeatmap";
import { NetworkHealth } from "@/components/dashboard/NetworkHealth";
import { DashboardSkeleton, LowerSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { Collapsible } from "@/components/ui/Collapsible";
import { Button } from "@/components/ui/Button";
import { useMarketData } from "@/lib/hooks/useMarketData";
import { useDashboardStore } from "@/lib/store/dashboardStore";
import { getExchange } from "@/lib/exchanges/registry";
import { regimeTagsToStrings } from "@/lib/technicals/regimes";

export default function DashboardPage() {
  const asset = useDashboardStore((s) => s.asset);
  const { data, isLoading, isError, refetch } = useMarketData(asset);

  const aggregate = data?.aggregate;

  // `ready` gates only the panels that need exchange data. The chart is
  // rendered in both branches because it sources its series independently.
  const ready = !isLoading && !!aggregate && aggregate.exchanges.length > 0;
  const noData = !isLoading && !!aggregate && aggregate.exchanges.length === 0;

  // Today's live trend/volatility/range-bound tags, threaded to every
  // per-metric HistoricalPerformancePanel so a backtested best/worst
  // environment can be marked "(current)" — see that component's doc comment.
  const currentRegimeTags = aggregate?.marketThesis?.regimeTags
    ? regimeTagsToStrings(aggregate.marketThesis.regimeTags)
    : undefined;

  const venueCount = aggregate ? new Set(aggregate.exchanges.map((e) => e.exchangeId)).size : undefined;
  const unavailable = (aggregate?.unavailableExchanges ?? [])
    .map((id) => getExchange(id)?.name ?? id);

  // How many venues came first-hand vs via an aggregator.
  const directCount = aggregate?.exchanges.filter((e) => e.source === "direct").length ?? 0;
  const viaProvider = aggregate?.exchanges.filter((e) => e.source && e.source !== "direct") ?? [];
  const providerNames = Array.from(new Set(viaProvider.map((e) => e.source)));

  return (
    <div className="min-h-screen">
      <Header venueCount={venueCount} updatedAt={data?.meta.generatedAt} />

      <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6">
        {isError && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3">
            <span className="flex items-center gap-2 text-sm text-danger">
              <AlertTriangle className="h-4 w-4" />
              Market data didn&apos;t load. The exchange APIs may be unreachable or rate-limiting.
            </span>
            <Button size="sm" variant="danger" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {noData ? (
          <div className="rounded-lg border border-amber/30 bg-amber/5 p-6">
            <h2 className="text-sm font-semibold text-amber">No exchange returned data</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
              Every venue failed for this asset. Usually that means no network connection, a firewall
              blocking the exchange APIs, or the asset isn&apos;t listed anywhere. Check your terminal — each
              failure logs the reason.
            </p>
            <Button size="sm" variant="outline" className="mt-4" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !ready ? (
          <>
            <DashboardSkeleton />
            <Skeleton className="h-[420px] w-full" />
            <LowerSkeleton />
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 rounded-md border border-hairline bg-white/[0.02] px-3 py-2 text-[11px] text-ink-faint">
              <span>
                <span className="text-ink-muted">Sources:</span> {directCount} venue
                {directCount === 1 ? "" : "s"} queried directly
                {viaProvider.length > 0 && (
                  <>
                    , {viaProvider.length} via {providerNames.join(" / ")}
                  </>
                )}
                . Data redistributed by DefiLlama and Coinalyze.
              </span>
              {unavailable.length > 0 && (
                <span>
                  Not reporting: {unavailable.join(", ")} — excluded from every number below rather than
                  estimated.
                </span>
              )}
            </div>

            {/*
              The single answer to "what's the highest-probability direction
              right now, and why" — the first thing a reader interprets.
              Everything below is either the four raw readings that feed it,
              the composite sections that explain it, or the audit trail
              behind it.
            */}
            <AiMarketSummary
              bias={aggregate.marketBias}
              thesis={aggregate.marketThesis}
              technicals={aggregate.technicals}
            />

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <FundingGauge data={aggregate} />
              <OpenInterestGauge data={aggregate} />
              <LeverageHeatGauge data={aggregate} />
              <LongShortGauge data={aggregate} />
            </section>

            {/*
              The five composite sections — Leveraged Positioning, Spot
              Demand, Market Stress, Liquidity Map, Network Health — the
              dashboard's default reading surface. Same underlying metrics
              the summary above synthesizes, regrouped into how a trader
              actually thinks about the market; nothing new is fetched.
              Liquidity Map and Network Health are structural/contextual, not
              directional, so they render their own card shapes rather than
              CategoryCard's score+verdict layout — see LiquidityMapCard.tsx
              and NetworkHealth.tsx.
            */}
            {aggregate.marketBias && aggregate.marketBias.categories.length > 0 && (
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {aggregate.marketBias.categories
                  .filter((c) => c.category !== "liquidityMap")
                  .map((c) => (
                    <CategoryCard key={c.category} category={c} currentRegimeTags={currentRegimeTags} />
                  ))}
                <LiquidityMapCard
                  liquidityMap={aggregate.liquidityMap}
                  orderFlow={aggregate.orderFlow}
                  liquidationsMetric={
                    aggregate.marketBias.metrics.find((m) => m.id === "liquidations") ?? null
                  }
                />
                <NetworkHealth data={data?.networkHealth} stablecoins={data?.stablecoins ?? null} />
              </section>
            )}

            {/*
              How the read got here. Sits directly under the sections above
              because the arc and the current state are one story — a
              cautiously bullish thesis that has been decaying all day means
              something different from one that has been building.
            */}
            <MarketThesisTimeline timeline={aggregate.biasTimeline} bias={aggregate.marketBias} />

            {/*
              ── THE AUDIT TRAIL ───────────────────────────────────────────
              Every metric in one uniform shape, so the summary and sections
              above are auditable rather than taken on trust. Collapsed by
              default — this is raw-data depth, not the default reading
              surface.
            */}
            <Collapsible
              title="All 15 Signals"
              summary={`${aggregate.marketBias?.metrics.length ?? 0} metrics`}
            >
              <SignalBreakdown metrics={aggregate.marketBias?.metrics ?? []} currentRegimeTags={currentRegimeTags} />
            </Collapsible>

            {/*
              ── TIER 3 — THE DETAIL ───────────────────────────────────────
              Nothing here is deleted; it is demoted. Each of these cards
              renders exactly as it did before, but collapsed by default,
              because the engine above has already read them. A trader who
              wants to audit a specific number opens the relevant group; a
              trader who wants the market read never has to.
            */}
            <Collapsible
              title="Leveraged Positioning & Liquidity Detail"
              summary="squeeze, funding percentile, CEX/DEX, order flow"
            >
              <div className="flex flex-col gap-4">
                <PositioningIntelligence data={aggregate} />
                <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <OrderFlowIntelligence data={aggregate} />
                  <LiquidationIntelligence data={aggregate} />
                </section>
              </div>
            </Collapsible>

            <Collapsible title="Spot Demand & Options Detail" summary="exchange netflow, Deribit, pool exposure">
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ExchangeFlowIntelligence data={aggregate} />
                <DeribitOptionsIntelligence data={aggregate} />
                <PoolExposure data={aggregate} />
              </section>
            </Collapsible>

            <Collapsible title="Market Context" summary="breadth, correlation">
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <MarketBreadth stablecoins={data?.stablecoins ?? null} globalMarket={data?.globalMarket ?? null} />
                <CorrelationHeatmap correlation={data?.correlation ?? null} />
              </section>
            </Collapsible>

            <Collapsible
              title="Venue Breakdown"
              summary={`${venueCount ?? aggregate.exchanges.length} venues`}
            >
              <div className="flex flex-col gap-6">
                <ExchangeGrid exchanges={aggregate.exchanges} />
                <section>
                  <SectionTitle>Cross-Market Funding</SectionTitle>
                  <HeatMap exchanges={aggregate.exchanges} />
                </section>
                <section>
                  <SectionTitle>Leaderboards</SectionTitle>
                  <Leaderboards exchanges={aggregate.exchanges} />
                </section>
              </div>
            </Collapsible>

            <Collapsible title="Tools & Narrative" summary="AI summary, arbitrage, alerts">
              <div className="flex flex-col gap-4">
                <AiSummary aggregate={aggregate} />
                <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <ArbitrageScanner exchanges={aggregate.exchanges} />
                  <AlertsPanel aggregate={aggregate} />
                </section>
              </div>
            </Collapsible>

            <footer className="border-t border-hairline pt-6 text-[11px] leading-relaxed text-ink-faint">
              <p className="font-medium text-ink-muted">This is a market data tool, not financial advice.</p>
              <p className="mt-1 max-w-3xl">
                Every number here is fetched live from the exchange that publishes it. Where a venue
                doesn&apos;t publish a metric, it shows as &ldquo;—&rdquo; rather than an estimate. Funding
                and open interest describe how traders are positioned; they don&apos;t predict direction.
                Crowded positioning can stay crowded far longer than it looks sustainable. Verify anything
                you act on against the exchange&apos;s own interface before trading.
              </p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{children}</h2>
  );
}
