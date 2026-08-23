"use client";
import { Reachability } from "./Reachability";

import * as React from "react";
import Link from "next/link";
import {
  RankedOpportunity,
  ScanSort,
  ScanFilter,
  SCAN_SORT_LABELS,
  SCAN_FILTER_LABELS,
  sortMarkets,
  filterMarkets,
  ACTIONABLE_OPPORTUNITY,
  HIGH_CONFIDENCE,
} from "@/lib/signals/opportunityRanking";
import { intensityLabel } from "@/lib/signals/scoring";
import { hrefFor, verdictTone, RISK_TONE } from "./shared";

/**
 * THE SCANNER TABLE.
 *
 * Sorting and filtering only. Every number in every cell was produced by the
 * decision engine and passed through `rankOpportunities` — this component
 * cannot and does not form an opinion, which is the property that makes a
 * scanner trustworthy. A ranked list is the most consequential surface in the
 * product precisely because nobody reads past row three, so the ordering has
 * to be the engine's, not the table's.
 *
 * Client-side because sorting and filtering are interactions, not data. The
 * rows arrive fully computed from the server.
 */

const SORTS: ScanSort[] = ["opportunity", "confidence", "agreement", "riskReward", "quality", "conviction"];
const FILTERS: ScanFilter[] = [
  "bullish",
  "bearish",
  "neutral",
  "highConfidence",
  "swingReady",
  "noSetup",
  "crypto",
  "equity",
];

export function ScannerTable({ rows, buyingPower = null }: { rows: RankedOpportunity[]; buyingPower?: number | null }) {
  const [sort, setSort] = React.useState<ScanSort>("opportunity");
  const [filters, setFilters] = React.useState<ScanFilter[]>([]);
  /*
   * Rows expand IN PLACE rather than navigating. A scanner's job is triage,
   * and triage means comparing three candidates without losing the list —
   * every round trip to an asset page and back is a comparison abandoned.
   */
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const visible = React.useMemo(() => sortMarkets(filterMarkets(rows, filters), sort), [rows, filters, sort]);

  const toggle = (f: ScanFilter) =>
    setFilters((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-[0.16em] text-ink-faint">Rank by</span>
          {SORTS.map((s) => (
            <Chip key={s} active={sort === s} onClick={() => setSort(s)}>
              {SCAN_SORT_LABELS[s]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-[0.16em] text-ink-faint">Show</span>
          {FILTERS.map((f) => (
            <Chip key={f} active={filters.includes(f)} onClick={() => toggle(f)}>
              {SCAN_FILTER_LABELS[f]}
            </Chip>
          ))}
          {filters.length > 0 && (
            <button
              type="button"
              onClick={() => setFilters([])}
              className="ml-1 text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            >
              clear
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        {visible.length} of {rows.length} markets.{" "}
        {sort === "riskReward" || sort === "quality" ? (
          <>
            Markets with no plan have no {sort === "quality" ? "quality rating" : "risk/reward"} and sort to
            the bottom — absent is not the same as worst.
          </>
        ) : sort === "agreement" ? (
          <>
            Agreement is how much the modules concur with each other, a different axis from confidence.
          </>
        ) : sort === "opportunity" ? (
          <>
            Ranked by conviction × confidence — how far the engine is from the fence, times how good the
            evidence behind that is. Not by any indicator.
          </>
        ) : sort === "confidence" ? (
          <>Confidence is evidence quality, never the probability of a move.</>
        ) : (
          <>Conviction is distance from neutral alone, ignoring how well evidenced the read is.</>
        )}
      </p>

      {visible.length === 0 ? (
        <p className="rounded-md border border-hairline bg-void/30 px-4 py-6 text-center text-xs leading-relaxed text-ink-muted">
          No market matches these filters. That is a finding about the tape, not an error — the
          combination you asked for does not currently exist anywhere in the tracked universe.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                <Th className="w-[4%]">#</Th>
                <Th className="w-[13%]">Market</Th>
                <Th className="w-[22%]">Decision</Th>
                <Th className="w-[9%] text-right">Conf</Th>
                <Th className="w-[9%] text-right">Agree</Th>
                <Th className="w-[9%] text-right">Opp</Th>
                <Th className="w-[9%] text-right">24h</Th>
                <Th className="w-[27%]">Setup</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <Row
                  key={`${r.assetClass}-${r.asset}`}
                  row={r}
                  rank={visible.indexOf(r) + 1}
                  buyingPower={buyingPower}
                  isOpen={expanded === `${r.assetClass}-${r.asset}`}
                  onToggle={() =>
                    setExpanded((cur) =>
                      cur === `${r.assetClass}-${r.asset}` ? null : `${r.assetClass}-${r.asset}`
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  rank,
  isOpen,
  onToggle,
  buyingPower = null,
}: {
  row: RankedOpportunity;
  rank: number;
  isOpen: boolean;
  onToggle: () => void;
  buyingPower?: number | null;
}) {
  const tone = verdictTone(row.verdict);

  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-hairline/60 align-top transition-colors hover:bg-panel-hi/40 ${
          isOpen ? "bg-panel-hi/50" : ""
        }`}
      >
        <Td className="font-mono text-[11px] text-ink-faint">{rank}</Td>
        <Td>
          <Link
            href={hrefFor(row)}
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[13px] font-semibold text-ink hover:text-cyan"
          >
            {row.asset}
          </Link>
          <Reachability price={row.lastClose} buyingPower={buyingPower ?? null} compact />
          {row.name && <div className="mt-0.5 text-[10px] text-ink-faint">{row.name}</div>}
        </Td>
        <Td>
          <span className={`text-[12px] font-semibold uppercase tracking-[0.04em] ${tone}`}>
            {intensityLabel(row.score)}
          </span>
          <span className="ml-1.5 font-mono text-[11px] text-ink-faint">{row.score}</span>
        </Td>
        <Td className="text-right">
          <span
            className={`font-mono text-[12px] ${row.confidence >= HIGH_CONFIDENCE ? "text-ink" : "text-ink-faint"}`}
          >
            {row.confidence}%
          </span>
        </Td>
        <Td className="text-right font-mono text-[12px] text-ink-muted">
          {row.agreement === undefined ? "—" : `${row.agreement}%`}
        </Td>
        <Td className="text-right">
          {/* A bar, not just a number: relative strength across the list is the
              thing a scanner exists to make visible at a glance. */}
          <div className="flex items-center justify-end gap-1.5">
            <span className="h-1 w-10 overflow-hidden rounded-full bg-hairline">
              <span
                className={`block h-full ${row.opportunity >= ACTIONABLE_OPPORTUNITY ? "bg-cyan" : "bg-ink-faint"}`}
                style={{ width: `${row.opportunity}%` }}
              />
            </span>
            <span
              className={`font-mono text-[12px] ${
                row.opportunity >= ACTIONABLE_OPPORTUNITY ? "text-ink" : "text-ink-faint"
              }`}
            >
              {row.opportunity}
            </span>
          </div>
        </Td>
        <Td
          className={`text-right font-mono text-[12px] ${
            row.priceChange24hPct > 0 ? "text-success" : row.priceChange24hPct < 0 ? "text-danger" : "text-ink-faint"
          }`}
        >
          {row.priceChange24hPct >= 0 ? "+" : ""}
          {row.priceChange24hPct.toFixed(2)}%
        </Td>
        <Td>
          {row.setup ? (
            <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              <span
                className={`font-semibold uppercase tracking-[0.1em] ${
                  row.setup.state === "active" ? "text-cyan" : "text-ink-muted"
                }`}
              >
                {row.setup.state === "active" ? "Active" : "Planned"} {row.setup.direction}
              </span>
              <span className="font-mono text-ink">{row.setup.riskReward.toFixed(2)}R</span>
              <span className="text-ink-faint">
                {"★".repeat(row.setup.stars)}
                {"☆".repeat(Math.max(0, 5 - row.setup.stars))}
              </span>
            </div>
          ) : (
            <span className="text-[11px] text-ink-faint">No plan</span>
          )}
        </Td>
      </tr>

      {isOpen && (
        <tr className="border-b border-hairline/60 bg-void/40">
          <td colSpan={8} className="px-4 py-4">
            <div className="flex flex-col gap-3">
              <p className="max-w-4xl text-[13px] leading-relaxed text-ink">{row.headline}</p>

              <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
                <InlineReasons title="Why" mark="✓" markClass="text-success" items={row.reasonsFor ?? []} />
                <InlineReasons
                  title="Against"
                  mark="✕"
                  markClass="text-danger"
                  items={row.reasonsAgainst ?? []}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-hairline pt-3 text-[11px]">
                {row.riskLevel && (
                  <span className="text-ink-muted">
                    Risk{" "}
                    <span className={`font-semibold uppercase ${RISK_TONE[row.riskLevel] ?? "text-ink"}`}>
                      {row.riskLevel}
                    </span>
                  </span>
                )}
                {row.setup && (
                  <span className="text-ink-muted">
                    Setup status <span className="text-ink">{row.setup.status.replace(/-/g, " ")}</span>
                  </span>
                )}
                <span className="text-ink-faint">
                  Conviction {row.conviction} from neutral × {row.confidence}% evidence = {row.opportunity}
                </span>
                <Link
                  href={hrefFor(row)}
                  className="ml-auto uppercase tracking-[0.14em] text-cyan hover:underline"
                >
                  Full decision →
                </Link>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function InlineReasons({
  title,
  mark,
  markClass,
  items,
}: {
  title: string;
  mark: string;
  markClass: string;
  items: string[];
}) {
  return (
    <div>
      <h4 className="text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1 text-[11px] text-ink-faint">
          Nothing on this side — open the full decision for the per-module detail.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {items.map((r) => (
            <li key={r} className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-muted">
              <span aria-hidden className={`shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? "border-cyan/50 bg-cyan/10 text-cyan"
          : "border-hairline text-ink-muted hover:border-ink-faint hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-2 pb-2 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-2.5 ${className}`}>{children}</td>;
}
