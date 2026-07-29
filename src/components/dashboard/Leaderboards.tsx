"use client";

import { useMemo } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { ExchangeSnapshot } from "@/types/market";
import { getExchange } from "@/lib/exchanges/registry";
import { formatCompactUsd, formatBps, formatPct, fundingPer8h } from "@/lib/utils/format";

interface Row {
  key: string;
  primary: string;
  secondary: string;
  value: string;
  tone: "success" | "danger" | "neutral";
}

function toRows(
  exchanges: ExchangeSnapshot[],
  sort: (a: ExchangeSnapshot, b: ExchangeSnapshot) => number,
  render: (e: ExchangeSnapshot) => { value: string; tone: Row["tone"] }
): Row[] {
  return [...exchanges]
    .sort(sort)
    .slice(0, 8)
    .map((e) => {
      const meta = getExchange(e.exchangeId);
      const { value, tone } = render(e);
      return {
        key: `${e.asset}-${e.exchangeId}`,
        primary: e.asset,
        secondary: meta?.name ?? e.exchangeId,
        value,
        tone,
      };
    });
}

/** 8h-equivalent funding — required before ranking across venues. */
function norm8h(e: ExchangeSnapshot): number {
  return fundingPer8h(e.fundingRatePct, e.fundingIntervalHours);
}

function fundingChange24h(e: ExchangeSnapshot): number {
  const series = e.fundingHistory.filter((p) => p.fundingRatePct !== undefined);
  const dayAgo = series.find((p) => p.t >= Date.now() - 24 * 3_600_000);
  return dayAgo?.fundingRatePct !== undefined ? e.fundingRatePct - dayAgo.fundingRatePct : 0;
}

export function Leaderboards({ exchanges }: { exchanges: ExchangeSnapshot[] }) {
  const funding = useMemo(
    () => ({
      positive: toRows(exchanges, (a, b) => norm8h(b) - norm8h(a), (e) => ({
        value: `${formatBps(norm8h(e))} bps`,
        tone: "success" as const,
      })),
      negative: toRows(exchanges, (a, b) => norm8h(a) - norm8h(b), (e) => ({
        value: `${formatBps(norm8h(e))} bps`,
        tone: "danger" as const,
      })),
      change: toRows(
        exchanges,
        (a, b) => Math.abs(fundingChange24h(b)) - Math.abs(fundingChange24h(a)),
        (e) => {
          const d = fundingPer8h(fundingChange24h(e), e.fundingIntervalHours);
          return { value: `${formatBps(d)} bps`, tone: d >= 0 ? ("success" as const) : ("danger" as const) };
        }
      ),
      flip: toRows(
        exchanges,
        (a, b) => Number(isFlip(b)) - Number(isFlip(a)) || Math.abs(fundingChange24h(b)) - Math.abs(fundingChange24h(a)),
        (e) => ({
          value: `${isFlip(e) ? "flipped → " : ""}${formatBps(norm8h(e))} bps`,
          tone: e.fundingRatePct >= 0 ? ("success" as const) : ("danger" as const),
        })
      ),
    }),
    [exchanges]
  );

  const oi = useMemo(
    () => ({
      highest: toRows(exchanges, (a, b) => b.openInterestUsd - a.openInterestUsd, (e) => ({
        value: formatCompactUsd(e.openInterestUsd),
        tone: "neutral" as const,
      })),
      increase: toRows(
        exchanges.filter((e) => e.openInterestChange24hPct !== null),
        (a, b) => (b.openInterestChange24hPct ?? 0) - (a.openInterestChange24hPct ?? 0),
        (e) => ({ value: formatPct(e.openInterestChange24hPct ?? 0, 1), tone: "success" as const })
      ),
      decrease: toRows(
        exchanges.filter((e) => e.openInterestChange24hPct !== null),
        (a, b) => (a.openInterestChange24hPct ?? 0) - (b.openInterestChange24hPct ?? 0),
        (e) => ({ value: formatPct(e.openInterestChange24hPct ?? 0, 1), tone: "danger" as const })
      ),
      turnover: toRows(
        exchanges,
        (a, b) => b.openInterestUsd / Math.max(b.volume24hUsd, 1) - a.openInterestUsd / Math.max(a.volume24hUsd, 1),
        (e) => ({
          value: `${(e.openInterestUsd / Math.max(e.volume24hUsd, 1)).toFixed(2)}× OI/Vol`,
          tone: "neutral" as const,
        })
      ),
    }),
    [exchanges]
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Board
        title="Funding Leaderboard"
        tabs={[
          { value: "positive", label: "Most Positive", rows: funding.positive },
          { value: "negative", label: "Most Negative", rows: funding.negative },
          { value: "change", label: "Biggest Move", rows: funding.change },
          { value: "flip", label: "Flips", rows: funding.flip },
        ]}
      />
      <Board
        title="Open Interest Leaderboard"
        tabs={[
          { value: "highest", label: "Highest OI", rows: oi.highest },
          { value: "increase", label: "Biggest Increase", rows: oi.increase },
          { value: "decrease", label: "Biggest Decrease", rows: oi.decrease },
          { value: "turnover", label: "OI / Volume", rows: oi.turnover },
        ]}
      />
    </div>
  );
}

function isFlip(e: ExchangeSnapshot): boolean {
  const series = e.fundingHistory.filter((p) => p.fundingRatePct !== undefined);
  const dayAgo = series.find((p) => p.t >= Date.now() - 24 * 3_600_000);
  if (dayAgo?.fundingRatePct === undefined) return false;
  return Math.sign(dayAgo.fundingRatePct) !== Math.sign(e.fundingRatePct);
}

function Board({
  title,
  tabs,
}: {
  title: string;
  tabs: Array<{ value: string; label: string; rows: Row[] }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <div className="p-4 pt-2">
        <Tabs defaultValue={tabs[0].value}>
          <TabsList className="mb-3 flex-wrap">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              {t.rows.length === 0 && (
                <p className="py-6 text-center text-xs text-ink-faint">
                  No venue reports this metric yet.
                </p>
              )}
              <ol className="flex flex-col gap-1">
                {t.rows.map((row, i) => (
                  <li
                    key={row.key}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-white/5"
                  >
                    <span className="flex items-center gap-3">
                      <span className="w-4 font-mono text-[11px] text-ink-faint">{i + 1}</span>
                      <span className="font-medium text-ink">{row.primary}</span>
                      <span className="text-xs text-ink-muted">{row.secondary}</span>
                    </span>
                    <span
                      className={`font-mono text-xs ${
                        row.tone === "success" ? "text-success" : row.tone === "danger" ? "text-danger" : "text-ink"
                      }`}
                    >
                      {row.value}
                    </span>
                  </li>
                ))}
              </ol>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </Card>
  );
}
