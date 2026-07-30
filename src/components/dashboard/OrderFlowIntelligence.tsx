"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Sparkline } from "@/components/ui/Sparkline";
import { formatCompactUsd } from "@/lib/utils/format";
import { AggregateMarketData } from "@/types/market";

/**
 * Order-book depth and aggressive taker flow, OKX only.
 *
 * Two genuinely different readings share this card, and they answer
 * different questions:
 *   - Book imbalance: resting orders right now (a snapshot of who's WAITING)
 *   - CVD trend: executed taker volume over the window (who's been ACTING)
 *
 * Neither is a position. `longShortRatio` elsewhere on this dashboard is
 * account positioning; this panel is about order flow, a different concept
 * entirely, and the two must not be read as the same thing.
 *
 * The CVD line is a genuine cumulative volume delta, built from OKX's hourly
 * pre-aggregated taker volume — not tick-level. A live order-flow terminal
 * would show structure inside each hour that this cannot see. Said plainly
 * in the panel rather than left for the reader to assume more precision
 * than exists.
 */
export function OrderFlowIntelligence({ data }: { data: AggregateMarketData }) {
  const flow = data.orderFlow;

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Order Flow</CardTitle>
        {flow && <FlowBadge dominantFlow={flow.dominantFlow} buyerSharePct={flow.buyerSharePct} />}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {!flow ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            OKX didn&apos;t respond for this asset this cycle. No key needed — this reads OKX&apos;s
            public order book and taker-volume endpoints, and fills in on its own.
          </p>
        ) : (
          <>
            {flow.bookImbalance && <BookImbalanceRow imbalance={flow.bookImbalance} />}

            <div className="border-t border-hairline pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                  Cumulative volume delta ·{" "}
                  {flow.windowHours >= 1 ? `${flow.windowHours.toFixed(0)}h window` : "building history"}
                </span>
                <span className="font-mono text-[11px] text-ink-faint">OKX only</span>
              </div>

              <CvdChart cvdHistory={flow.cvdHistory} />

              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <span className="text-ink-faint">
                  <span className="text-success">Aggressive buys</span>{" "}
                  {formatCompactUsd(flow.totalBuyUsd)}
                </span>
                <span className="text-right text-ink-faint">
                  <span className="text-danger">Aggressive sells</span>{" "}
                  {formatCompactUsd(flow.totalSellUsd)}
                </span>
              </div>
            </div>

            <p className="text-[10px] leading-relaxed text-ink-faint">{narrate(flow)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FlowBadge({
  dominantFlow,
  buyerSharePct,
}: {
  dominantFlow: NonNullable<AggregateMarketData["orderFlow"]>["dominantFlow"];
  buyerSharePct: number;
}) {
  if (dominantFlow === "balanced") return <Badge variant="neutral">Balanced</Badge>;
  const tone = dominantFlow === "buyers" ? "success" : "danger";
  const share = dominantFlow === "buyers" ? buyerSharePct : 100 - buyerSharePct;
  return (
    <Badge variant={tone}>
      {dominantFlow === "buyers" ? "Buyers" : "Sellers"} took {share.toFixed(0)}% of taker volume
    </Badge>
  );
}

function BookImbalanceRow({
  imbalance,
}: {
  imbalance: NonNullable<NonNullable<AggregateMarketData["orderFlow"]>["bookImbalance"]>;
}) {
  const { bid, ask, imbalancePct, depthLevels } = imbalance;
  const total = bid.usd + ask.usd;
  const bidSharePct = total > 0 ? (bid.usd / total) * 100 : 50;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">
          Book depth · top {depthLevels}
        </span>
        <span className="font-mono text-[11px] text-ink-faint">
          {imbalancePct >= 0 ? "+" : ""}
          {imbalancePct.toFixed(1)}%
        </span>
      </div>

      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div className="bg-success/60" style={{ width: `${bidSharePct}%` }} />
        <div className="bg-danger/60" style={{ width: `${100 - bidSharePct}%` }} />
      </div>

      <div className="mt-1 grid grid-cols-2 gap-2 text-[10px]">
        <span className="text-ink-faint">
          <span className="text-success">Bids</span> {formatCompactUsd(bid.usd)}
        </span>
        <span className="text-right text-ink-faint">
          <span className="text-danger">Asks</span> {formatCompactUsd(ask.usd)}
        </span>
      </div>
    </div>
  );
}

function CvdChart({
  cvdHistory,
}: {
  cvdHistory: NonNullable<AggregateMarketData["orderFlow"]>["cvdHistory"];
}) {
  if (cvdHistory.length < 2) {
    return (
      <div className="mt-2 flex h-10 w-full items-center justify-center rounded border border-dashed border-hairline text-[10px] text-ink-faint">
        Collecting flow history…
      </div>
    );
  }

  const values = cvdHistory.map((p) => p.cumulativeUsd);
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#22C55E" : last < first ? "#EF4444" : "#8890A0";

  return <Sparkline className="mt-2 h-10 w-full" values={values} stroke={stroke} />;
}

function narrate(flow: NonNullable<AggregateMarketData["orderFlow"]>): string {
  const total = flow.totalBuyUsd + flow.totalSellUsd;
  if (total <= 0) {
    return "No taker volume recorded on OKX over this window — thin trading.";
  }
  const flowLine =
    flow.dominantFlow === "balanced"
      ? "Aggressive buying and selling were roughly even on OKX."
      : flow.dominantFlow === "buyers"
        ? "Aggressive buyers dominated OKX's taker flow over this window."
        : "Aggressive sellers dominated OKX's taker flow over this window.";

  const bookLine = flow.bookImbalance
    ? flow.bookImbalance.imbalancePct > 15
      ? " The book also carries more resting bids than asks right now."
      : flow.bookImbalance.imbalancePct < -15
        ? " The book also carries more resting asks than bids right now."
        : ""
    : "";

  return flowLine + bookLine;
}
