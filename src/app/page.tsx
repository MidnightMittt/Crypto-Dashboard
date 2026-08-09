"use client";

import { AlertTriangle } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { AiMarketSummary } from "@/components/dashboard/AiMarketSummary";
import { AssetCompositeSection } from "@/components/dashboard/AssetCompositeSection";
import { EntryQualityCard } from "@/components/dashboard/EntryQualityCard";
import { CategoryCard } from "@/components/dashboard/CategoryCard";
import { LiquidityMapCard } from "@/components/dashboard/LiquidityMapCard";
import { SignalBreakdown } from "@/components/dashboard/SignalBreakdown";
import { ExchangeGrid } from "@/components/dashboard/ExchangeGrid";
import { HeatMap } from "@/components/dashboard/HeatMap";
import { Leaderboards } from "@/components/dashboard/Leaderboards";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { AiSummary } from "@/components/dashboard/AiSummary";
import { SimilarSetupsPanel } from "@/components/dashboard/SimilarSetupsPanel";
import { ArbitrageScanner } from "@/components/dashboard/ArbitrageScanner";
import { PoolExposure } from "@/components/dashboard/PoolExposure";
import { PositioningIntelligence } from "@/components/dashboard/PositioningIntelligence";
import { LiquidationIntelligence } from "@/components/dashboard/LiquidationIntelligence";
import { OrderFlowIntelligence } from "@/components/dashboard/OrderFlowIntelligence";
import { ExchangeFlowIntelligence } from "@/components/dashboard/ExchangeFlowIntelligence";
import { DeribitOptionsIntelligence } from "@/components/dashboard/DeribitOptionsIntelligence";
import { DominanceRotation, StablecoinSupply } from "@/components/dashboard/MarketBreadth";
import { CorrelationHeatmap } from "@/components/dashboard/CorrelationHeatmap";
import { NetworkHealth } from "@/components/dashboard/NetworkHealth";
import { MacroCard } from "@/components/dashboard/MacroCard";
import { DashboardSkeleton, LowerSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { Collapsible } from "@/components/ui/Collapsible";
import { Button } from "@/components/ui/Button";
import { useMarketData } from "@/lib/hooks/useMarketData";
import { useAssetComposites } from "@/lib/hooks/useAssetComposites";
import { useDashboardStore } from "@/lib/store/dashboardStore";
import { getExchange } from "@/lib/exchanges/registry";
import { regimeTagsToStrings } from "@/lib/technicals/regimes";
import { Category } from "@/lib/signals/types";

/**
 * Dashboard V2's reading order: Leading Drivers -> Market Structure ->
 * Positioning -> Risk Monitor, the user's own explicit "macro backdrop
 * downstream to structure, then positioning, then risk" narrative order —
 * deliberately NOT the same as CATEGORY_ORDER in categories.ts (weight-
 * heaviest first), which drives scoring/renormalization, not page layout.
 */
const CATEGORY_DISPLAY_ORDER: Category[] = ["leadingDrivers", "marketStructure", "positioning", "risk"];

export default function DashboardPage() {
  const asset = useDashboardStore((s) => s.asset);
  const { data, isLoading, isError, refetch } = useMarketData(asset);
  const { data: assetComposites } = useAssetComposites();

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

  const categoriesByName = new Map(
    (aggregate?.marketBias?.categories ?? []).map((c) => [c.category, c] as const)
  );

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
              ── EXECUTIVE SUMMARY ─────────────────────────────────────────
              The single answer to "what's the highest-probability direction
              right now, and why, and what would change that" — thesis,
              confidence, top reasons, technical confirmation, biggest
              opportunity/risk, invalidation, and (expandable) today's
              trajectory. Everything below either feeds this or audits it.
            */}
            <AiMarketSummary
              bias={aggregate.marketBias}
              thesis={aggregate.marketThesis}
              technicals={aggregate.technicals}
              technicals4h={aggregate.technicals4h}
              timeline={aggregate.biasTimeline}
            />

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <EntryQualityCard aggregate={aggregate} />
              </div>
              <AssetCompositeSection data={assetComposites} />
            </section>

            {/*
              ── LEADING DRIVERS / MARKET STRUCTURE / POSITIONING / RISK ────
              The four scored categories, one card per trading question —
              Dashboard V2's "one card = one decision" rule. Same underlying
              18 metrics `evaluateAll()` already produces; nothing new is
              fetched here. Each card's "Detail" expandable absorbs the raw
              Intelligence components that used to render as their own
              always-visible cards or collapsibles.
            */}
            {aggregate.marketBias && aggregate.marketBias.categories.length > 0 && (
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {CATEGORY_DISPLAY_ORDER.map((catName) => {
                  const category = categoriesByName.get(catName);
                  if (!category) return null;
                  return (
                    <CategoryCard
                      key={catName}
                      category={category}
                      currentRegimeTags={currentRegimeTags}
                      rawDetail={rawDetailFor(catName, aggregate, data)}
                      rawDetailSummary={RAW_DETAIL_SUMMARY[catName]}
                    />
                  );
                })}
              </section>
            )}

            {/*
              ── THE AUDIT TRAIL ───────────────────────────────────────────
              Every metric in one uniform shape, so the summary and category
              cards above are auditable rather than taken on trust. Collapsed
              by default — this is raw-data depth, not the default reading
              surface.
            */}
            <Collapsible
              title="All Signals"
              summary={`${aggregate.marketBias?.metrics.length ?? 0} metrics`}
            >
              <SignalBreakdown metrics={aggregate.marketBias?.metrics ?? []} currentRegimeTags={currentRegimeTags} />
            </Collapsible>

            <Collapsible title="Research" summary="historical analog, freeform AI narrative">
              <div className="flex flex-col gap-4">
                <SimilarSetupsPanel aggregate={aggregate} />
                <AiSummary aggregate={aggregate} />
              </div>
            </Collapsible>

            <Collapsible
              title="Raw Venue Data"
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

            <Collapsible title="Tools" summary="arbitrage scanner, alerts">
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ArbitrageScanner exchanges={aggregate.exchanges} />
                <AlertsPanel aggregate={aggregate} />
              </section>
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

const RAW_DETAIL_SUMMARY: Record<Category, string> = {
  positioning: "squeeze, funding percentile, liquidations, liquidity map, pool exposure",
  marketStructure: "order flow, dominance/altseason rotation, correlation",
  leadingDrivers: "macro (TradFi), on-chain network health, stablecoin supply",
  risk: "exchange netflow, options positioning",
};

/**
 * The relocated Intelligence/detail components each CategoryCard's "Detail"
 * expandable absorbs — grouped by which trading question they support, per
 * the Dashboard V2 IA redesign's audit. Nothing here recomputes anything;
 * every component keeps reading the exact same `aggregate`/`data` it always
 * has, just rendered inside a different expandable location.
 */
function rawDetailFor(
  category: Category,
  aggregate: NonNullable<ReturnType<typeof useMarketData>["data"]>["aggregate"],
  data: ReturnType<typeof useMarketData>["data"]
) {
  switch (category) {
    case "positioning":
      return (
        <div className="flex flex-col gap-4">
          <PositioningIntelligence data={aggregate} />
          <LiquidationIntelligence data={aggregate} />
          <LiquidityMapCard
            liquidityMap={aggregate.liquidityMap}
            orderFlow={aggregate.orderFlow}
            liquidationsMetric={aggregate.marketBias?.metrics.find((m) => m.id === "liquidations") ?? null}
          />
          <PoolExposure data={aggregate} />
        </div>
      );
    case "marketStructure":
      return (
        <div className="flex flex-col gap-4">
          <OrderFlowIntelligence data={aggregate} />
          <DominanceRotation globalMarket={data?.globalMarket ?? null} />
          <CorrelationHeatmap correlation={data?.correlation ?? null} />
        </div>
      );
    case "leadingDrivers":
      return (
        <div className="flex flex-col gap-4">
          <MacroCard macro={data?.macro} />
          <NetworkHealth data={data?.networkHealth} stablecoins={data?.stablecoins ?? null} />
          <StablecoinSupply stablecoins={data?.stablecoins ?? null} />
        </div>
      );
    case "risk":
      return (
        <div className="flex flex-col gap-4">
          <ExchangeFlowIntelligence data={aggregate} />
          <DeribitOptionsIntelligence data={aggregate} />
        </div>
      );
    default:
      return null;
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{children}</h2>
  );
}
