"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/Card";
import { AssetComposites } from "@/lib/exchanges/assetComposites";
import { AssetComposite } from "@/lib/signals/assetComposite";
import { rankOpportunities, ACTIONABLE_OPPORTUNITY, RankedOpportunity } from "@/lib/signals/opportunityRanking";
import { formatPct } from "@/lib/utils/format";

/**
 * THE OPPORTUNITY SCANNER — the answer to "so what should I look at?"
 *
 * This exists because the single-asset decision surface answers a question
 * the user did not necessarily ask. A swing thesis is active on roughly a
 * quarter of days, so most visits to a given asset end in "no setup" — and
 * the honest reply to that is not a longer explanation, it is naming the
 * asset that DOES have one.
 *
 * Every row is the same engine's published output for that asset, ordered by
 * `rankOpportunities`. Nothing here recomputes a score, and nothing here
 * sorts by an indicator: the ordering is conviction x confidence, both taken
 * from the engine. See opportunityRanking.ts for why it is a product.
 */
export function OpportunityScanner({
  data,
  selectedAsset,
}: {
  data: AssetComposites | null | undefined;
  selectedAsset?: string;
}) {
  if (!data) return null;

  const all: AssetComposite[] = [
    ...(data.btc ? [data.btc] : []),
    ...(data.eth ? [data.eth] : []),
    ...(data.altcoins?.assets ?? []),
  ];
  if (all.length === 0) return null;

  const ranked = rankOpportunities(all);
  const actionable = ranked.filter((r) => r.opportunity >= ACTIONABLE_OPPORTUNITY);
  const quiet = ranked.filter((r) => r.opportunity < ACTIONABLE_OPPORTUNITY);
  const current = (selectedAsset ?? "").toUpperCase();

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Where the engine sees opportunity
          </h2>
          <span className="text-[11px] text-ink-faint">
            {ranked.length} assets · ranked by conviction × confidence, not by any indicator
          </span>
        </div>

        {actionable.length === 0 ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            No asset currently clears the bar for a ranked opportunity. Every tracked market is
            either near the fence or thinly evidenced — which is itself a finding, and a reason to
            wait rather than to look harder.
          </p>
        ) : (
          <ul className="flex flex-col">
            {actionable.map((r) => (
              <OpportunityRow key={r.asset} row={r} isCurrent={r.asset === current} />
            ))}
          </ul>
        )}

        {quiet.length > 0 && (
          <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Quiet:</span>{" "}
            {quiet.map((q) => q.asset).join(", ")} — near the fence or thinly evidenced. Shown so
            the universe is never silently truncated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const DIRECTION_LABEL: Record<RankedOpportunity["direction"], string> = {
  long: "Long",
  short: "Short",
  none: "No side",
};

function OpportunityRow({ row, isCurrent }: { row: RankedOpportunity; isCurrent: boolean }) {
  const tone =
    row.direction === "long" ? "text-success" : row.direction === "short" ? "text-danger" : "text-ink-muted";

  return (
    <li>
      <Link
        href={`/asset/${row.asset.toLowerCase()}`}
        className={`group flex flex-col gap-1.5 border-b border-hairline/60 py-3 transition-colors hover:bg-white/[0.02] ${
          isCurrent ? "bg-white/[0.02]" : ""
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="w-14 shrink-0 font-mono text-sm font-semibold text-ink">{row.asset}</span>
          <span className={`w-16 shrink-0 text-xs font-semibold uppercase tracking-[0.08em] ${tone}`}>
            {DIRECTION_LABEL[row.direction]}
          </span>

          {/*
            The opportunity number carries a bar because a bare 0-100 invites
            comparison to a probability. The bar makes it read as a relative
            ranking, which is what it is.
          */}
          <span className="flex items-center gap-2">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-white/10">
              <span
                className={`block h-full ${row.direction === "short" ? "bg-danger" : "bg-success"}`}
                style={{ width: `${row.opportunity}%` }}
              />
            </span>
            <span className="font-mono text-xs text-ink">{row.opportunity}</span>
          </span>

          <span className="text-[11px] text-ink-faint">
            score {row.score} · conf {row.confidence}%
          </span>
          <span
            className={`ml-auto font-mono text-[11px] ${
              row.priceChange24hPct > 0 ? "text-success" : row.priceChange24hPct < 0 ? "text-danger" : "text-ink-faint"
            }`}
          >
            {formatPct(row.priceChange24hPct, 1)}
          </span>
          {isCurrent && (
            <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] text-ink-faint">
              Viewing
            </span>
          )}
        </div>
        {/*
          The engine's own sentence for that asset. A ranked list without it
          would be a leaderboard of numbers — the reason to look is the reason
          the engine gives, not the rank.
        */}
        <p className="text-[11px] leading-relaxed text-ink-muted">{row.headline}</p>
      </Link>
    </li>
  );
}
