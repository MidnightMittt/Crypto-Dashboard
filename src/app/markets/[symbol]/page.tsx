import { notFound } from "next/navigation";
import { AssetReport, AssetReportData } from "@/components/asset/AssetReport";
import { MarketBias } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal } from "@/lib/signals/tradePlan";
import { EarningsVetoResult } from "@/lib/markets/earningsVeto";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import snapshot from "@/data/equityMarkets.json";

/**
 * MARKET DETAIL — an index ETF, from the committed daily snapshot.
 *
 * The whole page is `AssetReport`, the same component a searched ticker
 * renders. This file's only job is to hand it validated, precomputed data
 * instead of a live fetch. That split is deliberate: the layout, the reading
 * order and every word on it are shared, so the two paths cannot drift into
 * two different products, while the DATA path stays honest about its
 * provenance — these bars were validated by the ingest pipeline and refreshed
 * on a schedule, which a request-time fetch cannot claim.
 */

interface MarketDecision {
  symbol: string;
  name: string;
  bias: MarketBias;
  lastClose: number;
  change24hPct: number;
  asOf: number;
  plan: TradePlan | null;
  planRefusal: TradePlanRefusal | null;
  earnings: EarningsVetoResult | null;
  zones: SupportResistanceZone[];
  atrPct: number | null;
}

const data = snapshot as unknown as { generatedAt: number; decisions: MarketDecision[] };

export function generateStaticParams() {
  return data.decisions.map((d) => ({ symbol: d.symbol.toLowerCase() }));
}

export default async function MarketDetailPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const decision = data.decisions.find((d) => d.symbol.toLowerCase() === symbol.toLowerCase());

  // An unknown ticker 404s rather than falling back to SPY — showing a
  // different market than the URL names would undermine every number on it.
  if (!decision) notFound();

  const report: AssetReportData = {
    symbol: decision.symbol,
    name: decision.name,
    lastClose: decision.lastClose,
    change24hPct: decision.change24hPct,
    asOf: decision.asOf,
    bias: decision.bias,
    plan: decision.plan,
    planRefusal: decision.planRefusal,
    earnings: decision.earnings,
    zones: decision.zones,
    atrPct: decision.atrPct,
  };

  return (
    <AssetReport
      data={report}
      backHref="/markets"
      backLabel="← All markets"
      footnote={`Daily closes through ${new Date(decision.asOf).toISOString().slice(0, 10)}. Not financial advice.`}
    />
  );
}
