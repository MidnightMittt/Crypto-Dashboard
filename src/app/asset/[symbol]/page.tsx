import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { TickerSearch } from "@/components/search/TickerSearch";
import { StructureLadder, LadderMarker } from "@/components/markets/StructureLadder";
import {
  AnalogsPanel,
  EvidencePanel,
  GapsPanel,
  InvalidationPanel,
  MacroPanel,
  PlanPanel,
  ReasonsPanel,
  TldrPanel,
  VerdictPanel,
} from "@/components/dossier/DossierSections";
import { analyseTicker } from "@/lib/search/analyseTicker";
import { formatPrice } from "@/lib/utils/format";

/**
 * THE TICKER RESEARCH PAGE — the destination.
 *
 * The homepage says where to look. This says what to do. It is the page the
 * rest of the platform exists to feed, and its reading order is the product
 * thesis in layout form:
 *
 *   DECIDE     verdict, ten-second summary, the plan
 *   UNDERSTAND why it exists, what fights it, what ends it
 *   VERIFY     historical analogs, the tape it trades in, every reading
 *   AUDIT      what this page cannot see, named rather than hidden
 *
 * Rendered dynamically because the bars are fetched when the page is asked
 * for — there is no build-time list of every symbol someone might type.
 */

export const dynamic = "force-dynamic";

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const result = await analyseTicker(decodeURIComponent(symbol));

  // An index ETF has a validated, daily-refreshed page already. Serving a
  // thinner live re-derivation of the same asset would be strictly worse.
  if (result.status === "redirect") redirect(result.href);

  if (result.status === "error") return <NoRead symbol={result.symbol} message={result.message} />;

  const d = result.dossier;
  const markers: LadderMarker[] = d.plan.plan
    ? [
        { label: "Entry", price: d.plan.plan.entryRef, tone: "entry" },
        { label: "Stop", price: d.plan.plan.stopPrice, tone: "stop" },
        { label: "T1", price: d.plan.plan.target1Price, tone: "target" },
        { label: "T2", price: d.plan.plan.target2Price, tone: "target" },
      ]
    : [];

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-4 py-6 sm:px-6">
        {/* Identity */}
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-mono text-lg font-semibold text-ink">{d.identity.symbol}</h1>
            <span className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">{d.identity.name}</span>
            <span className="font-mono text-sm text-ink">{formatPrice(d.identity.lastClose)}</span>
            <span
              className={`font-mono text-[11px] ${
                d.identity.change24hPct > 0
                  ? "text-success"
                  : d.identity.change24hPct < 0
                    ? "text-danger"
                    : "text-ink-faint"
              }`}
            >
              {d.identity.change24hPct >= 0 ? "+" : ""}
              {d.identity.change24hPct.toFixed(2)}%
            </span>
          </div>
          <Link href="/scanner" className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
            ← Scanner
          </Link>
        </div>

        {/* ── DECIDE ──────────────────────────────────────────────────── */}
        <VerdictPanel d={d} />
        <TldrPanel d={d} />
        <PlanPanel d={d} />

        {/* ── UNDERSTAND ──────────────────────────────────────────────── */}
        <ReasonsPanel d={d} />
        <InvalidationPanel d={d} />

        {/* ── VERIFY ──────────────────────────────────────────────────── */}
        <AnalogsPanel d={d} />
        <MacroPanel d={d} />

        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Price levels that matter
            </h2>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Where price sits against the levels it has repeatedly reacted to. A level is only meaningful
              because buyers or sellers have defended it before.
            </p>
            <StructureLadder
              zones={d.zones}
              currentPrice={d.identity.lastClose}
              markers={markers}
              atrPct={d.atrPct}
            />
            <p className="text-[11px] leading-relaxed text-ink-faint">
              <span className="text-ink-muted">Typical daily move · </span>
              {d.atrPct === null
                ? "not measurable from the available history."
                : `${d.atrPct.toFixed(2)}% of price. A stop closer than that would be hit by ordinary movement rather than by the idea being wrong.`}
            </p>
          </CardContent>
        </Card>

        <EvidencePanel d={d} />

        {/* ── AUDIT ───────────────────────────────────────────────────── */}
        <GapsPanel d={d} />

        <Card>
          <CardContent className="py-5">
            <TickerSearch />
          </CardContent>
        </Card>

        <p className="text-[11px] text-ink-faint">
          {d.identity.provenance} Built on {d.identity.barsUsed} sessions of history. Not financial advice.
        </p>
      </main>
    </div>
  );
}

/**
 * The refusal page. A ticker that cannot be scored gets a stated reason and a
 * way to try again — never a blank, and never a fabricated verdict.
 */
function NoRead({ symbol, message }: { symbol: string; message: string }) {
  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-10 sm:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-mono text-lg font-semibold text-ink">{symbol}</h1>
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
              <span className="text-2xl font-black uppercase tracking-[0.04em] text-ink-muted">No read</span>
            </div>
            <p className="text-[14px] leading-relaxed text-ink">{message}</p>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              This is the engine declining, not failing. Producing a confident-looking verdict from data that
              cannot support one is the worst thing this platform could do, so it does not.
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
