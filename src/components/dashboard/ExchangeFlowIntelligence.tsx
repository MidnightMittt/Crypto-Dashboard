"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatCompactUsd } from "@/lib/utils/format";
import { AggregateMarketData, ExchangeFlowSummary } from "@/types/market";

/**
 * Net movement of coins into or out of a small, hand-verified set of known
 * exchange wallets. See types/market.ts's ExchangeFlowSummary and
 * providers/exchangeFlows/addresses.ts for what's tracked and why the list
 * is short — this card is explicit on-screen about being a partial sample,
 * not a comprehensive total, so it isn't read as more authoritative than
 * it is.
 *
 * Only ever populated for BTC and ETH. Every other asset shows the "not
 * tracked" state, which is the honest answer rather than a guess.
 */
export function ExchangeFlowIntelligence({ data }: { data: AggregateMarketData }) {
  const flow = data.exchangeFlow;
  const trackable = data.asset === "BTC" || data.asset === "ETH";

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Exchange Flow</CardTitle>
        {flow && <DirectionBadge direction={flow.direction} />}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {!trackable ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Only tracked for BTC and ETH — the two chains with a free balance API and an address
            set this app could actually verify. See the composite card&apos;s methodology notes
            for why this can&apos;t extend to every asset.
          </p>
        ) : !flow ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            {!data.exchangeFlowConfigured
              ? "Needs ETHERSCAN_API_KEY (free at etherscan.io/apidashboard) to read ETH balances."
              : "Still building a day of history to compare against. This needs a prior balance snapshot before a netflow can be computed."}
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                Net flow · {flow.windowHours.toFixed(0)}h window
              </span>
              <span className="font-mono text-[11px] text-ink-faint">
                {flow.venues.join(", ")} · {flow.trackedAddressCount} address
                {flow.trackedAddressCount === 1 ? "" : "es"}
              </span>
            </div>

            <div className="flex items-baseline gap-2">
              <span
                className={
                  "font-mono text-2xl " +
                  (flow.direction === "inflow"
                    ? "text-amber"
                    : flow.direction === "outflow"
                      ? "text-success"
                      : "text-ink-muted")
                }
              >
                {flow.netflowNative >= 0 ? "+" : ""}
                {formatNative(flow.netflowNative)} {flow.asset}
              </span>
              <span className="text-xs text-ink-faint">
                ({flow.netflowUsd >= 0 ? "+" : ""}
                {formatCompactUsd(flow.netflowUsd)})
              </span>
            </div>

            <p className="text-[11px] leading-relaxed text-ink-faint">{narrate(flow)}</p>

            <p className="border-t border-hairline pt-2 text-[11px] leading-relaxed text-ink-faint">
              Partial signal — tracks {flow.trackedAddressCount} known {flow.venues.join("/")}{" "}
              wallet{flow.trackedAddressCount === 1 ? "" : "s"} only, not a comprehensive
              exchange-wide total. Read it as directional, not exhaustive.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DirectionBadge({ direction }: { direction: ExchangeFlowSummary["direction"] }) {
  if (direction === "balanced") return <Badge variant="neutral">Balanced</Badge>;
  return (
    <Badge variant={direction === "inflow" ? "amber" : "success"}>
      {direction === "inflow" ? "Inflow" : "Outflow"}
    </Badge>
  );
}

function narrate(flow: ExchangeFlowSummary): string {
  const hours = flow.windowHours.toFixed(0);
  if (flow.direction === "balanced") {
    return `Tracked balance moved less than 0.1% over the last ${hours}h — no meaningful flow either direction.`;
  }
  if (flow.direction === "inflow") {
    return `Coins moved INTO this tracked wallet over the last ${hours}h. Deposits to an exchange are historically read as latent sell pressure, though large transfers can also be internal reshuffling rather than a trader depositing to sell.`;
  }
  return `Coins moved OUT of this tracked wallet over the last ${hours}h. Withdrawals from an exchange are historically read as accumulation — moving to self-custody rather than staying available to sell.`;
}

function formatNative(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
