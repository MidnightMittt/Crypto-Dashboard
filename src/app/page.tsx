"use client";

import dynamic from "next/dynamic";
import { AlertTriangle } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { SentimentIndex } from "@/components/dashboard/SentimentIndex";
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
import { DashboardSkeleton, LowerSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { useMarketData } from "@/lib/hooks/useMarketData";
import { useDashboardStore } from "@/lib/store/dashboardStore";
import { getExchange } from "@/lib/exchanges/registry";

/**
 * lightweight-charts is ~45kB and can't render server-side (it measures the
 * DOM on construction). Loading it separately keeps it off the critical path
 * for the gauges and cards, which are what the page is judged on first.
 */
const HistoricalChart = dynamic(
  () => import("@/components/dashboard/HistoricalChart").then((m) => m.HistoricalChart),
  { ssr: false, loading: () => <Skeleton className="h-[420px] w-full" /> }
);

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
            {/*
              While the exchanges are still answering, only the panels that
              genuinely need them are skeletons. The chart below is already
              live — it reads recorded history from its own endpoint, which
              resolves in milliseconds rather than waiting on 13 venues.
            */}
            <DashboardSkeleton />
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <HistoricalChart asset={asset} />
              </div>
              <Skeleton className="h-[420px] w-full" />
            </section>
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

            <SentimentIndex data={aggregate} fearGreed={data?.fearGreed} />

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <FundingGauge data={aggregate} />
              <OpenInterestGauge data={aggregate} />
              <LeverageHeatGauge data={aggregate} />
              <LongShortGauge data={aggregate} />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <HistoricalChart asset={asset} data={aggregate} />
              </div>
              <AiSummary aggregate={aggregate} />
            </section>

            <section>
              <SectionTitle>Exchange Breakdown</SectionTitle>
              <ExchangeGrid exchanges={aggregate.exchanges} />
            </section>

            <section>
              <SectionTitle>Cross-Market Funding</SectionTitle>
              <HeatMap exchanges={aggregate.exchanges} />
            </section>

            <section>
              <SectionTitle>Leaderboards</SectionTitle>
              <Leaderboards exchanges={aggregate.exchanges} />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ArbitrageScanner exchanges={aggregate.exchanges} />
              </div>
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
