"use client";

import { useEffect } from "react";
import { notFound, useParams } from "next/navigation";
import DashboardPage from "@/app/page";
import { useDashboardStore } from "@/lib/store/dashboardStore";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { AssetSymbol } from "@/types/market";

/**
 * PER-ASSET ROUTE — /asset/btc, /asset/eth, ...
 *
 * Deliberately NOT a second dashboard. The decision surface is one component
 * driven by one piece of state (`dashboardStore.asset`); this route's entire
 * job is to make the URL the source of truth for that state, so an asset
 * becomes something you can link to, bookmark and share rather than a
 * dropdown selection that vanishes on refresh.
 *
 * Building a parallel page here would have meant two renderings of the same
 * decision, which is the exact duplication the charter's "one market, one
 * truth" forbids — and which this codebase has already had to unwind once.
 */
export default function AssetPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = (params?.symbol ?? "").toUpperCase() as AssetSymbol;
  const setAsset = useDashboardStore((s) => s.setAsset);

  const supported = ALL_ASSETS.includes(symbol);

  useEffect(() => {
    if (supported) setAsset(symbol);
  }, [supported, symbol, setAsset]);

  // An unsupported ticker is a 404, not a silent fallback to BTC. Quietly
  // showing a different asset than the URL names is the kind of thing that
  // makes a user distrust every other number on the page.
  if (!supported) notFound();

  return <DashboardPage />;
}
