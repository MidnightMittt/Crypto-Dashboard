import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { TickerSearch } from "@/components/search/TickerSearch";
import { WatchlistStar, WatchlistStrip } from "@/components/watchlist/WatchlistStrip";
import {
  AnalogsPanel,
  AttentionPanel,
  BusinessPanel,
  ChecklistPanel,
  EngineBarsPanel,
  EvidencePanel,
  GapsPanel,
  InvalidationPanel,
  LevelsPanel,
  MacroPanel,
  NextEntryPanel,
  OptionsIntelPanel,
  OptionsPanel,
  OwnershipPanel,
  CatalystsPanel,
  LivenessPanel,
  MoneyFlowPanel,
  PassRulesPanel,
  StreetPanel,
  PlanPanel,
  ReasonsPanel,
  TldrPanel,
  ValidatedSignalPanel,
  VerdictPanel,
} from "@/components/dossier/DossierSections";
import { FoldedSection } from "@/components/ui/FoldedSection";
import {
  MODULES,
  ModuleId,
  PHASE_ORDER,
  Phase,
  SECTIONS,
  modulesOf,
  sectionsOf,
} from "@/lib/dossier/modules";
import { TickerDossier } from "@/lib/dossier/types";
import StopGridPanel from "@/components/dossier/StopGridPanel";
import TrendStatePanel from "@/components/dossier/TrendStatePanel";
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
 *
 * ── Hierarchy comes from the manifest, not from this file ─────────────
 *
 * Sections used to render in one flat loop, every card identical. Sixteen
 * well-built sections at equal visual weight is a data dump: when nothing is
 * emphasised, the reader has to assemble the trade themselves, which is the
 * job the engine already did.
 *
 * So the page now groups by `phase` and gives each group a different voice.
 * The order within a group is still the manifest's, and the page still knows
 * nothing about any section's contents — it asks the manifest how loud each
 * one should be and renders accordingly. Adding a section still means one
 * manifest entry; its phase now also decides its prominence.
 */

export const dynamic = "force-dynamic";

/**
 * How each phase is presented.
 *
 * `decide` gets no heading — it IS the answer, and titling it would be
 * explaining the punchline. The later groups are labelled in the reader's
 * own words ("Why the engine reads it this way") rather than the engine's
 * internal phase names.
 *
 * `audit` folds. Everything in it corroborates a decision already made and
 * none of it votes in the score, so it earns its space only for the reader
 * who wants it — and `FoldedSection` keeps every word in the document while
 * it is closed, so folding is layering rather than hiding.
 */
/**
 * How each phase is presented.
 *
 * `decide` gets no headings at all — it IS the answer, and labelling the
 * punchline explains it away. Every other phase labels its SECTIONS, using
 * the reader's names for them rather than the engine's internal phase names,
 * because the fourteen section names are the contract a reader learns.
 *
 * `audit` folds into one server-rendered `<details>`, so every word stays in
 * the document and find-in-page still reaches it. Folding is layering, not
 * hiding: nothing in it votes in the score, so it earns its space only for
 * the reader who wants it.
 */
const PHASE_PRESENTATION: Record<Phase, { fold: string | null; blurb: string | null }> = {
  decide: { fold: null, blurb: null },
  risk: { fold: null, blurb: null },
  verify: { fold: null, blurb: null },
  evidence: { fold: null, blurb: null },
  audit: {
    fold: "Show me the evidence",
    blurb:
      "Every reading behind the decision above, with its confidence and its sources — plus the fundamentals, the analyst view, the gaps this page cannot see, and whether the daily pipeline behind these numbers actually ran. Nothing here votes in the score; it is the workings.",
  },
};

/**
 * Every module the registry names has exactly one component. The Record type
 * makes this exhaustive at compile time: registering a module without a
 * component (or vice versa) is a type error, not a blank spot discovered in
 * production.
 */
const MODULE_COMPONENTS: Record<ModuleId, (props: { d: TickerDossier }) => React.ReactNode> = {
  tldr: TldrPanel,
  verdict: VerdictPanel,
  reasons: ReasonsPanel,
  engineBars: EngineBarsPanel,
  plan: PlanPanel,
  nextEntry: NextEntryPanel,
  checklist: ChecklistPanel,
  invalidation: InvalidationPanel,
  stopGrid: StopGridPanel,
  trendState: TrendStatePanel,
  passRules: PassRulesPanel,
  analogs: AnalogsPanel,
  validatedSignal: ValidatedSignalPanel,
  moneyFlow: MoneyFlowPanel,
  optionsIntel: OptionsIntelPanel,
  optionsFlow: OptionsPanel,
  ownership: OwnershipPanel,
  news: AttentionPanel,
  catalysts: CatalystsPanel,
  levels: LevelsPanel,
  macro: MacroPanel,
  business: BusinessPanel,
  street: StreetPanel,
  fullEvidence: EvidencePanel,
  gaps: GapsPanel,
  liveness: LivenessPanel,
};

/** One section: its heading (outside `decide`) and every module inside it. */
function SectionBlock({ id, title, showTitle, d }: {
  id: (typeof SECTIONS)[number]["id"];
  title: string;
  showTitle: boolean;
  d: TickerDossier;
}) {
  return (
    <section key={id} className="flex flex-col gap-5">
      {showTitle && (
        <h2 className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">{title}</h2>
      )}
      {modulesOf(id).map((m) => {
        const Module = MODULE_COMPONENTS[m.id];
        return <Module key={m.id} d={d} />;
      })}
    </section>
  );
}

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
          <div className="flex items-center gap-3">
            {/* Beside the identity, because that is what it acts on. */}
            <WatchlistStar symbol={d.identity.symbol} />
            <Link href="/scanner" className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
              ← Scanner
            </Link>
          </div>
        </div>

        {/* Search leads, because searching a ticker is the primary way this
            platform is used. At the foot of the page it was a footnote to a
            page you had already finished reading. Without its help text: the
            verdict has to own the first screen. */}
        <TickerSearch showHelp={false} />

        {/* Directly under search: the saved list IS a search shortcut. Renders
            nothing when empty, so a first-time reader never sees a pitch. */}
        <WatchlistStrip activeSymbol={d.identity.symbol} />

        {PHASE_ORDER.map((phase) => {
          const sections = sectionsOf(phase);
          if (sections.length === 0) return null;
          const { fold, blurb } = PHASE_PRESENTATION[phase];
          const blocks = sections.map((sec) => (
            <SectionBlock
              key={sec.id}
              id={sec.id}
              title={sec.title}
              /*
               * A heading exists to GROUP. With one module there is nothing to
               * group, and the heading merely restates the panel beneath it —
               * "Money Flow" directly above "Money flow". Single-module
               * sections are titled by their own panel, whose copy is better
               * anyway ("Price levels that matter" beats "Technical
               * Structure"). The decide group never takes a heading at all:
               * it is the answer, and labelling the punchline explains it.
               */
              showTitle={phase !== "decide" && modulesOf(sec.id).length > 1}
              d={d}
            />
          ));

          if (fold) {
            return (
              <FoldedSection key={phase} title={fold} summary={blurb ?? undefined}>
                {blocks}
              </FoldedSection>
            );
          }
          return (
            <div key={phase} className="flex flex-col gap-5">
              {blocks}
            </div>
          );
        })}

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
          {/* No star here on purpose: a ticker the engine refuses to score
              would sit in the watchlist as a row that leads back to this same
              refusal. Watch it once it can be read. */}
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
