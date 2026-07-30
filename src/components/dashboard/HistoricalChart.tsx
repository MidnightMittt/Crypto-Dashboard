"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, LineStyle } from "lightweight-charts";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { AggregateMarketData, AssetSymbol, ExchangeSnapshot, Timeframe } from "@/types/market";
import { useHistory } from "@/lib/hooks/useHistory";
import { fundingPer8h } from "@/lib/utils/format";
import { Badge } from "@/components/ui/Badge";
import { classifyChartLean, ChartLeanResult } from "@/lib/sentiment/chartLean";

const TIMEFRAMES: Timeframe[] = ["15m", "1H", "4H", "12H", "1D", "1W"];
type Overlay = "funding" | "oi";

/**
 * Merge every venue's history into hourly buckets on a real timestamp axis.
 *
 * Venues publish history at different cadences and some publish none at all,
 * so we bucket by hour and average what exists rather than assuming the
 * series line up index-for-index.
 */
const BUCKET_MS = 5 * 60 * 1000;

function buildAggregateSeries(exchanges: ExchangeSnapshot[]) {
  const buckets = new Map<
    number,
    { priceSum: number; priceW: number; fundingSum: number; fundingW: number; oi: number }
  >();

  exchanges.forEach((e) => {
    e.fundingHistory.forEach((p) => {
      // Bucket at 5 minutes to match how often history is recorded.
      // Hour buckets collapsed twelve points into one, so the chart needed
      // 3+ hours of uninterrupted uptime before it could draw anything.
      const bucket = Math.floor(p.t / BUCKET_MS);
      const b =
        buckets.get(bucket) ?? { priceSum: 0, priceW: 0, fundingSum: 0, fundingW: 0, oi: 0 };
      const w = e.openInterestUsd || 1;
      if (p.price !== undefined) {
        b.priceSum += p.price * w;
        b.priceW += w;
      }
      if (p.fundingRatePct !== undefined) {
        // Normalized to an 8h-equivalent BEFORE blending across venues — the
        // same rule every other cross-venue funding average in this app
        // follows (see aggregator.ts). Only Binance and Bybit currently
        // populate real fundingRatePct history, and both settle 8-hourly, so
        // this doesn't change today's chart — but an hourly venue's raw rate
        // is 1/8th its true per-8h cost, and skipping this here (unlike
        // everywhere else funding gets combined) would silently understate
        // it the moment one starts publishing history.
        const per8h = fundingPer8h(p.fundingRatePct, e.fundingIntervalHours);
        b.fundingSum += per8h * w;
        b.fundingW += w;
      }
      if (p.openInterestUsd !== undefined) b.oi += p.openInterestUsd;
      buckets.set(bucket, b);
    });
  });

  // Fall back to current mark price when no venue publishes price history,
  // so the price line still has a reference level.
  const currentPrice =
    exchanges.reduce((s, e) => s + e.price * e.openInterestUsd, 0) /
    Math.max(exchanges.reduce((s, e) => s + e.openInterestUsd, 0), 1);

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, b]) => ({
      t: bucket * BUCKET_MS,
      price: b.priceW > 0 ? b.priceSum / b.priceW : currentPrice,
      funding: b.fundingW > 0 ? b.fundingSum / b.fundingW : null,
      oi: b.oi > 0 ? b.oi : null,
    }));
}

/** Stable identity so the series useMemo isn't invalidated every render. */
const EMPTY_HISTORY: AggregateMarketData["history"] = [];

const TF_TRAILING_POINTS: Record<Timeframe, number> = {
  "15m": 12,
  "1H": 24,
  "4H": 48,
  "12H": 72,
  "1D": 91,
  "1W": 91,
};

/**
 * How much net price movement counts as a real direction versus noise, per
 * timeframe. "Flat" means something different on a 15m chart than a 1W one,
 * so a single fixed percentage across every timeframe would either fire on
 * routine 15m noise or almost never fire on 1W.
 *
 * These are a reasonable starting point tuned to typical BTC/ETH/SOL
 * volatility at each horizon, not a backtested constant — matching the same
 * "defensible starting point, not settled science" framing already applied
 * to the composite sentiment weights in compositeIndex.ts.
 */
const FLAT_THRESHOLD_PCT: Record<Timeframe, number> = {
  "15m": 0.1,
  "1H": 0.2,
  "4H": 0.4,
  "12H": 0.6,
  "1D": 1,
  "1W": 2,
};

/**
 * `data` is optional on purpose: the chart mounts and draws before the main
 * market payload exists. Recorded history arrives from its own fast endpoint
 * in milliseconds, so the chart is useful immediately and simply upgrades to
 * deeper exchange-published history once the exchanges answer.
 */
export function HistoricalChart({
  asset,
  data,
}: {
  asset: AssetSymbol | "MARKET";
  data?: AggregateMarketData;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [overlay, setOverlay] = useState<Overlay>("funding");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const overlaySeriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  const { data: recorded } = useHistory(asset);

  const exchanges = useMemo(() => data?.exchanges ?? [], [data]);

  // Recorded history comes from the fast endpoint; fall back to whatever the
  // main payload carried if that request hasn't landed yet.
  const localHistory = recorded?.history ?? data?.history ?? EMPTY_HISTORY;
  const historyHours = recorded?.historyHours ?? data?.historyHours ?? 0;

  // Prefer exchange-published history (deeper, predates this app). Fall back
  // to what we've recorded locally when no venue supplies any.
  const series = useMemo(() => {
    const fromExchanges = buildAggregateSeries(exchanges);
    if (fromExchanges.length >= 2) return { points: fromExchanges, source: "exchange" as const };
    const local = localHistory.map((p) => ({
      t: p.t,
      price: p.price,
      funding: p.weightedFundingRatePct,
      oi: p.totalOpenInterestUsd,
    }));
    return { points: local, source: "local" as const };
  }, [exchanges, localHistory]);

  const points = series.points;

  /*
   * Computed over the same trailing window the chart actually draws for the
   * current timeframe, using price + FUNDING specifically — regardless of
   * which overlay (funding or OI) is currently toggled on screen. The lean
   * answers "is this move backed by leverage", which is a funding question
   * by definition; showing it while OI is the active overlay is still
   * correct, just independent of what's currently drawn.
   */
  const lean = useMemo(() => {
    const trailing = points.slice(-TF_TRAILING_POINTS[timeframe]);
    return classifyChartLean(trailing, FLAT_THRESHOLD_PCT[timeframe]);
  }, [points, timeframe]);

  // init chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8890A0" },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      leftPriceScale: { visible: true, borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
      crosshair: { vertLine: { color: "#2DD4E8", style: LineStyle.Dashed }, horzLine: { color: "#2DD4E8", style: LineStyle.Dashed } },
      height: 320,
      autoSize: true,
    });

    const priceSeries = chart.addLineSeries({
      color: "#2DD4E8",
      lineWidth: 2,
      priceScaleId: "right",
      title: "Price",
    });

    const overlaySeries = chart.addAreaSeries({
      priceScaleId: "left",
      lineColor: "#F5A623",
      topColor: "rgba(245,166,35,0.25)",
      bottomColor: "rgba(245,166,35,0.02)",
      lineWidth: 2,
      title: "Funding",
    });

    chartRef.current = chart;
    priceSeriesRef.current = priceSeries;
    overlaySeriesRef.current = overlaySeries;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // update data on series/timeframe/overlay change
  useEffect(() => {
    if (!priceSeriesRef.current || !overlaySeriesRef.current) return;
    const trailing = points.slice(-TF_TRAILING_POINTS[timeframe]);
    priceSeriesRef.current.setData(
      trailing.map((p) => ({ time: Math.floor(p.t / 1000) as never, value: p.price }))
    );
    overlaySeriesRef.current.applyOptions({ title: overlay === "funding" ? "Funding %" : "Open Interest" });
    overlaySeriesRef.current.setData(
      trailing
        .map((p) => ({
          time: Math.floor(p.t / 1000) as never,
          value: overlay === "funding" ? p.funding : p.oi,
        }))
        .filter((p): p is { time: never; value: number } => p.value !== null)
    );
    chartRef.current?.timeScale().fitContent();
  }, [points, timeframe, overlay]);

  return (
    <Card>
      <CardHeader className="flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Price × {overlay === "funding" ? "Funding" : "Open Interest"}</CardTitle>
          {lean && <LeanBadge lean={lean.lean} />}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={overlay} onValueChange={(v) => setOverlay(v as Overlay)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="funding">Overlay: Funding</SelectItem>
              <SelectItem value="oi">Overlay: Open Interest</SelectItem>
            </SelectContent>
          </Select>
          <Tabs value={timeframe} onValueChange={(v) => setTimeframe(v as Timeframe)}>
            <TabsList>
              {TIMEFRAMES.map((tf) => (
                <TabsTrigger key={tf} value={tf}>
                  {tf}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <div className="relative px-2 pb-2 pt-3">
        <div ref={containerRef} className="h-[320px] w-full" />
        {points.length < 2 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-ink-muted">
              Collecting history — {points.length} of 2 points needed
            </p>
            <p className="max-w-md text-xs leading-relaxed text-ink-faint">
              None of the reachable venues publish a funding-history endpoint, so this chart is built from
              this app&apos;s own recorded snapshots. One is taken every 5 minutes, so the chart begins
              drawing about 10 minutes after first launch and fills in from there.
            </p>
            <p className="max-w-md text-xs leading-relaxed text-ink-faint">
              Recorded history lives in <code className="text-cyan">.data/</code> and survives restarts —
              but only if you keep that folder when replacing the project.
            </p>
          </div>
        )}
      </div>
      {lean && (
        <p className="px-4 pb-1 text-[11px] leading-relaxed text-ink-muted">{narrateLean(lean)}</p>
      )}
      <p className="px-4 pb-4 text-[11px] text-ink-faint">
        {series.source === "exchange"
          ? "History published by Binance, Bybit, and OKX (about 7 days hourly). Venues without history endpoints contribute only their current values."
          : `Built from this app's own recorded snapshots — ${historyHours.toFixed(1)}h collected so far. Recorded every 5 minutes while the server runs.`}
      </p>
    </Card>
  );
}

function LeanBadge({ lean }: { lean: ChartLeanResult["lean"] }) {
  const variant =
    lean === "bullish" ? "success" : lean === "bearish" ? "danger" : lean === "coiling" ? "amber" : "neutral";
  const label = lean === "coiling" ? "Coiling" : lean.charAt(0).toUpperCase() + lean.slice(1);
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * Wording for all nine (price direction × funding sign) combinations the
 * classifier can produce, collapsed through the four lean buckets. Kept
 * component-local rather than in chartLean.ts, matching how every other
 * panel this session (Liquidation/OrderFlow/Positioning Intelligence) keeps
 * its testable math and its prose in separate places.
 */
function narrateLean(lean: ChartLeanResult): string {
  const { lean: bucket, fundingSign } = lean;

  if (bucket === "neutral") {
    return "No clear lean — price and funding are both quiet over this window.";
  }

  if (bucket === "coiling") {
    const side = fundingSign === "positive" ? "longs" : "shorts";
    return `Price is flat while ${side} keep paying up — leverage is building without resolution. This says a move may be coming, not which way.`;
  }

  if (bucket === "bullish") {
    if (fundingSign === "positive") {
      return "Price rising with longs paying up — a leverage-confirmed move.";
    }
    if (fundingSign === "negative") {
      return "Price rising while shorts still pay — a short squeeze in progress, with room to keep forcing shorts out if it continues.";
    }
    return "Price rising with no funding skew — a move without leveraged fuel behind it, often the more durable kind.";
  }

  // bearish
  if (fundingSign === "negative") {
    return "Price falling with shorts paying up — a leverage-confirmed move down.";
  }
  if (fundingSign === "positive") {
    return "Price falling while longs still pay up — they haven't been forced out yet. Continuation or a sharp flush are both live risks.";
  }
  return "Price falling with no funding skew — a move without a crowded side being punished.";
}
