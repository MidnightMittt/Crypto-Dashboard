"use client";

import Link from "next/link";
import { Activity } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { ALL_ASSETS } from "@/lib/exchanges/registry";
import { useDashboardStore } from "@/lib/store/dashboardStore";
import { AssetSymbol } from "@/types/market";
import { timeAgo } from "@/lib/utils/format";

export function Header({ venueCount, updatedAt }: { venueCount?: number; updatedAt?: number }) {
  const { asset, setAsset } = useDashboardStore();

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-void/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan/10 ring-1 ring-cyan/30">
            <Activity className="h-4 w-4 text-cyan" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-ink">Leverage Terminal</h1>
            <p className="text-[11px] uppercase tracking-[0.15em] text-ink-faint">
              Perp funding · open interest · positioning
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/options"
            className="hidden text-[11px] uppercase tracking-widest text-ink-faint transition-colors hover:text-ink sm:inline"
          >
            Options →
          </Link>
          {updatedAt && (
            <span className="hidden text-[11px] text-ink-faint sm:inline">
              Updated {timeAgo(updatedAt)}
            </span>
          )}
          <Badge variant="cyan">
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-cyan animate-pulse-dot" />
            {venueCount !== undefined ? `${venueCount} live venues` : "Live"}
          </Badge>

          <Select value={asset} onValueChange={(v) => setAsset(v as AssetSymbol | "MARKET")}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MARKET">Entire market</SelectItem>
              {ALL_ASSETS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </header>
  );
}
