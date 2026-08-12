import Link from "next/link";
import { RankedOpportunity } from "@/lib/signals/opportunityRanking";
import { hrefFor } from "./shared";

/**
 * WHAT THE ENGINE CHANGED ITS MIND ABOUT.
 *
 * The one view a chart cannot produce. A chart shows where a market IS; this
 * shows which pieces of evidence flipped since the engine last looked, which
 * is the only thing that can make a standing conclusion wrong.
 *
 * Every entry is `bias.changes` — computed on every poll by diffing against
 * the previous stored reading, and until now visible nowhere but a single
 * asset's expanded panel. Nothing is recomputed here; the component groups
 * and orders what the engine already recorded.
 */

const TONE: Record<string, string> = {
  bullish: "text-success",
  bearish: "text-danger",
  neutral: "text-ink-muted",
};

export function WhatChanged({ rows }: { rows: RankedOpportunity[] }) {
  const moved = rows
    .filter((r) => (r.changes?.length ?? 0) > 0)
    /* Most flips first: a market where four modules turned is a different
       event from one where a single low-weight reading wobbled. */
    .sort((a, b) => (b.changes?.length ?? 0) - (a.changes?.length ?? 0))
    .slice(0, 6);

  const firstReadings = rows.filter((r) => r.isFirstReading).length;
  const comparable = rows.filter((r) => r.isFirstReading === false).length;

  return (
    <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 shadow-glass backdrop-blur-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          What changed since the last reading
        </h2>
        <span className="text-[10px] text-ink-faint">
          {comparable > 0 ? `${moved.length} of ${comparable} markets moved` : "no comparable history yet"}
        </span>
      </div>

      {moved.length === 0 ? (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          {comparable === 0
            ? "No market has a prior reading to compare against yet. This fills in once the engine has seen each market twice — an empty list here means unknown, not unchanged."
            : "No module flipped anywhere in the tracked universe. The engine is looking at the same evidence it was, so any standing conclusion still stands on the reasons it was made for."}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {moved.map((r) => (
            <li key={`${r.assetClass}-${r.asset}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={hrefFor(r)}
                className="w-14 shrink-0 font-mono text-[12px] font-semibold text-ink hover:text-cyan"
              >
                {r.asset}
              </Link>
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-relaxed">
                {r.changes!.slice(0, 4).map((c) => (
                  <span key={c.label} className="text-ink-muted">
                    {c.label}{" "}
                    <span className={TONE[c.from] ?? "text-ink-faint"}>{c.from}</span>
                    <span className="text-ink-faint"> → </span>
                    <span className={TONE[c.to] ?? "text-ink-faint"}>{c.to}</span>
                  </span>
                ))}
                {r.changes!.length > 4 && (
                  <span className="text-ink-faint">+{r.changes!.length - 4} more</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {firstReadings > 0 && (
        <p className="mt-3 border-t border-hairline pt-2.5 text-[10px] leading-relaxed text-ink-faint">
          {firstReadings} market{firstReadings === 1 ? " has" : "s have"} no prior reading to diff
          against and {firstReadings === 1 ? "is" : "are"} excluded rather than shown as unchanged.
          Equity rows come from a daily-close snapshot with no stored predecessor, so they never
          appear here — that is a property of how they are built, not a quiet tape.
        </p>
      )}
    </section>
  );
}
