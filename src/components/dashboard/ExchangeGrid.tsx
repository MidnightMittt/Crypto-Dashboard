"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ExchangeCard } from "./ExchangeCard";
import { ExchangeSnapshot } from "@/types/market";
import { getExchange } from "@/lib/exchanges/registry";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

type SortKey = "funding_desc" | "funding_asc" | "oi_desc" | "volume_desc";

const SORTS: Record<SortKey, { label: string; cmp: (a: ExchangeSnapshot, b: ExchangeSnapshot) => number }> = {
  oi_desc: { label: "Open Interest: High → Low", cmp: (a, b) => b.openInterestUsd - a.openInterestUsd },
  funding_desc: { label: "Funding: High → Low", cmp: (a, b) => b.fundingRatePct - a.fundingRatePct },
  funding_asc: { label: "Funding: Low → High", cmp: (a, b) => a.fundingRatePct - b.fundingRatePct },
  volume_desc: { label: "Volume: High → Low", cmp: (a, b) => b.volume24hUsd - a.volume24hUsd },
};

/**
 * In whole-market mode the aggregator returns one snapshot per exchange PER
 * ASSET, which would render the same venue a dozen times. Collapse those into
 * one card per exchange: sum the size-like fields, and open-interest weight
 * the rate-like ones so a venue's dominant market drives its headline number.
 */
export function collapseByExchange(snapshots: ExchangeSnapshot[]): ExchangeSnapshot[] {
  const byExchange = new Map<string, ExchangeSnapshot[]>();
  snapshots.forEach((s) => {
    const list = byExchange.get(s.exchangeId) ?? [];
    list.push(s);
    byExchange.set(s.exchangeId, list);
  });

  return [...byExchange.values()].map((group) => {
    if (group.length === 1) return group[0];

    const totalOi = group.reduce((sum, s) => sum + s.openInterestUsd, 0);
    const weight = (s: ExchangeSnapshot) => (totalOi > 0 ? s.openInterestUsd / totalOi : 1 / group.length);

    const weightedBy = (pick: (s: ExchangeSnapshot) => number | null): number | null => {
      const valid = group.filter((s) => pick(s) !== null);
      if (valid.length === 0) return null;
      const w = valid.reduce((sum, s) => sum + s.openInterestUsd, 0);
      if (w === 0) return null;
      return valid.reduce((sum, s) => sum + (pick(s) as number) * s.openInterestUsd, 0) / w;
    };

    const base = group.reduce((a, b) => (a.openInterestUsd >= b.openInterestUsd ? a : b));

    return {
      ...base,
      fundingRatePct: group.reduce((sum, s) => sum + s.fundingRatePct * weight(s), 0),
      openInterestUsd: totalOi,
      openInterestChange24hPct: weightedBy((s) => s.openInterestChange24hPct),
      volume24hUsd: group.reduce((sum, s) => sum + s.volume24hUsd, 0),
      longShortRatio: weightedBy((s) => s.longShortRatio),
      // A blended "price" across BTC and DOGE would be meaningless, so the
      // card hides it in this mode; marketCount drives that.
      marketCount: group.length,
    } as ExchangeSnapshot & { marketCount: number };
  });
}

export function ExchangeGrid({ exchanges }: { exchanges: ExchangeSnapshot[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("oi_desc");

  const collapsed = useMemo(() => collapseByExchange(exchanges), [exchanges]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = collapsed.filter((e) => {
      if (!q) return true;
      const meta = getExchange(e.exchangeId);
      return meta?.name.toLowerCase().includes(q) || e.exchangeId.includes(q);
    });
    return [...list].sort(SORTS[sortKey].cmp);
  }, [collapsed, query, sortKey]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search exchanges…"
            className="h-9 w-full rounded-md border border-hairline bg-panel pl-8 pr-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:ring-2 focus:ring-cyan/40"
          />
        </div>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORTS).map(([key, { label }]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((e) => (
          <ExchangeCard key={e.exchangeId} snapshot={e} />
        ))}
        {filtered.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed border-hairline py-10 text-center text-sm text-ink-faint">
            No exchanges match “{query}”.
          </div>
        )}
      </div>
    </div>
  );
}
