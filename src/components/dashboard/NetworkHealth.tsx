"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { formatCompactUsd } from "@/lib/utils/format";
import { NetworkHealthPayload } from "@/lib/hooks/useMarketData";
import { StablecoinSummary } from "@/lib/providers/stablecoins";

/**
 * Raw blockchain network state — hash rate, gas, TPS, DeFi TVL by chain,
 * stablecoin supply. Deliberately informational, not a sentiment signal: a
 * busy mempool or high gas price isn't bullish or bearish, it's just network
 * congestion, so unlike most of this dashboard, nothing here gets a
 * lean/gauge or a `Category` (see Part 1c of the taxonomy redesign — this is
 * the one section deliberately excluded from `bias.score`).
 *
 * Stablecoin supply is folded in here as DISPLAY ONLY — the same
 * `StablecoinSummary` the `stablecoins` metric already scores under Spot
 * Demand, shown a second time in its raw on-chain-supply form rather than as
 * a directional read, so it doesn't disagree with itself across two cards.
 *
 * Each of the other 4 sources reuses infrastructure already configured
 * elsewhere in this app (mempool.space already used by Exchange Flow's
 * BTC fallback, Etherscan already used for ETH balances, Solana RPC
 * already used for Drift, DefiLlama already used for stablecoin supply)
 * — no new keys or signups needed for any of it.
 */
export function NetworkHealth({
  data,
  stablecoins,
}: {
  data: NetworkHealthPayload | undefined;
  stablecoins?: StablecoinSummary | null;
}) {
  if (!data || (!data.bitcoin && !data.ethereum && !data.solana && !data.chainTvl && !stablecoins)) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>Network Health</CardTitle>
          <InfoTooltip
            measures="Raw blockchain and stablecoin state: hash rate, gas, transaction throughput, DeFi TVL, and stablecoin supply."
            whyItMatters="A simple assessment of on-chain strength — context for the rest of the read, not a bullish/bearish signal of its own."
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {stablecoins && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Stablecoin supply" value={formatCompactUsd(stablecoins.totalMcapUsd)} />
            <Stat
              label="24h change"
              value={`${stablecoins.netChange24hPct >= 0 ? "+" : ""}${stablecoins.netChange24hPct.toFixed(2)}%`}
            />
            <Stat
              label="7d change"
              value={`${stablecoins.netChange7dPct >= 0 ? "+" : ""}${stablecoins.netChange7dPct.toFixed(2)}%`}
            />
          </div>
        )}
        {data.bitcoin && (
          <div className={`grid grid-cols-3 gap-3 ${stablecoins ? "border-t border-hairline pt-3" : ""}`}>
            <Stat label="BTC hash rate" value={`${data.bitcoin.hashrateEhs.toFixed(0)} EH/s`} />
            <Stat label="BTC fastest fee" value={`${data.bitcoin.fastestFeeSatVb} sat/vB`} />
            <Stat label="BTC mempool" value={data.bitcoin.mempoolCount.toLocaleString()} />
          </div>
        )}
        {data.ethereum && (
          <div className="grid grid-cols-3 gap-3 border-t border-hairline pt-3">
            <Stat label="ETH safe gas" value={`${data.ethereum.safeGwei.toFixed(2)} gwei`} />
            <Stat label="ETH propose gas" value={`${data.ethereum.proposeGwei.toFixed(2)} gwei`} />
            <Stat label="ETH fast gas" value={`${data.ethereum.fastGwei.toFixed(2)} gwei`} />
          </div>
        )}
        {data.solana && (
          <div className="grid grid-cols-2 gap-3 border-t border-hairline pt-3">
            <Stat label="SOL TPS" value={data.solana.tps.toFixed(0)} />
            <Stat
              label={`Epoch ${data.solana.epoch}`}
              value={`${data.solana.epochProgressPct.toFixed(1)}%`}
            />
          </div>
        )}
        {data.chainTvl && (
          <div className="border-t border-hairline pt-3">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted">
              DeFi TVL by chain
            </span>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              {data.chainTvl.top.map((c) => (
                <span key={c.chain} className="flex justify-between text-ink-faint">
                  <span>{c.chain}</span>
                  <span className="font-mono text-ink">{formatCompactUsd(c.tvlUsd)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-sm text-ink">{value}</div>
      <div className="text-[11px] uppercase tracking-widest text-ink-faint">{label}</div>
    </div>
  );
}
