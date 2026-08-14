import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { TickerSearch } from "@/components/search/TickerSearch";
import {
  AnalogsPanel,
  AttentionPanel,
  BusinessPanel,
  EvidencePanel,
  GapsPanel,
  InvalidationPanel,
  LevelsPanel,
  MacroPanel,
  OptionsPanel,
  OwnershipPanel,
  StreetPanel,
  PlanPanel,
  ReasonsPanel,
  TldrPanel,
  VerdictPanel,
} from "@/components/dossier/DossierSections";
import { DOSSIER_SECTIONS, SectionId } from "@/lib/dossier/sections";
import { TickerDossier } from "@/lib/dossier/types";
import { analyseTicker } from "@/lib/search/analyseTicker";
import { formatPrice } from "@/lib/utils/format";

/**
 * THE TICKER RESEARCH PAGE — the destination.
 *
 * The homepage says where to look. This says what to do.
 *
 * The page renders the section MANIFEST, in manifest order, and nothing
 * else. It never branches on what data a given asset happens to have —
 * every section renders its own unavailable, descriptive, measured and
 * validated states internally. That is the property that lets each slot
 * deepen independently as data sources and replays land, while the page a
 * user learned last month stays exactly where they learned it.
 */

export const dynamic = "force-dynamic";

/**
 * Every id the manifest can name has exactly one component. The Record type
 * makes this exhaustive at compile time: adding a section to the manifest
 * without a component (or vice versa) is a type error, not a blank spot
 * discovered in production.
 */
const SECTION_COMPONENTS: Record<SectionId, (props: { d: TickerDossier }) => React.ReactNode> = {
  verdict: VerdictPanel,
  tldr: TldrPanel,
  plan: PlanPanel,
  reasons: ReasonsPanel,
  invalidation: InvalidationPanel,
  analogs: AnalogsPanel,
  macro: MacroPanel,
  business: BusinessPanel,
  street: StreetPanel,
  options: OptionsPanel,
  ownership: OwnershipPanel,
  attention: AttentionPanel,
  levels: LevelsPanel,
  evidence: EvidencePanel,
  gaps: GapsPanel,
};

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const result = await analyseTicker(decodeURIComponent(symbol));

  // An index ETF has a validated, daily-refreshed page already. Serving a
  // thinner live re-derivation of the same asset would be strictly worse.
  if (result.status === "redirect") redirect(result.href);
  if (result.status === "error") return <NoRead symbol={result.symbol} message={result.message} />;

  const d = result.dossier;

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

        {DOSSIER_SECTIONS.map(({ id }) => {
          const SectionComponent = SECTION_COMPONENTS[id];
          return <SectionComponent key={id} d={d} />;
        })}

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
