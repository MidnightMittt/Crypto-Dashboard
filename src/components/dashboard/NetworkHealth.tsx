"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatCompactUsd } from "@/lib/utils/format";
import { NetworkHealthPayload } from "@/lib/hooks/useMarketData";

/**
 * Raw blockchain network state — hash rate, gas, TPS, DeFi TVL by chain.
 * Deliberately informational, not a sentiment signal: a busy mempool or
 * high gas price isn't bullish or bearish, it's just network congestion,
 * so unlike most of this dashboard, nothing here gets a lean/gauge.
 *
 * Each of the 4 sources reuses infrastructure already configured
 * elsewhere in this app (mempool.space already used by Exchange Flow's
 * BTC fallback, Etherscan already used for ETH balances, Solana RPC
 * already used for Drift, DefiLlama already used for stablecoin supply)
 * — no new keys or signups needed for any of it.
 */
export function NetworkHealth({ data }: { data: NetworkHealthPayload | undefined }) {
  if (!data || (!data.bitcoin && !data.ethereum && !data.solana && !data.chainTvl)) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Network Health</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {data.bitcoin && (
          <div className="grid grid-cols-3 gap-3">
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
      <div className="text-[10px] uppercase tracking-widest text-ink-faint">{label}</div>
    </div>
  );
}
