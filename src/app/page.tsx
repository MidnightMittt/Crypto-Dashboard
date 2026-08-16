import Link from "next/link";
import { TickerSearch } from "@/components/search/TickerSearch";
import { WatchlistStrip } from "@/components/watchlist/WatchlistStrip";
import { WhatChanged } from "@/components/intelligence/WhatChanged";
import { FreshnessBanner } from "@/components/intelligence/FreshnessBanner";
import { buildBrief } from "@/lib/brief/buildBrief";
import { Ledger, latestDiff } from "@/lib/markets/historyLedger";
import { RegimeRead } from "@/lib/markets/riskRegime";
import snapshot from "@/data/marketIntelligence.json";
import ledgerJson from "@/data/signalLedger.json";
import crossSectionJson from "@/data/equityCrossSection.json";
import validationJson from "@/data/signalValidation.json";
import earningsJson from "@/data/earningsCalendar.json";

/**
 * THE BRIEF — the front door, and the shortest page on the platform.
 *
 * Four questions, in the order a returning trader asks them: what regime are
 * we in, what changed overnight, what could blow up today, and is there
 * anything worth doing. The market intelligence page — regime pairs, rotation
 * boards, industry breadth — is one click down at /intelligence, where it
 * belongs: it is the WORKINGS, and the workings should not be the first
 * screen.
 *
 * ── Why the actionable section is usually empty ───────────────────────
 *
 * Items are Edge-qualified only: a signal that cleared the Wilson gate and
 * survived FDR correction, or nothing. Today the platform has exactly one
 * such equity signal, it fires only for the top decile of a ranking, and its
 * record only holds while breadth is healthy. Most days that produces
 * nothing, and the page says so as a conclusion rather than an apology.
 *
 * The failure mode this avoids is not subtle. A brief that must produce three
 * ideas every morning will find three, and the third will be there because
 * the layout had a slot — which is how a research tool turns into a tip sheet
 * without anyone deciding to do that.
 */

const data = snapshot as unknown as {
  generatedAt: number;
  regime: RegimeRead | null;
};
const ledger = ledgerJson as Ledger;
const crossSection = crossSectionJson as {
  asOf: number;
  breadthPct: number | null;
  decileSize: number;
  members: Array<{ symbol: string; mom: number }>;
};
const validation = validationJson as {
  results: Array<{
    id: string;
    winRate: number;
    lowerBound: number | null;
    n: number;
    meanSpread: number;
    holdSessions: number;
    earnsEdge: boolean;
  }>;
};
const earnings = earningsJson as { entries?: Array<{ symbol: string; date: string }> };

export const metadata = { title: "The Brief — Leverage Terminal" };

export default function BriefPage() {
  const brief = buildBrief({
    regime: data.regime ? { regime: data.regime.regime, headline: data.regime.headline } : null,
    diff: latestDiff(ledger),
    ledgerEntries: ledger.entries.length,
    crossSection,
    /*
     * The GATED long-only record, not the unconditional one. The brief only
     * ever offers this item while breadth is healthy, so quoting the
     * all-weather number beside it would describe a different strategy than
     * the one on offer.
     */
    momentumRecord: validation.results.find((r) => r.id === "momentum-12-1-long-only-broad-up") ?? null,
    earnings: earnings.entries ?? [],
    now: Date.now(),
  });

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[900px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">The Brief</h1>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              State · what changed · what is due · what qualifies
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/intelligence" className="hover:text-ink">
              Intelligence
            </Link>
            <Link href="/validation" className="hover:text-ink">
              Validation
            </Link>
            <Link href="/scanner" className="hover:text-ink">
              Scanner
            </Link>
            <Link href="/crypto" className="hover:text-ink">
              Crypto
            </Link>
          </nav>
        </div>

        <FreshnessBanner generatedAt={data.generatedAt} />

        <TickerSearch showHelp={false} />
        <WatchlistStrip />

        {/* ── 1. THE STATE ─────────────────────────────────────────────── */}
        {brief.stateLine && (
          <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-4 sm:px-6">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Where we are
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-ink">{brief.stateLine}</p>
            <Link
              href="/intelligence"
              className="mt-2 inline-block text-[11px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
            >
              The pairs behind this →
            </Link>
          </section>
        )}

        {/* ── 2. WHAT CHANGED ──────────────────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-panel/40 px-5 py-4 sm:px-6">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Since the last session
          </h2>
          <div className="mt-2">
            <WhatChanged diff={brief.diff} entries={brief.ledgerEntries} />
          </div>
        </section>

        {/* ── 3. WHAT IS DUE ───────────────────────────────────────────── */}
        <section className="rounded-xl border border-hairline bg-panel/40 px-5 py-4 sm:px-6">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Risk on the calendar
          </h2>
          {brief.riskEvents.length === 0 ? (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
              No tracked name reports inside the next five sessions. That is the same window the planner
              uses to veto new entries, so nothing on the calendar is currently blocking a plan.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {brief.riskEvents.map((e) => (
                <li key={`${e.symbol}-${e.date}`} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="font-mono text-ink">{e.symbol}</span>
                  <span className="text-ink-muted">
                    reports {e.daysAway === 0 ? "today" : e.daysAway === 1 ? "tomorrow" : `in ${e.daysAway} days`}
                  </span>
                  <span className="font-mono text-[10px] text-ink-faint">{e.date}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 4. WHAT QUALIFIES ────────────────────────────────────────── */}
        <section
          className={`rounded-xl border px-5 py-4 sm:px-6 ${
            brief.items.length > 0 ? "border-success/25 bg-success/[0.03]" : "border-hairline bg-panel/40"
          }`}
        >
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            What qualifies today
          </h2>

          {brief.items.length === 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-[15px] font-semibold text-ink">Nothing qualifies today.</p>
              <p className="text-[12px] leading-relaxed text-ink-muted">{brief.noItemsReason}</p>
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-4">
              {brief.items.map((item) => (
                <div key={item.headline} className="flex flex-col gap-2">
                  <p className="text-[14px] font-semibold leading-snug text-ink">{item.headline}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {item.symbols.map((s) => (
                      <Link
                        key={s}
                        href={`/asset/${encodeURIComponent(s)}`}
                        className="rounded-md border border-hairline bg-void/30 px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-cyan/30 hover:text-ink"
                      >
                        {s}
                      </Link>
                    ))}
                  </div>
                  <p className="text-[12px] leading-relaxed text-ink-muted">{item.detail}</p>
                  <p className="rounded-md border border-hairline bg-void/30 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
                    <span className="font-semibold uppercase tracking-[0.12em] text-success">Record</span> ·{" "}
                    {item.record}
                  </p>
                </div>
              ))}
            </div>
          )}

          <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">
            Items appear here only when a signal has beaten its own baseline out of sample and survived
            correction for multiple testing. An empty section is the normal output and is a conclusion, not a
            gap — a brief that always finds three ideas is a content schedule.{" "}
            <Link href="/validation" className="text-ink-muted underline decoration-hairline hover:text-ink">
              Every signal we have measured, including the failures →
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
