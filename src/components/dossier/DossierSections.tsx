import { Card, CardContent } from "@/components/ui/Card";
import { Collapsible } from "@/components/ui/Collapsible";
import { EvidenceModuleDetail } from "@/components/evidence/EvidenceModuleDetail";
import { formatPrice } from "@/lib/utils/format";
import { TRADE_PLAN_REFUSAL_SHORT, TRADE_PLAN_REFUSAL_TEXT } from "@/lib/signals/tradePlan";
import { Depth, EvidenceBullet, EvidenceGroup, InvalidationTrigger, Section, TickerDossier } from "@/lib/dossier/types";
import { MetricVerdict } from "@/lib/signals/types";
import { StructureLadder, LadderMarker } from "@/components/markets/StructureLadder";

/**
 * THE RESEARCH PAGE, SECTION BY SECTION.
 *
 * Reading order is the design: decide, then understand, then verify. A reader
 * who stops after the first screen should still have the trade; a reader who
 * scrolls should be able to check every claim above it.
 *
 * Sections render their own absence. That is the rule that keeps the page
 * honest across assets with wildly different evidence bases — a missing
 * section that simply vanished would be indistinguishable from one that found
 * nothing worth reporting.
 */

/** Shared shell so every section on the page has one visual grammar. */
function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{title}</h2>
          {subtitle && <span className="font-mono text-[10px] text-ink-faint">{subtitle}</span>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * How an unavailable section presents itself.
 *
 * `not-measured-yet` is deliberately styled differently from the rest: it is
 * the one category that is our own backlog rather than a fact about the
 * world, and flattening it into "no data" would let the platform hide its own
 * unfinished work behind the market's limitations.
 */
export function Unavailable({ section }: { section: Extract<Section<unknown>, { status: "unavailable" }> }) {
  const ours = section.blockedBy === "not-measured-yet";
  return (
    <div className={`rounded-md border px-3 py-2.5 ${ours ? "border-amber/20 bg-amber/[0.03]" : "border-hairline bg-void/30"}`}>
      <span
        className={`text-[9px] font-semibold uppercase tracking-[0.14em] ${ours ? "text-amber" : "text-ink-faint"}`}
      >
        {ours
          ? "Not built yet"
          : section.blockedBy === "not-applicable"
            ? "Not applicable"
            : section.blockedBy === "insufficient-history"
              ? "Not enough to go on"
              : section.blockedBy === "provider-error"
                ? "Source unavailable"
                : "No data source"}
      </span>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{section.reason}</p>
    </div>
  );
}

/**
 * THE DEPTH FOOTER — how far a section's intelligence currently goes, and
 * what would deepen it.
 *
 * Rendered identically under every available section that carries a tier, so
 * "measured" versus "descriptive" is a property a reader learns once and
 * recognises everywhere. The upgrade line is the forward-looking half of the
 * honesty contract: the section says not only what it knows, but what it
 * would take to know more — which keeps the page stable while the
 * intelligence behind each slot deepens independently.
 */
const DEPTH_LABEL: Record<Depth, { word: string; meaning: string; tone: string }> = {
  basic: { word: "Descriptive", meaning: "computed from price history; no measured record behind it", tone: "text-ink-faint" },
  advanced: { word: "Measured", meaning: "backed by replayed or multi-instrument data", tone: "text-cyan" },
  institutional: { word: "Validated", meaning: "supported by a forward-tested record", tone: "text-success" },
};

export function DepthMeta({ section }: { section: Extract<Section<unknown>, { status: "available" }> }) {
  const d = DEPTH_LABEL[section.depth];
  return (
    <div className="flex flex-col gap-1 border-t border-hairline pt-2">
      <span className="text-[10px] leading-relaxed text-ink-faint">
        <span className={`font-semibold uppercase tracking-[0.12em] ${d.tone}`}>{d.word}</span>
        <span> · {d.meaning}.</span>
      </span>
      {section.upgrade && (
        <span className="text-[10px] leading-relaxed text-ink-faint">
          <span className="uppercase tracking-[0.12em] text-ink-muted">Deepens when</span> ·{" "}
          {section.upgrade.when}.
        </span>
      )}
    </div>
  );
}

/* ── 1. THE VERDICT ──────────────────────────────────────────────────── */

export function VerdictPanel({ d }: { d: TickerDossier }) {
  const v = d.verdict;
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <div className="flex items-center gap-3">
          <span className="text-4xl leading-none sm:text-5xl" aria-hidden>
            {v.emoji}
          </span>
          <div className="flex flex-col gap-0.5">
            <span className={`text-3xl font-black uppercase leading-none tracking-[0.04em] sm:text-4xl ${v.tone}`}>
              {v.word}
            </span>
            <span className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              {d.identity.symbol} · daily
            </span>
          </div>
        </div>

        <p className="text-[15px] leading-relaxed text-ink">{v.sentence}</p>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline pt-3">
          <Stat label="Strength">
            <span className="font-mono text-sm" aria-label={`${v.stars} out of 5`}>
              {"●".repeat(v.stars)}
              <span className="text-ink-faint">{"○".repeat(5 - v.stars)}</span>
            </span>
          </Stat>
          <Stat label="Evidence">
            <span
              className={`text-sm capitalize ${
                v.evidence === "strong" ? "text-success" : v.evidence === "moderate" ? "text-amber" : "text-danger"
              }`}
            >
              {v.evidence}
            </span>
          </Stat>
          <Stat label="Signals">
            <span className="text-sm text-ink-muted">{v.agreementLine}</span>
          </Stat>
        </div>

        {/* THE HEADLINE'S OWN TRACK RECORD.
            A verdict that never reports how its past verdicts did is asking
            to be believed on presentation alone. Until the record fills it
            says so plainly, which is the more useful state of the two. */}
        {v.forward && (
          <p className="rounded-md border border-hairline bg-void/30 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Track record</span> ·{" "}
            {v.forward.mine ? (
              <>
                Across {v.forward.mine.n.toLocaleString()} past {v.forward.mine.verdict} calls scored{" "}
                {v.forward.horizonSessions} sessions later, price moved the called way{" "}
                {v.forward.mine.hitRatePct !== null && (
                  <span className="font-semibold text-ink">{v.forward.mine.hitRatePct.toFixed(0)}%</span>
                )}{" "}
                of the time, averaging{" "}
                <span className="font-semibold text-ink">
                  {v.forward.mine.meanReturnPct >= 0 ? "+" : ""}
                  {v.forward.mine.meanReturnPct.toFixed(2)}%
                </span>
                {v.forward.mine.edgeVsBaselinePct !== null && v.forward.baselineReturnPct !== null && (
                  <>
                    {" "}against{" "}
                    {v.forward.baselineReturnPct >= 0 ? "+" : ""}
                    {v.forward.baselineReturnPct.toFixed(2)}% for every call in the same windows — an edge of{" "}
                    <span
                      className={`font-semibold ${
                        v.forward.mine.edgeVsBaselinePct > 0 ? "text-success" : "text-danger"
                      }`}
                    >
                      {v.forward.mine.edgeVsBaselinePct >= 0 ? "+" : ""}
                      {v.forward.mine.edgeVsBaselinePct.toFixed(2)}%
                    </span>
                  </>
                )}
                .
              </>
            ) : (
              <>
                This verdict has no scored record yet. {v.forward.open.toLocaleString()} calls are registered and
                waiting out their {v.forward.horizonSessions}-session window; each is scored against what every
                other call did over the same period, so a bullish read only counts as right if it beat the
                market rather than merely rose with it. Until then the word above is a hypothesis.
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      {children}
    </div>
  );
}

/* ── 2. TL;DR ────────────────────────────────────────────────────────── */

export function TldrPanel({ d }: { d: TickerDossier }) {
  return (
    <Panel title="The short version" subtitle="ten seconds">
      <p className="text-[15px] leading-relaxed text-ink">{d.tldr.full}</p>
      <p className="text-[10px] leading-relaxed text-ink-faint">
        Every sentence above is assembled from the readings below — this platform does not generate summaries
        with a language model, so nothing here can describe something the engine did not measure.
      </p>
    </Panel>
  );
}

/* ── 3. THE TRADING PLAN ─────────────────────────────────────────────── */

export function PlanPanel({ d }: { d: TickerDossier }) {
  const { plan, refusal, expectations } = d.plan;
  const bearish = d.bias.verdict === "bearish";

  if (!plan) {
    return (
      <Panel title="Why there is no trade">
        {refusal ? (
          <>
            <p className="text-[14px] leading-relaxed text-ink">{TRADE_PLAN_REFUSAL_SHORT[refusal]}</p>
            <Collapsible title="The full reasoning" summary="why this bar exists at all">
              <p className="text-xs leading-relaxed text-ink-muted">{TRADE_PLAN_REFUSAL_TEXT[refusal]}</p>
            </Collapsible>

            {/* THE EVIDENCE BEHIND THE REFUSAL.
                A refusal that hides its own record asks to be taken on faith.
                When the bar came from a measured bucket, that bucket's numbers
                are the argument — so they are shown here rather than only on
                the plans that survive the gate. */}
            {expectations.status === "available" && (
              <div className="flex flex-col gap-2 rounded-md border border-hairline bg-void/30 px-3 py-2.5">
                <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  What the record actually says
                </span>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                  <PlanStat label="Win rate" value={`${expectations.data.winRatePct.toFixed(0)}%`} />
                  <PlanStat
                    label="Edge over doing nothing"
                    value={
                      expectations.data.excessEvPct === null || expectations.data.excessEvPct === undefined
                        ? `${expectations.data.evLowerPct.toFixed(2)}%`
                        : `${expectations.data.excessEvPct >= 0 ? "+" : ""}${expectations.data.excessEvPct.toFixed(2)}%`
                    }
                    tone={
                      (expectations.data.excessEvPct ?? expectations.data.evLowerPct) > 0
                        ? "text-success"
                        : "text-danger"
                    }
                  />
                  <PlanStat label="Trades behind it" value={expectations.data.n.toLocaleString()} />
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-[14px] leading-relaxed text-ink">
            There is no direction to build a plan on — the evidence for up and the evidence for down roughly
            cancel out.
          </p>
        )}
      </Panel>
    );
  }

  return (
    <Panel title="The plan" subtitle={`${plan.riskRewardRatio.toFixed(1)}× to first target`}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <PlanStat
          label={bearish ? "Sell zone" : "Buy zone"}
          value={`${formatPrice(plan.entryLow)}–${formatPrice(plan.entryHigh)}`}
        />
        <PlanStat label="Get out if it hits" value={formatPrice(plan.stopPrice)} tone="text-danger" />
        <PlanStat label="First target" value={formatPrice(plan.target1Price)} tone="text-success" />
        <PlanStat label="Second target" value={formatPrice(plan.target2Price)} tone="text-success" />
        <PlanStat label="Reward vs risk" value={`${plan.riskRewardRatio.toFixed(1)}×`} />
      </div>

      <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[13px] leading-relaxed text-ink">
        <span className="font-semibold uppercase tracking-[0.12em] text-amber">If it goes wrong</span> · A daily
        close beyond {formatPrice(plan.stopPrice)} means the reason for this trade is gone — not that price
        simply moved.
      </p>

      <p className="text-[12px] leading-relaxed text-ink-muted">
        You risk {formatPrice(Math.abs(plan.entryRef - plan.stopPrice))} per share to make{" "}
        {formatPrice(Math.abs(plan.target1Price - plan.entryRef))} at the first target. Waiting for the zone
        rather than buying here is what produces that ratio; chasing the price changes the trade.
      </p>

      {/* What the replay says about trades like this one — or why it cannot say. */}
      <div className="border-t border-hairline pt-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
          What happened to trades like this before
        </h3>
        {expectations.status === "available" ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <PlanStat label="Win rate" value={`${expectations.data.winRatePct.toFixed(0)}%`} />
            {/* The EXCESS is the edge. Labelling raw expectancy "edge" would
                credit the signal with the market's own drift — measured at
                roughly +0.8% over a two-week hold in this sample. */}
            <PlanStat
              label="Edge over doing nothing"
              value={
                expectations.data.excessEvPct === null || expectations.data.excessEvPct === undefined
                  ? `${expectations.data.evLowerPct.toFixed(2)}%`
                  : `${expectations.data.excessEvPct >= 0 ? "+" : ""}${expectations.data.excessEvPct.toFixed(2)}%`
              }
            />
            <PlanStat label="Typical dip first" value={`${expectations.data.expectedDrawdownPct.toFixed(1)}%`} />
            <PlanStat
              label="How far winners ran"
              value={expectations.data.expectedRunPct === null ? "—" : `${expectations.data.expectedRunPct.toFixed(1)}%`}
            />
            <PlanStat
              label="Typical hold"
              value={
                expectations.data.medianHoldSessions === null
                  ? "—"
                  : `${expectations.data.medianHoldSessions} days`
              }
            />
          </div>
        ) : (
          <Unavailable section={expectations} />
        )}
        {expectations.status === "available" &&
          expectations.data.driftNullPct !== null &&
          expectations.data.driftNullPct !== undefined && (
            <p className="text-[10px] leading-relaxed text-ink-faint">
              Measured over {expectations.data.n.toLocaleString()} comparable historical trades in the same
              direction and volatility regime. &quot;Edge over doing nothing&quot; already subtracts the{" "}
              {expectations.data.driftNullPct >= 0 ? "+" : ""}
              {expectations.data.driftNullPct.toFixed(2)}% a random entry earned over the same holding period —
              in a market that rose, most of a raw expectancy is the market rather than the signal, and only
              what is left over is edge.
            </p>
          )}
        {expectations.status === "available" && <DepthMeta section={expectations} />}
      </div>
    </Panel>
  );
}

function PlanStat({ label, value, tone = "text-ink" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm ${tone}`}>{value}</dd>
    </div>
  );
}

/* ── 4. BULL CASE vs BEAR CASE ────────────────────────────────────────── */

/**
 * The two cases side by side, each absolute.
 *
 * Not "supports it" and "fights it": those were swapped by side so the
 * supporting column always matched the call, which meant the same reading
 * appeared under opposite headings depending on the ticker. Bull and bear are
 * properties of the evidence. The verdict is stated three sections above, and
 * the reader can see for themselves which column it went with.
 */
export function ReasonsPanel({ d }: { d: TickerDossier }) {
  return (
    <Panel title="The bull case and the bear case" subtitle="strongest first">
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        <BulletList
          title="Bull case"
          mark="↑"
          markClass="text-success"
          bullets={d.bullCase}
          empty="Nothing currently argues price rises."
        />
        <BulletList
          title="Bear case"
          mark="↓"
          markClass="text-danger"
          bullets={d.bearCase}
          empty="Nothing currently argues price falls."
        />
      </div>
    </Panel>
  );
}

/* ── 4b. WHY THE ENGINE READS IT THIS WAY ─────────────────────────────── */

/**
 * The category rollups as bars — the engine in one glance.
 *
 * These are the SAME weighted rollups that produce `bias.score`, not a second
 * opinion computed for display. Categories rather than individual readings:
 * relative strength, breadth and momentum sit INSIDE these groups, and
 * showing them as peers of Money Flow would misrepresent what actually
 * carries the composite.
 *
 * The count is read from the data, not asserted. An equity has no Trader
 * Positioning group at all — funding and open interest have no equity
 * equivalent, so that category has no metrics and the engine drops it rather
 * than showing an empty rollup. Hardcoding "four groups" here would have
 * printed a number the page then contradicted three bars later.
 *
 * A category that carries readings but no VOTES still gets a row, labelled
 * "context only" with no bar: a group describing the market without betting
 * on it is a different thing from an absent one, and a zero-length bar would
 * read as neutral — a claim it has not earned.
 */
export function EngineBarsPanel({ d }: { d: TickerDossier }) {
  const groups = d.evidence.length;
  return (
    <Panel
      title="What each group contributed"
      subtitle={`${d.bias.metrics.length} readings · ${groups} ${groups === 1 ? "group" : "groups"}`}
    >
      <div className="flex flex-col gap-3">
        {d.evidence.map((g) => (
          <CategoryBar key={g.label} group={g} metrics={d.bias.metrics} basis={d.bias.basis} />
        ))}
      </div>
    </Panel>
  );
}

/**
 * Score is -100..100 and the bar is centred on neutral, so a bar's DIRECTION
 * is visible without reading the label. Mapping it to a 0-100 fill would make
 * a strongly bearish category look identical to a strongly bullish one.
 */
function CategoryBar({
  group,
  metrics,
  basis,
}: {
  group: EvidenceGroup;
  metrics: MetricVerdict[];
  basis: "edge" | "state";
}) {
  const tone =
    group.verdict === "bullish" ? "text-success" : group.verdict === "bearish" ? "text-danger" : "text-ink-muted";
  const fill =
    group.verdict === "bullish" ? "bg-success/60" : group.verdict === "bearish" ? "bg-danger/60" : "bg-ink-faint/40";
  const magnitude = group.score === null ? 0 : Math.min(100, Math.abs(group.score));

  return (
    <details className="group/bar rounded-md border border-hairline bg-void/30 px-3 py-2.5">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink">{group.label}</span>
          <span className={`font-mono text-[11px] ${tone}`}>
            {group.score === null ? "context only" : `${group.verdict} · ${group.score}`}
          </span>
        </div>

        {/* Centre line at neutral; the bar grows left for bearish, right for bullish. */}
        <div className="relative mt-2 h-1.5 w-full rounded-full bg-void/60">
          <div className="absolute inset-y-0 left-1/2 w-px bg-hairline" aria-hidden />
          {group.score !== null && (
            <div
              className={`absolute inset-y-0 rounded-full ${fill}`}
              style={
                group.score >= 0
                  ? { left: "50%", width: `${magnitude / 2}%` }
                  : { right: "50%", width: `${magnitude / 2}%` }
              }
            />
          )}
        </div>

        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{group.topReason}</p>
      </summary>

      <ul className="mt-3 flex flex-col gap-4 border-t border-hairline pt-3">
        {group.metrics.map((m) => (
          <li key={m.id} className="border-l border-hairline pl-3">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">{m.label}</h4>
            <EvidenceModuleDetail metric={m} allMetrics={metrics} basis={basis} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function BulletList({
  title,
  mark,
  markClass,
  bullets,
  empty,
}: {
  title: string;
  mark: string;
  markClass: string;
  bullets: EvidenceBullet[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">{title}</h3>
      {bullets.length === 0 ? (
        <p className="mt-2 text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2.5">
          {bullets.map((b) => (
            <li key={b.metricId} className="flex items-start gap-2">
              <span aria-hidden className={`mt-0.5 shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span className="text-[12px] leading-relaxed">
                <span className="text-ink">{b.claim}</span>
                <span className="text-ink-faint"> · {b.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── 5. WHAT CHANGES MY OPINION ──────────────────────────────────────── */

const TRIGGER_LABEL: Record<InvalidationTrigger["kind"], string> = {
  price: "Price",
  evidence: "Evidence",
  event: "Event",
};

export function InvalidationPanel({ d }: { d: TickerDossier }) {
  if (d.invalidation.length === 0) return null;
  return (
    <Panel title="What changes my opinion" subtitle="decided in advance">
      <ul className="flex flex-col gap-3">
        {d.invalidation.map((t) => (
          <li key={t.condition} className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-ink-faint">
              {TRIGGER_LABEL[t.kind]}
            </span>
            <span className="text-[12px] leading-relaxed">
              <span className="text-ink">{t.condition}</span>
              <span className="text-ink-faint"> — {t.consequence}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ── 6. SIMILAR HISTORICAL SETUPS ────────────────────────────────────── */

export function AnalogsPanel({ d }: { d: TickerDossier }) {
  const a = d.analogs;
  return (
    <Panel title="Similar historical setups">
      {a.status === "available" ? (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <PlanStat label="Times seen" value={`${a.data.occurrences}`} />
            <PlanStat label="Win rate" value={`${a.data.winRatePct.toFixed(0)}%`} />
            {/* MEDIAN AND AVERAGE TOGETHER, always.
                These setups are skewed: the typical trade loses a little and
                the profit lives in the tail. Showing the median alone reads as
                a losing strategy; showing the average alone hides that most
                individual trades disappoint. Both, side by side, is the only
                honest summary of a distribution shaped like this. */}
            <PlanStat
              label="Typical (median)"
              value={`${a.data.medianReturnPct >= 0 ? "+" : ""}${a.data.medianReturnPct.toFixed(1)}%`}
              tone={a.data.medianReturnPct >= 0 ? "text-success" : "text-danger"}
            />
            <PlanStat
              label="Average"
              value={`${a.data.averageReturnPct >= 0 ? "+" : ""}${a.data.averageReturnPct.toFixed(1)}%`}
              tone={a.data.averageReturnPct >= 0 ? "text-success" : "text-danger"}
            />
            <PlanStat
              label="Typical dip first"
              value={a.data.averageDrawdownPct === null ? "—" : `${a.data.averageDrawdownPct.toFixed(1)}%`}
            />
            <PlanStat
              label="Typical hold"
              value={a.data.medianHoldSessions === null ? "—" : `${a.data.medianHoldSessions} days`}
            />
          </div>
          {a.data.medianReturnPct < 0 && a.data.averageReturnPct > 0 && (
            <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[12px] leading-relaxed text-ink">
              <span className="font-semibold uppercase tracking-[0.12em] text-amber">Read this carefully</span> ·
              The typical setup like this one LOST {Math.abs(a.data.medianReturnPct).toFixed(1)}%, yet the
              average came out positive. That means the profit lives in a minority of large winners, not in most
              trades working. Position for a run of small losses, and do not size as though the average is what
              usually happens.
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Matched on ·</span> {a.data.matchBasis} {a.data.caveat}
          </p>
          <DepthMeta section={a} />
        </>
      ) : (
        <Unavailable section={a} />
      )}
    </Panel>
  );
}

/* ── 7. MACRO CONTEXT ────────────────────────────────────────────────── */

export function MacroPanel({ d }: { d: TickerDossier }) {
  const m = d.macro;
  return (
    <Panel title="The tape it trades in" subtitle="inherited automatically">
      {m.status === "available" ? (
        <>
          <p className="text-[14px] leading-relaxed text-ink">{m.data.summary}</p>
          <ul className="flex flex-col gap-1.5 border-t border-hairline pt-3">
            <li className="text-[12px] leading-relaxed text-ink-muted">
              <span className="text-ink">Risk environment · </span>
              {m.data.regimeDetail}
            </li>
            {m.data.sectorLine && (
              <li className="text-[12px] leading-relaxed text-ink-muted">
                <span className="text-ink">Sector · </span>
                {m.data.sectorLine}
              </li>
            )}
            {m.data.industryLine && (
              <li className="text-[12px] leading-relaxed text-ink-muted">
                <span className="text-ink">Industry · </span>
                {m.data.industryLine}
              </li>
            )}
          </ul>
          {m.data.backdropLines && m.data.backdropLines.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-hairline pt-3">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                The wider forces
              </h3>
              {m.data.backdropLines.map((line) => (
                <p key={line.slice(0, 40)} className="text-[12px] leading-relaxed text-ink-muted">
                  {line}
                </p>
              ))}
            </div>
          )}
          <DepthMeta section={m} />
        </>
      ) : (
        <Unavailable section={m} />
      )}
    </Panel>
  );
}

/* ── PRICE LEVELS ────────────────────────────────────────────────────── */

/**
 * Extracted from the page so the page can be manifest-driven: every section
 * the manifest names has a component here, and the page maps ids to
 * components without knowing what any of them need.
 */
export function LevelsPanel({ d }: { d: TickerDossier }) {
  const markers: LadderMarker[] = d.plan.plan
    ? [
        { label: "Entry", price: d.plan.plan.entryRef, tone: "entry" },
        { label: "Stop", price: d.plan.plan.stopPrice, tone: "stop" },
        { label: "T1", price: d.plan.plan.target1Price, tone: "target" },
        { label: "T2", price: d.plan.plan.target2Price, tone: "target" },
      ]
    : [];

  return (
    <Panel title="Price levels that matter">
      <p className="text-[12px] leading-relaxed text-ink-muted">
        Where price sits against the levels it has repeatedly reacted to. A level is only meaningful because
        buyers or sellers have defended it before.
      </p>
      <StructureLadder zones={d.zones} currentPrice={d.identity.lastClose} markers={markers} atrPct={d.atrPct} />
      <p className="text-[11px] leading-relaxed text-ink-faint">
        <span className="text-ink-muted">Typical daily move · </span>
        {d.atrPct === null
          ? "not measurable from the available history."
          : `${d.atrPct.toFixed(2)}% of price. A stop closer than that would be hit by ordinary movement rather than by the idea being wrong.`}
      </p>
    </Panel>
  );
}

/* ── 8. THE EVIDENCE DASHBOARD ───────────────────────────────────────── */

/**
 * Every reading, flat and in full.
 *
 * The category grid that used to head this section now leads the page as
 * `EngineBarsPanel` — keeping both would have shown the same four rollups
 * twice, once as the summary and once as a duplicate below it. What remains
 * is the thing this section is actually for: the complete list, in one place,
 * for a reader who wants to audit rather than to decide.
 */
export function EvidencePanel({ d }: { d: TickerDossier }) {
  return (
    <Panel title="Every reading in full" subtitle={`${d.bias.metrics.length} readings`}>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Each measurement, its confidence, and the level that would flip it. The four groups these roll up into
        are above, under &ldquo;why the engine reads it this way&rdquo;.
      </p>
      <ul className="flex flex-col gap-5 pt-1">
        {d.bias.metrics.map((m) => (
          <li key={m.id} className="border-l border-hairline pl-4">
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink">{m.label}</h4>
            <EvidenceModuleDetail metric={m} allMetrics={d.bias.metrics} basis={d.bias.basis} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ── 9. WHAT THIS PAGE CANNOT SEE ────────────────────────────────────── */

/**
 * The declared gaps, gathered in one place.
 *
 * Kept as a single section rather than scattered empty cards: five separate
 * "no data" panels would be noise, while one honest inventory is a feature —
 * it tells a reader exactly how far to trust the page, and it is the roadmap.
 */
export function GapsPanel({ d }: { d: TickerDossier }) {
  const gaps: Array<{ label: string; section: Section<unknown> }> = [
    { label: "Money flow (single-name)", section: d.moneyFlow },
    { label: "News", section: d.news },
    { label: "Social & search interest", section: d.socialSentiment },
    { label: "Options & gamma", section: d.optionsFlow },
    { label: "What the options market is pricing", section: d.optionsIntel },
    { label: "Insider buying", section: d.insiderActivity },
    { label: "Short interest", section: d.shortInterest },
  ].filter((g) => g.section.status === "unavailable");

  if (gaps.length === 0) return null;

  return (
    <Panel title="What this page cannot see" subtitle={`${gaps.length} gaps, named`}>
      <p className="text-[12px] leading-relaxed text-ink-muted">
        An empty section and a quiet market look identical, so nothing here is left blank. Amber items are our
        own unfinished work rather than a limit of the data.
      </p>
      <div className="flex flex-col gap-2">
        {gaps.map((g) => (
          <div key={g.label}>
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">{g.label}</span>
            <div className="mt-1">
              <Unavailable section={g.section as Extract<Section<unknown>, { status: "unavailable" }>} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ── OPTIONS & GAMMA ─────────────────────────────────────────────────── */

/**
 * The provider-backed panels below render only when their section is
 * AVAILABLE. Absence is deliberately not rendered here — it is the
 * GapsPanel's job, so the page has exactly one place that speaks about
 * missing data instead of five half-empty cards saying it five ways.
 */
export function OptionsPanel({ d }: { d: TickerDossier }) {
  const s = d.optionsFlow;
  if (s.status !== "available") return null;
  const o = s.data;

  const oiLean =
    o.putCallOiRatio > 1.2
      ? "put-heavy — more standing bets on downside than upside"
      : o.putCallOiRatio < 0.7
        ? "call-heavy — more standing bets on upside than downside"
        : "roughly balanced between puts and calls";

  return (
    <Panel title="Options positioning" subtitle={`${o.contractCount.toLocaleString()} contracts · CBOE, delayed`}>
      <p className="text-[13px] leading-relaxed text-ink">
        Open interest is {oiLean} (put/call ratio {o.putCallOiRatio.toFixed(2)}).{" "}
        {o.atmIvPct !== null &&
          `Options nearest the current price imply a ${o.atmIvPct.toFixed(0)}% annualised move — the market's own volatility bet.`}{" "}
        {o.netGexUsdPer1Pct !== null &&
          (o.netGexUsdPer1Pct > 0
            ? "Net dealer gamma is positive, which under the standard convention means hedging flows dampen moves — dips get bought, rips get sold."
            : "Net dealer gamma is negative, which under the standard convention means hedging flows amplify moves in both directions.")}
      </p>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <PlanStat label="Put/call (open interest)" value={o.putCallOiRatio.toFixed(2)} />
        <PlanStat
          label="Put/call (today's volume)"
          value={o.putCallVolumeRatio === null ? "—" : o.putCallVolumeRatio.toFixed(2)}
        />
        <PlanStat label="Implied move (ATM IV)" value={o.atmIvPct === null ? "—" : `${o.atmIvPct.toFixed(0)}%`} />
        <PlanStat
          label="Net gamma / 1% move"
          value={
            o.netGexUsdPer1Pct === null
              ? "—"
              : `${o.netGexUsdPer1Pct >= 0 ? "+" : "−"}$${Math.abs(o.netGexUsdPer1Pct / 1e6).toFixed(1)}m`
          }
        />
      </div>

      {/* THE SIGNAL — today's flow read against the standing book, which is
          the baseline a single snapshot can honestly support. */}
      <p
        className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
          o.openingFlow.hotStrikes.length > 0
            ? "border-cyan/25 bg-cyan/[0.04] text-ink"
            : "border-hairline bg-void/30 text-ink-muted"
        }`}
      >
        <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Opening flow</span> ·{" "}
        {o.openingFlow.signalLine}
      </p>

      {o.largestOiStrikes.length > 0 && (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          <span className="text-ink">Where positions concentrate · </span>
          {o.largestOiStrikes
            .map((x) => `${formatPrice(x.strike)} ${x.kind}s (${x.openInterest.toLocaleString()} contracts, ${x.expiry})`)
            .join(" · ")}
          . Heavy strikes act like magnets into expiry because hedging flows pin price near them.
        </p>
      )}

      {/* SECOND VENUE — corroboration or contest, when a second chain answered.
          Amber on ANY substantive disagreement (a materially different implied
          vol, opposed gamma signs, or a mismatched OCC feed), because a
          disagreement rendered in neutral grey is a disagreement nobody reads. */}
      {o.crossVenue && (
        <p
          className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
            o.crossVenue.ivAgree === false ||
            o.crossVenue.gexAgree === false ||
            o.crossVenue.openInterestIdentical === false
              ? "border-amber/25 bg-amber/[0.04] text-ink"
              : o.crossVenue.comparisons > 0 && o.crossVenue.agreements === o.crossVenue.comparisons
                ? "border-success/25 bg-success/[0.04] text-ink"
                : "border-hairline bg-void/30 text-ink-muted"
          }`}
        >
          <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Second venue</span> ·{" "}
          {o.crossVenue.line}
        </p>
      )}

      <p className="text-[10px] leading-relaxed text-ink-faint">{o.gexCaveat}</p>
      <DepthMeta section={s} />
    </Panel>
  );
}

/* ── WHAT THE OPTIONS MARKET IS PRICING ──────────────────────────────── */

/**
 * The chain read as a set of forward statements rather than a table.
 *
 * The lead is the expected move against the plan's own first target, because
 * that is the one comparison that can change what a reader does: a target
 * beyond what the whole chain prices for the period is not optimistic, it is
 * a different bet — one that needs volatility to expand, not just direction
 * to be right. Everything below it is ordered the same way, interpretation
 * first and the number that produced it alongside.
 */
export function OptionsIntelPanel({ d }: { d: TickerDossier }) {
  const s = d.optionsIntel;
  if (s.status !== "available") return null;
  const o = s.data;

  return (
    <Panel
      title="What the options market is pricing"
      subtitle={`${o.horizonExpiry ?? o.frontExpiry} · Tradier, delayed · ${o.confidence}% of the read available`}
    >
      <p className="text-[13px] font-medium leading-relaxed text-ink">{o.summary}</p>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <PlanStat
          label="Expected move"
          value={o.expectedMovePct === null ? "—" : `±${o.expectedMovePct.toFixed(1)}%`}
        />
        {/* The realised figure shown is the one the verdict was MEASURED
            against, so the stat and the sentence beneath it can never quote
            different numbers. When a single session was set aside, the label
            says so rather than showing a figure with no explanation. */}
        <PlanStat
          label={o.realizedVolJumpDominated ? "Implied vs realised (ex-gap)" : "Implied vs realised"}
          value={
            o.atmIvPct === null || o.realizedVolPct === null
              ? "—"
              : `${o.atmIvPct.toFixed(0)}% vs ${(o.realizedVolJumpDominated ? o.realizedVolExJumpPct! : o.realizedVolPct).toFixed(0)}%`
          }
          tone={o.ivMinusRvPct === null ? "text-ink" : o.ivMinusRvPct > 5 ? "text-amber" : "text-ink"}
        />
        <PlanStat
          label="Put/call skew"
          value={o.skewPct === null ? "—" : `${o.skewPct >= 0 ? "+" : "−"}${Math.abs(o.skewPct).toFixed(1)} pts`}
        />
        <PlanStat
          label="Option liquidity"
          value={o.liquidityScore === null ? "—" : `${o.liquidityScore}/100`}
          tone={o.liquidityScore !== null && o.liquidityScore < 45 ? "text-amber" : "text-ink"}
        />
      </div>

      {/* THE WHY. Each line names the figure it came from. */}
      <ul className="flex flex-col gap-2">
        {o.lines.map((line) => (
          <li key={line} className="text-[12px] leading-relaxed text-ink-muted">
            <span className="mr-1.5 text-ink-faint">·</span>
            {line}
          </li>
        ))}
      </ul>

      {/* AGREEMENT — the only thing here that contests the decision above, so
          it is the only thing here allowed to be loud. */}
      {o.agreesWithEngine !== null && (
        <p
          className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
            o.agreesWithEngine
              ? "border-success/25 bg-success/[0.04] text-ink"
              : "border-amber/25 bg-amber/[0.04] text-ink"
          }`}
        >
          <span
            className={`font-semibold uppercase tracking-[0.12em] ${o.agreesWithEngine ? "text-success" : "text-amber"}`}
          >
            {o.agreesWithEngine ? "Options agree" : "Options disagree"}
          </span>{" "}
          · Positioning leans {o.optionsLean} against the engine&rsquo;s read of the chart.
        </p>
      )}

      {o.gammaWalls.length > 0 && (
        <p className="text-[11px] leading-relaxed text-ink-muted">
          <span className="text-ink">Where hedging concentrates · </span>
          {o.gammaWalls
            .map(
              (w) =>
                `${formatPrice(w.strike)} ${w.kind}s (${w.distancePct >= 0 ? "+" : ""}${w.distancePct.toFixed(1)}%)`
            )
            .join(" · ")}
        </p>
      )}

      {/* THE HONEST BLANK. Named rather than approximated, because the
          obvious approximation answers a different question in the same
          words — see the module header. */}
      <p className="text-[10px] leading-relaxed text-ink-faint">
        <span className="uppercase tracking-[0.12em] text-ink-muted">Not measurable yet</span> · IV rank and IV
        percentile. {o.ivHistoryRequirement}
      </p>

      {o.caveats.map((c) => (
        <p key={c} className="text-[10px] leading-relaxed text-ink-faint">
          {c}
        </p>
      ))}

      <DepthMeta section={s} />
    </Panel>
  );
}

/* ── OWNERSHIP: INSIDERS + SHORT VOLUME ──────────────────────────────── */

export function OwnershipPanel({ d }: { d: TickerDossier }) {
  const ins = d.insiderActivity;
  const sv = d.shortInterest;
  if (ins.status !== "available" && sv.status !== "available") return null;

  return (
    <Panel title="Who is buying and who is betting against" subtitle="filings & regulatory data">
      {ins.status === "available" && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Insider trading · last {ins.data.windowDays} days · SEC filings
          </h3>
          {/* THE SIGNAL leads: the cluster classification is the baseline
              that makes a pile of filings mean something. */}
          <p
            className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
              ins.data.cluster === "cluster-buying"
                ? "border-success/25 bg-success/[0.04] text-ink"
                : "border-hairline bg-void/30 text-ink-muted"
            }`}
          >
            {ins.data.signalLine}
          </p>
          {(ins.data.buys.transactions > 0 || ins.data.sells.transactions > 0) && (
            <>
              <p className="text-[12px] leading-relaxed text-ink-muted">
                {ins.data.buys.transactions > 0
                  ? `${ins.data.buys.transactions} purchase${ins.data.buys.transactions === 1 ? "" : "s"} totalling ${ins.data.buys.shares.toLocaleString()} shares${ins.data.buys.valueUsd !== null ? ` (about $${Math.round(ins.data.buys.valueUsd).toLocaleString()})` : ""} across ${ins.data.distinctBuyers} insider${ins.data.distinctBuyers === 1 ? "" : "s"}.`
                  : "No open-market purchases."}{" "}
                {ins.data.sells.transactions > 0
                  ? `${ins.data.sells.shares.toLocaleString()} shares sold across ${ins.data.sells.transactions} sale${ins.data.sells.transactions === 1 ? "" : "s"}${ins.data.sells.valueUsd !== null ? ` (about $${Math.round(ins.data.sells.valueUsd).toLocaleString()})` : ""}.`
                  : "No open-market sales."}
              </p>
              <p className="text-[10px] leading-relaxed text-ink-faint">{ins.data.asymmetryNote}</p>
            </>
          )}
          <DepthMeta section={ins} />
        </div>
      )}

      {sv.status === "available" && (
        <div className={`flex flex-col gap-2 ${ins.status === "available" ? "border-t border-hairline pt-3" : ""}`}>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Short-sale volume · FINRA · {sv.data.latest.date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}
          </h3>
          {/* THE SIGNAL: today against this symbol's own recent sessions. The
              level alone was the old display; the position is the read. */}
          {sv.data.baseline ? (
            <p
              className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
                sv.data.baseline.percentile >= 80 || sv.data.baseline.percentile <= 20
                  ? "border-cyan/25 bg-cyan/[0.04] text-ink"
                  : "border-hairline bg-void/30 text-ink-muted"
              }`}
            >
              {sv.data.baseline.signalLine}
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Too few recent sessions could be fetched to compare today against this symbol&apos;s own norm, so
              only the raw figure is shown.
            </p>
          )}
          <p className="text-[12px] leading-relaxed text-ink-muted">
            {sv.data.latest.shortRatioPct.toFixed(0)}% of the day&apos;s FINRA-reported volume printed as short
            sales ({Math.round(sv.data.latest.shortVolume).toLocaleString()} of{" "}
            {Math.round(sv.data.latest.totalVolume).toLocaleString()} shares).
          </p>
          <p className="text-[10px] leading-relaxed text-ink-faint">{sv.data.meaningNote}</p>
          <DepthMeta section={sv} />
        </div>
      )}
    </Panel>
  );
}

/* ── ATTENTION: NEWS + SOCIAL ────────────────────────────────────────── */

export function AttentionPanel({ d }: { d: TickerDossier }) {
  const news = d.news;
  const social = d.socialSentiment;
  if (news.status !== "available" && social.status !== "available") return null;

  return (
    <Panel title="News & crowd attention" subtitle="reported, not judged">
      {news.status === "available" && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Recent coverage · {news.data.recentCount} of {news.data.items.length} stories in the last 48h
          </h3>
          <ul className="flex flex-col gap-1.5">
            {news.data.items.slice(0, 6).map((n) => (
              <li key={n.url} className="text-[12px] leading-relaxed">
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-ink hover:text-cyan">
                  {n.title}
                </a>
                <span className="text-ink-faint">
                  {" "}
                  · {n.publisher} · {new Date(n.publishedAt).toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] leading-relaxed text-ink-faint">{news.data.classificationNote}</p>
          <DepthMeta section={news} />
        </div>
      )}

      {social.status === "available" && (
        <div className={`flex flex-col gap-2 ${news.status === "available" ? "border-t border-hairline pt-3" : ""}`}>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Trader chatter · {social.data.source}
          </h3>
          <p className="text-[13px] leading-relaxed text-ink">
            {social.data.sampleSize} recent messages
            {social.data.sampleSpanHours !== null && ` over about ${social.data.sampleSpanHours} hours`}.{" "}
            {social.data.bullishPctOfTagged !== null
              ? `Of the ${social.data.taggedCount} posters who tagged a direction, ${social.data.bullishPctOfTagged}% tagged bullish.`
              : `Only ${social.data.taggedCount} posters tagged a direction — too few for a percentage to mean anything.`}
          </p>
          <p className="text-[10px] leading-relaxed text-ink-faint">{social.data.selfReportNote}</p>
          <DepthMeta section={social} />
        </div>
      )}
    </Panel>
  );
}

/* ── THE BUSINESS: SEC FUNDAMENTALS ──────────────────────────────────── */

export function BusinessPanel({ d }: { d: TickerDossier }) {
  const s = d.business;
  if (s.status !== "available") return null;
  const f = s.data;

  return (
    <Panel
      title="The business underneath"
      subtitle={`audited SEC filings · ${f.quartersCovered} quarters through ${f.latestFrame ?? "—"}`}
    >
      <div className="flex flex-col gap-2">
        {f.lines.map((line) => (
          <p key={line.slice(0, 40)} className="text-[13px] leading-relaxed text-ink">
            {line}
          </p>
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-ink-faint">
        Growth, margin and share count are arithmetic on audited numbers. No valuation verdict is offered —
        &quot;cheap&quot; and &quot;expensive&quot; need assumptions nobody can verify, and this page does not
        print unverifiable claims.
      </p>
      <DepthMeta section={s} />
    </Panel>
  );
}

/* ── THE STREET: ANALYST CONSENSUS ───────────────────────────────────── */

export function StreetPanel({ d }: { d: TickerDossier }) {
  const s = d.street;
  if (s.status !== "available") return null;
  const v = s.data;

  return (
    <Panel title="What Wall Street thinks" subtitle="reported opinion, labelled as such">
      <div className="flex flex-col gap-2">
        {v.lines.map((line) => (
          <p key={line.slice(0, 40)} className="text-[13px] leading-relaxed text-ink">
            {line}
          </p>
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-ink-faint">{v.herdingCaveat}</p>
      <DepthMeta section={s} />
    </Panel>
  );
}

/* ── WHERE THIS BECOMES A TRADE ──────────────────────────────────────── */

const SETUP_STATUS: Record<string, { label: string; tone: string; ring: string }> = {
  "at-entry": { label: "In the zone now", tone: "text-success", ring: "border-success/30 bg-success/[0.05]" },
  approaching: { label: "Close — watch it", tone: "text-amber", ring: "border-amber/25 bg-amber/[0.04]" },
  waiting: { label: "Waiting", tone: "text-ink-muted", ring: "border-hairline bg-void/30" },
  invalidated: { label: "Level broken", tone: "text-danger", ring: "border-danger/25 bg-danger/[0.04]" },
};

export function NextEntryPanel({ d }: { d: TickerDossier }) {
  const s = d.nextEntry;

  return (
    <Panel title="Where this becomes a trade" subtitle="levels to wait for">
      {s.status === "available" ? (
        <>
          <p className="text-[13px] leading-relaxed text-ink-muted">{s.data.rationale}</p>

          {s.data.entries.map((e) => {
            const st = SETUP_STATUS[e.status] ?? SETUP_STATUS.waiting;
            const isLong = e.direction === "long";
            return (
              <div key={e.direction} className={`flex flex-col gap-2.5 rounded-md border px-3 py-3 ${st.ring}`}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={`text-[13px] font-semibold uppercase tracking-[0.1em] ${isLong ? "text-success" : "text-danger"}`}>
                    {isLong ? "Buy the dip into support" : "Sell the rally into resistance"}
                  </span>
                  <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${st.tone}`}>{st.label}</span>
                  {e.primary && (
                    <span className="text-[9px] uppercase tracking-[0.14em] text-cyan">Favoured side</span>
                  )}
                </div>

                {/* The level is real either way; whether the trade from it
                    clears the quality bars is a separate, stated fact. */}
                {!e.qualifies && e.blockedReason && (
                  <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-ink">
                    <span className="font-semibold uppercase tracking-[0.12em] text-amber">Not yet a trade</span> ·{" "}
                    {e.blockedReason} The level below is still where to watch — it just has to improve before it
                    is worth taking.
                  </p>
                )}

                <p className="text-[13px] leading-relaxed text-ink">
                  {e.trigger}
                  {e.triggerPrice !== null && <> Level: <span className="font-semibold">{formatPrice(e.triggerPrice)}</span>.</>}
                </p>

                <div className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
                  <PlanStat label={isLong ? "Buy zone" : "Sell zone"} value={`${formatPrice(e.entryLow)}–${formatPrice(e.entryHigh)}`} />
                  <PlanStat label="Get out if it hits" value={formatPrice(e.stopPrice)} tone="text-danger" />
                  <PlanStat label="Risk from entry" value={`${e.riskPct.toFixed(1)}%`} />
                  <PlanStat
                    label="First target"
                    value={`${formatPrice(e.target1Price)} (+${e.target1Pct.toFixed(1)}%)`}
                    tone="text-success"
                  />
                  <PlanStat
                    label="Second target"
                    value={`${formatPrice(e.target2Price)} (+${e.target2Pct.toFixed(1)}%)`}
                    tone="text-success"
                  />
                  <PlanStat label="Reward vs risk" value={`${e.riskRewardRatio.toFixed(1)}×`} />
                </div>

                <p className="text-[11px] leading-relaxed text-ink-faint">
                  <span className="text-ink-muted">Entry ·</span> {e.entryBasis}. <span className="text-ink-muted">Stop ·</span> {e.stopBasis}.
                </p>

                {/* WILL PRICE EVEN GET THERE? The question a level to wait for
                    lives or dies on — measured, not assumed. */}
                {e.reach && (
                  <p
                    className={`rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed ${
                      e.reach.reachRatePct >= 60
                        ? "border-success/25 bg-success/[0.04] text-ink"
                        : e.reach.reachRatePct >= 35
                          ? "border-hairline bg-void/30 text-ink"
                          : "border-amber/25 bg-amber/[0.04] text-ink"
                    }`}
                  >
                    <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Odds of getting there</span>{" "}
                    · A level {e.reach.distanceAtr.toFixed(1)}× a typical day&apos;s range away was reached{" "}
                    <span className="font-semibold">{e.reach.reachRatePct.toFixed(0)}%</span> of the time within
                    ten sessions
                    {e.reach.medianSessionsToReach !== null && (
                      <>, typically in {e.reach.medianSessionsToReach}{" "}
                        {e.reach.medianSessionsToReach === 1 ? "session" : "sessions"}</>
                    )}
                    , across {e.reach.attempts.toLocaleString()} historical attempts.
                    {e.reach.reachRatePct < 35 && " Most setups like this never fill — plan for the wait to be wasted."}
                  </p>
                )}

                {/* The record for entries taken THIS way — so a level to wait
                    for arrives with evidence rather than as a bare number. */}
                {e.record && e.target1Pct > Math.abs(e.record.averageReturnPct) * 3 && (
                  <p className="text-[11px] leading-relaxed text-amber">
                    The first target is {e.target1Pct.toFixed(1)}% away, while comparable trades averaged{" "}
                    {e.record.averageReturnPct >= 0 ? "+" : ""}
                    {e.record.averageReturnPct.toFixed(1)}%. That level is where structure sits, not where
                    trades like this one usually get to — treat it as a ceiling, not an expectation.
                  </p>
                )}

                {e.record && (
                  <p className="border-t border-hairline pt-2 text-[11px] leading-relaxed text-ink-muted">
                    <span className="text-ink">If it gets there · </span>
                    {e.record.occurrences.toLocaleString()} comparable entries historically won{" "}
                    {e.record.winRatePct.toFixed(0)}% of the time, with a typical trade of{" "}
                    {e.record.medianReturnPct >= 0 ? "+" : ""}
                    {e.record.medianReturnPct.toFixed(1)}% and an average of{" "}
                    {e.record.averageReturnPct >= 0 ? "+" : ""}
                    {e.record.averageReturnPct.toFixed(1)}%
                    {e.record.medianHoldSessions !== null && <> over about {e.record.medianHoldSessions} sessions</>}.
                  </p>
                )}
              </div>
            );
          })}

          {/* ALWAYS A PRICE TO WATCH. Structure exists on both sides of price
              at all times; only the ability to price a stop against it comes
              and goes. These render whether or not a full plan could be
              built, so the card never bottoms out in "nothing to do". */}
          {s.data.watchLevels.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                {s.data.entries.length > 0 ? "The next levels beyond these" : "The levels to watch"}
              </h3>
              {s.data.watchLevels.map((w) => (
                <div
                  key={w.direction}
                  className="flex flex-col gap-1 rounded-md border border-hairline bg-void/30 px-3 py-2"
                >
                  <p className="text-[13px] leading-relaxed text-ink">
                    <span className={`font-semibold ${w.direction === "long" ? "text-success" : "text-danger"}`}>
                      {w.direction === "long" ? "Next support" : "Next resistance"} {formatPrice(w.price)}
                    </span>{" "}
                    — {w.distancePct.toFixed(1)}% {w.direction === "long" ? "below" : "above"} here (
                    {w.distanceAtr.toFixed(1)}× a typical day&apos;s range)
                    {w.touches > 0 && <>, held {w.touches} {w.touches === 1 ? "time" : "times"} before</>}.
                  </p>
                  {w.reachRatePct !== null ? (
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      Price reached levels this far{" "}
                      <span className="font-semibold text-ink">{w.reachRatePct.toFixed(0)}%</span> of the time
                      within ten sessions
                      {w.medianSessionsToReach !== null && <>, typically after {w.medianSessionsToReach} sessions</>}
                      {w.reachAttempts !== null && <> ({w.reachAttempts.toLocaleString()} historical attempts)</>}.
                      {w.reachRatePct < 20 &&
                        " At this distance price rarely arrives inside two weeks — this is a level to diary, not to wait at."}
                    </p>
                  ) : (
                    <p className="text-[11px] leading-relaxed text-ink-faint">
                      No measured hit rate at this distance — too few historical attempts that far out to quote
                      one honestly.
                    </p>
                  )}
                  <p className="text-[10px] leading-relaxed text-ink-faint">
                    No stop or target is priced from here on purpose: volatility and structure both change on
                    the way, so a stop placed for a level this far out would be arithmetic pretending to be a
                    plan. The full plan prices itself when price arrives.
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* THE ONE OUT-OF-SAMPLE LINE ON THIS PAGE.
              Everything else here was measured on a history that already
              existed when the rule was written. This is the score of
              predictions made BEFORE the outcome — and it says "nothing yet"
              until it has earned the right to say anything else. */}
          {s.data.forward && (
            <p
              className={`rounded-md border px-3 py-2 text-[11px] leading-relaxed ${
                s.data.forward.resolved === 0
                  ? "border-hairline bg-void/30 text-ink-muted"
                  : "border-cyan/25 bg-cyan/[0.04] text-ink"
              }`}
            >
              <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Forward record</span> ·{" "}
              {s.data.forward.resolved === 0 ? (
                <>
                  The rates above come from replayed history, which already existed when the rule was written.
                  Live predictions are now being registered daily
                  {s.data.forward.since && <> (since {s.data.forward.since})</>} and scored ten sessions later.
                  None has finished its window yet — until they do, treat every number on this page as a
                  hypothesis rather than a track record.
                </>
              ) : (
                <>
                  Of {s.data.forward.resolved.toLocaleString()} predictions registered before the outcome was
                  known, this page promised{" "}
                  <span className="font-semibold">{s.data.forward.predictedPct?.toFixed(1)}%</span> and delivered{" "}
                  <span className="font-semibold">{s.data.forward.observedPct?.toFixed(1)}%</span>. That is the
                  only number here measured out of sample.
                </>
              )}
            </p>
          )}

          <p className="text-[10px] leading-relaxed text-ink-faint">
            Distance is what decides whether a level gets revisited. How many times price has already turned
            there was measured and made no difference — at half a day&apos;s range away, levels with no prior
            touches were reached 87.7% of the time and levels with six or more 87.9%. A heavily-tested level is
            not a more likely one; it is only a better-defined one.
          </p>
          <p className="text-[10px] leading-relaxed text-ink-faint">
            These levels are frozen against the last daily close — they do not move as price does. Only the
            status and the distance change intraday, so an order placed from them stays the order that was
            described.
          </p>
          <DepthMeta section={s} />
        </>
      ) : (
        <Unavailable section={s} />
      )}
    </Panel>
  );
}
