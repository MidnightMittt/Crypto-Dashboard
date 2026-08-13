import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { AssetReport, AssetReportData } from "@/components/asset/AssetReport";
import { TickerSearch } from "@/components/search/TickerSearch";
import { analyseTicker } from "@/lib/search/analyseTicker";
import { CoverageFamily } from "@/lib/search/liveAnalysis";

/**
 * ANY TICKER, ANALYSED ON REQUEST.
 *
 * Rendered dynamically because the bars are fetched when the page is asked
 * for — there is no build-time list of every symbol a user might type. The
 * report itself is `AssetReport`, byte-identical to the one an index ETF
 * gets, so a searched name is not a lesser page. What differs is provenance,
 * and that is stated rather than implied: coverage is always rendered, and a
 * symbol without enough history is REFUSED with a reason instead of scored.
 */

export const dynamic = "force-dynamic";

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const result = await analyseTicker(decodeURIComponent(symbol));

  // An index ETF has a better, validated page already. Send the user there
  // rather than serving a thinner live re-derivation of the same asset.
  if (result.status === "redirect") redirect(result.href);

  if (result.status === "error") {
    return (
      <div className="min-h-screen">
        <main className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-10 sm:px-6">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-mono text-lg font-semibold text-ink">{result.symbol}</h1>
            <Link href="/scanner" className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
              ← Scanner
            </Link>
          </div>
          <Card>
            <CardContent className="flex flex-col gap-3 py-5">
              <div className="flex items-center gap-3">
                <span className="text-3xl leading-none" aria-hidden>
                  ⚪
                </span>
                <span className="text-2xl font-black uppercase tracking-[0.04em] text-ink-muted">
                  No read
                </span>
              </div>
              <p className="text-[14px] leading-relaxed text-ink">{result.message}</p>
              <p className="text-[12px] leading-relaxed text-ink-muted">
                This is the engine declining rather than failing. Producing a confident-looking verdict from
                data that cannot support one is the single worst thing this platform could do, so it does not.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-5">
              <TickerSearch autoFocus />
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  const a = result.analysis;
  const report: AssetReportData = {
    symbol: a.symbol,
    name: a.name,
    lastClose: a.lastClose,
    change24hPct: a.change24hPct,
    asOf: a.asOf,
    bias: a.bias,
    plan: a.plan,
    planRefusal: a.planRefusal,
    earnings: a.earnings,
    zones: a.zones,
    atrPct: a.atrPct,
  };

  return (
    <AssetReport
      data={report}
      backHref="/scanner"
      backLabel="← Scanner"
      coverage={<CoveragePanel coverage={a.coverage} barsUsed={a.barsUsed} />}
      footnote={`Daily closes through ${new Date(a.asOf).toISOString().slice(0, 10)}, fetched just now. Not financial advice.`}
    />
  );
}

/**
 * WHAT BACKED THIS READ.
 *
 * Always rendered, never collapsed. A four-module read and an eighteen-module
 * read produce the same layout and the same confident typography; the only
 * thing separating them is this panel, which is why it is not hidden behind a
 * disclosure like the rest of the workings.
 */
function CoveragePanel({ coverage, barsUsed }: { coverage: CoverageFamily[]; barsUsed: number }) {
  const have = coverage.filter((c) => c.available).length;
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
            What this read is built on
          </h2>
          <span className="font-mono text-[10px] text-ink-faint">
            {have} of {coverage.length} data families · {barsUsed} sessions of history
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {coverage.map((c) => (
            <li key={c.label} className="flex items-start gap-2.5">
              <span aria-hidden className={`mt-0.5 shrink-0 ${c.available ? "text-success" : "text-ink-faint"}`}>
                {c.available ? "✓" : "—"}
              </span>
              <span className="text-[12px] leading-relaxed">
                <span className={c.available ? "text-ink" : "text-ink-muted"}>{c.label}</span>
                <span className="text-ink-faint"> · {c.note}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
