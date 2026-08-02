"use client";

import { AlertTriangle } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { SentimentIndex } from "@/components/dashboard/SentimentIndex";
import { MarketBiasCard } from "@/components/dashboard/MarketBiasCard";
import { SignalBreakdown } from "@/components/dashboard/SignalBreakdown";
import { MarketThesisBriefing } from "@/components/dashboard/MarketThesisBriefing";
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

export default function DashboardPage() {
  const asset = useDashboardStore((s) => s.asset);
  const { data, isLoading, isError, refetch } = useMarketData(asset);

  const aggregate = data?.aggregate;

  // `ready` gates only the panels that need exchange data. The chart is
  // rendered in both branches because it sources its series independently.
  const ready = !isLoading && !!aggregate && aggregate.exchanges.length > 0;
  const noData = !isLoading && !!aggregate && aggregate.exchanges.length === 0;

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
              The headline answer, above everything else: what is the market
              likely to do next, and why. Every card below is one input into
              this single read.
            */}
            <MarketBiasCard bias={aggregate.marketBias} />

            <SignalBreakdown metrics={aggregate.marketBias?.metrics ?? []} />

            <SentimentIndex data={aggregate} fearGreed={data?.fearGreed} />

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <FundingGauge data={aggregate} />
              <OpenInterestGauge data={aggregate} />
              <LeverageHeatGauge data={aggregate} />
              <LongShortGauge data={aggregate} />
            </section>

            {/*
              The flagship read: every other card on this page is one
              indicator; this is all of them read together. Sits right
              after the individual speedometers, since it draws on their
              readings directly.
            */}
            <MarketThesisBriefing thesis={aggregate.marketThesis} />

            <PositioningIntelligence data={aggregate} />

            {/*
              Where the Price × Funding chart used to sit — replaced rather
              than reused, at the user's request. Paired here because both
              cards are BTC/ETH-only signals that live outside perpetual
              futures entirely: wallet flow and options-market structure,
              neither derived from funding/OI/positioning like everything
              else on this page.
            */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ExchangeFlowIntelligence data={aggregate} />
              <DeribitOptionsIntelligence data={aggregate} />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <AiSummary aggregate={aggregate} />
              </div>
              {/*
                Backward-looking companion to the squeeze-setup badge in
                PositioningIntelligence above: that one asks what's primed to
                unwind next, this one shows what already got forced out.
              */}
              <LiquidationIntelligence data={aggregate} />
            </section>

            {/*
              Pool exposure and order flow sit here, right alongside the
              other positioning/flow intelligence cards, rather than lower
              down paired with the arbitrage/alerts tools they have no
              thematic connection to.
            */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <PoolExposure data={aggregate} />
              <OrderFlowIntelligence data={aggregate} />
            </section>

            {/*
              Market-wide context, same for every asset tab — doesn't belong
              on any per-asset card. Sits here because it's the same kind of
              "step back and look at the bigger picture" read as the
              intelligence cards above it.
            */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <MarketBreadth stablecoins={data?.stablecoins ?? null} globalMarket={data?.globalMarket ?? null} />
              <CorrelationHeatmap correlation={data?.correlation ?? null} />
            </section>

            {/*
              Raw chain state (hash rate, gas, TPS, TVL) — informational,
              not a sentiment signal, so it gets its own row rather than
              being squeezed alongside the analysis cards above.
            */}
            <NetworkHealth data={data?.networkHealth} />

            {/*
              Collapsed by default. At 24 venues this block ran ~1,400px —
              a third of the page — and the heat map below already shows the
              cross-venue funding picture without it.
            */}
            <Collapsible
              title="Exchange Breakdown"
              summary={`${venueCount ?? aggregate.exchanges.length} venues`}
            >
              <ExchangeGrid exchanges={aggregate.exchanges} />
            </Collapsible>

            <section>
              <SectionTitle>Cross-Market Funding</SectionTitle>
              <HeatMap exchanges={aggregate.exchanges} />
            </section>

            <section>
              <SectionTitle>Leaderboards</SectionTitle>
              <Leaderboards exchanges={aggregate.exchanges} />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ArbitrageScanner exchanges={aggregate.exchanges} />
              <AlertsPanel aggregate={aggregate} />
            </section>

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
