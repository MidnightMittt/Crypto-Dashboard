import { Card, CardContent } from "@/components/ui/Card";
import { Collapsible } from "@/components/ui/Collapsible";
import { EvidenceModuleDetail } from "@/components/evidence/EvidenceModuleDetail";
import { formatPrice, ordinal } from "@/lib/utils/format";
import { Sparkline } from "@/components/charts/Sparkline";
import { TRADE_PLAN_REFUSAL_SHORT, TRADE_PLAN_REFUSAL_TEXT } from "@/lib/signals/tradePlan";
import { Depth, EvidenceBullet, EvidenceGroup, InvalidationTrigger, Read, TickerDossier } from "@/lib/dossier/types";
import { MetricVerdict } from "@/lib/signals/types";
import { describeLiveness } from "@/lib/dossier/pipelineLiveness";
import { composeTrustLine } from "@/lib/dossier/narrative";
import { describeConvictionLevel } from "@/lib/signals/conviction";
import { CheckState } from "@/lib/dossier/checklist";
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
export function Unavailable({ section }: { section: Extract<Read<unknown>, { status: "unavailable" }> }) {
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

export function DepthMeta({ section }: { section: Extract<Read<unknown>, { status: "available" }> }) {
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

        {/* The ONE market-wide read, beside the verdict, never inside it.
            When these metrics voted, 131 of 131 equity verdicts read
            bullish; naming the backdrop once is what lets the verdict above
            belong to this symbol. */}
        {v.backdrop && (
          <p className="rounded-md border border-hairline bg-surface-2/40 px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
            {v.backdrop}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline pt-3">
          <Stat label="Strength">
            <span className="font-mono text-sm" aria-label={`${v.stars} out of 5`}>
              {"●".repeat(v.stars)}
              <span className="text-ink-faint">{"○".repeat(5 - v.stars)}</span>
            </span>
          </Stat>
          {/*
            THREE STATS, NOT FIVE. "Evidence" and "Proven signal" used to sit
            here beside Conviction — but Conviction is a deterministic
            function of exactly those two plus Signals, so the row was showing
            an answer next to three of its own inputs. That is the same
            redundancy as a section heading restating the panel beneath it.
            Both moved into the trust fold, which already explains each in
            full; nothing was lost and the row went from five readings to
            three.

            CONVICTION — the question a "Trade Quality 9.2 / 10" was asking.
            A word, not a decimal, because the resolution behind it does not
            support a tenth of a point. When a ceiling binds, the word is
            suffixed rather than silently lowered, so a reader can tell the
            difference between "this ticker looked average" and "no ticker can
            currently read higher".
          */}
          <Stat label="Conviction">
            <span
              className={`text-sm capitalize ${
                v.conviction.level === "high"
                  ? "text-success"
                  : v.conviction.level === "moderate"
                    ? "text-amber"
                    : "text-ink-muted"
              }`}
            >
              {v.conviction.level}
              {v.conviction.cappedBy && (
                <span className="ml-1 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  capped
                </span>
              )}
            </span>
          </Stat>
          <Stat label="Signals">
            <span className="text-sm text-ink-muted">{v.agreementLine}</span>
          </Stat>
        </div>

        {/*
          ── THE EPISTEMICS, FOLDED BUT NOT HIDDEN ──────────────────────

          This was two bordered paragraphs plus a footnote under the TL;DR —
          roughly six hundred characters explaining that no signal here has a
          forward record, that 250 calls are pending, and that the prose is
          not written by a language model. All true, all worth saying, and
          all of it standing between the reader and the trade on the most
          valuable screen in the product.

          The summary line carries the CONCLUSION, not merely the existence
          of a caveat, so a reader who never opens this has still been told
          the read has no track record. `<details>` is server-rendered, so
          every folded word stays in the document for find-in-page, reader
          mode and crawlers. Folding here is layering, never deletion.
        */}
        <details className="group/trust rounded-md border border-hairline bg-void/30">
          <summary className="flex cursor-pointer list-none items-baseline gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan">
              Trust
            </span>
            <span className="text-[11px] leading-relaxed text-ink-muted">
              {composeTrustLine({
                gradeLabel: v.evidenceGrade.label,
                validatedWeightPct: v.evidenceGrade.validatedWeightPct,
                forward: v.forward
                  ? {
                      scored: v.forward.mine?.n ?? null,
                      open: v.forward.open,
                      edgeVsBaselinePct: v.forward.mine?.edgeVsBaselinePct ?? null,
                    }
                  : null,
              })}
            </span>
            <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
              <span className="group-open/trust:hidden">Why</span>
              <span className="hidden group-open/trust:inline">Hide</span>
            </span>
          </summary>

          <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2">
            <p className="text-[11px] leading-relaxed text-ink-muted">
              <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Conviction</span> ·{" "}
              {describeConvictionLevel(v.conviction)}{" "}
              <span className="text-ink-faint">
                Input quality reads {v.evidence}; {v.agreementLine.toLowerCase()}
              </span>
            </p>

            <p className="text-[11px] leading-relaxed text-ink-muted">
              <span className="font-semibold uppercase tracking-[0.12em] text-cyan">Proven signal</span> ·{" "}
              {v.evidenceGrade.sentence}
            </p>

            {v.forward && (
              <p className="text-[11px] leading-relaxed text-ink-muted">
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
                        {v.forward.baselineReturnPct.toFixed(2)}% for every call in this register over the same
                        windows (the register&apos;s own cohort, not an index) — an edge of{" "}
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
                    {v.forward.engineNote && (
                      <>
                        {" "}
                        <span className="text-amber">{v.forward.engineNote}</span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    This verdict has no scored record yet. {v.forward.open.toLocaleString()} calls are registered and
                    waiting out their {v.forward.horizonSessions}-session window. Each is scored against what every
                    other call in this register did over the same windows — the register&apos;s own mixed cohort of
                    bullish, bearish and neutral calls, not an index — so a bullish read only counts as right if it
                    beat the rest of the register rather than merely rose with it. Until then the word above is a
                    hypothesis.
                  </>
                )}
              </p>
            )}

            {/* Moved here from under the TL;DR, where it was a claim about
                the platform occupying space owed to the trade. */}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Every sentence on this page is assembled from the readings below — this platform does not
              generate summaries with a language model, so nothing here can describe something the engine
              did not measure.
            </p>
          </div>
        </details>
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

/* ── 3b. THE SETUP CHECKLIST ──────────────────────────────────────────── */

const CHECK_MARK: Record<CheckState, { glyph: string; tone: string }> = {
  pass: { glyph: "✅", tone: "text-ink" },
  caution: { glyph: "⚠️", tone: "text-ink" },
  fail: { glyph: "❌", tone: "text-ink" },
};

/**
 * Pass, caution or fail on every check, in three seconds.
 *
 * The headline is the plan's OWN star rating rather than a 0-10 number
 * computed here: a second composite beside `bias.score` would carry no
 * record of its own, and a decimal would imply resolution a five-point
 * rating does not have. When the gate refused a plan there is nothing to
 * rate, and the card says that instead of printing a low score — a low score
 * would claim a bad trade exists, which is precisely what the gate denied.
 */
export function ChecklistPanel({ d }: { d: TickerDossier }) {
  const c = d.checklist;
  return (
    <Panel title="Setup quality" subtitle={`${c.passed} of ${c.total} checks pass`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {c.stars !== null ? (
          <span className="font-mono text-xl leading-none text-ink" aria-label={`${c.stars} out of 5`}>
            {"★".repeat(c.stars)}
            <span className="text-ink-faint">{"☆".repeat(5 - c.stars)}</span>
          </span>
        ) : (
          <span className="text-sm font-semibold uppercase tracking-[0.14em] text-amber">No setup to rate</span>
        )}
        <span className="text-[13px] leading-relaxed text-ink-muted">{c.summary}</span>
      </div>

      {c.starRationale && <p className="text-[12px] leading-relaxed text-ink-muted">{c.starRationale}</p>}

      <ul className="flex flex-col gap-2 border-t border-hairline pt-3">
        {c.rows.map((r) => (
          <li key={r.label} className="flex items-start gap-2.5">
            <span aria-hidden className="mt-px shrink-0 text-[13px] leading-relaxed">
              {CHECK_MARK[r.state].glyph}
            </span>
            <span className="text-[12px] leading-relaxed">
              <span className={CHECK_MARK[r.state].tone}>{r.label}</span>
              <span className="text-ink-faint"> · {r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
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

/* ── 4c. WHAT WOULD MAKE ME PASS ──────────────────────────────────────── */

/**
 * The conditions under which standing aside is the decision.
 *
 * Distinct from the invalidation section below, and the distinction is the
 * point: that one is about exiting a position already taken, this one is
 * about never opening it. Rules already met are marked and lead, because a
 * reason to pass that applies RIGHT NOW is not a thing to watch for — it is
 * the answer.
 */
export function PassRulesPanel({ d }: { d: TickerDossier }) {
  /*
   * Never returns null. A section that vanishes when empty is
   * indistinguishable from one that broke — the exact failure this page's
   * contract exists to prevent, and one that happened here in review: on a
   * neutral ticker the list came back empty and the whole card silently
   * disappeared.
   */
  if (d.passRules.length === 0) {
    return (
      <Panel title="What would make me pass" subtitle="nothing measured">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          No condition on this page currently argues for standing aside. That is not a green light — it means the
          expectancy gate did not fire, no event sits inside the holding period, and no independent source
          contests the read. Every rule here is derived from a measurement, so an empty list means nothing
          measured triggered one, never that nothing could.
        </p>
      </Panel>
    );
  }

  const active = d.passRules.filter((r) => r.active);
  const watch = d.passRules.filter((r) => !r.active);

  return (
    <Panel
      title="What would make me pass"
      subtitle={active.length > 0 ? `${active.length} already met` : "none currently met"}
    >
      <ul className="flex flex-col gap-3">
        {[...active, ...watch].map((r) => (
          <li
            key={r.rule}
            className={`rounded-md border px-3 py-2.5 ${
              r.active ? "border-amber/25 bg-amber/[0.04]" : "border-hairline bg-void/30"
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span
                className={`shrink-0 text-[9px] font-semibold uppercase tracking-[0.14em] ${
                  r.active ? "text-amber" : "text-ink-faint"
                }`}
              >
                {r.active ? "Applies now" : "Watch for"}
              </span>
              <span className="text-[13px] leading-relaxed text-ink">{r.rule}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{r.because}</p>
          </li>
        ))}
      </ul>
    </Panel>
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

/**
 * The environments most like this one, and what happened next.
 *
 * The headline number is the INDEPENDENT count, not the match count. The
 * broad-bucket version this replaced led with "71,585 times seen" — the same
 * environments counted thousands of times, once per correlated name and once
 * per overlapping window — and five figures reads as settled science. The raw
 * count still appears, beside its correction rather than instead of it.
 */
/**
 * THE VALIDATED SIGNAL.
 *
 * Two states that must not be allowed to look alike: the record APPLIES, or
 * it does not. Everything else on this page is a reading; this is the only
 * thing with a corrected, cost-charged forward measurement behind it, and
 * the design job is to make "it applies" earn its prominence without letting
 * "it does not" borrow any.
 *
 * So the statistics block renders only when the record applies. A page that
 * showed 58.7% next to "this does not apply right now" would have a reader
 * remembering the number and forgetting the qualifier — which is precisely
 * the failure mode of every backtest ever put on a marketing page.
 */
/**
 * Converts a count of real SESSIONS into a count of DRAWN POINTS.
 *
 * The trail is downsampled for drawing, so "252 sessions" is not 252 points
 * on the chart. Shading 252 points of a 220-point trail would shade the whole
 * thing and quietly claim the rank was measured over five years.
 */
function scaled(sessions: number, trail: { closes: number[]; sessions: number }): number {
  if (trail.sessions <= 0) return 0;
  return Math.max(1, Math.round((sessions / trail.sessions) * trail.closes.length));
}

export function ValidatedSignalPanel({ d }: { d: TickerDossier }) {
  const s = d.validatedSignal;
  if (s.status !== "available") {
    return (
      <Panel title="Validated signal">
        <Unavailable section={s} />
      </Panel>
    );
  }

  const m = s.data;
  const applies = m.applies && m.record !== null;

  return (
    <Panel
      title="Validated signal"
      subtitle={`cross-sectional momentum · ${m.panelSize}-name panel`}
    >
      <p
        className={`rounded-md border px-3 py-2.5 text-[13px] leading-relaxed ${
          applies
            ? "border-success/25 bg-success/[0.04] text-ink"
            : "border-hairline bg-void/30 text-ink"
        }`}
      >
        <span
          className={`mr-2 text-[9px] font-semibold uppercase tracking-[0.14em] ${
            applies ? "text-success" : "text-ink-faint"
          }`}
        >
          {applies ? "Record applies" : "No claim"}
        </span>
        {m.headline}
      </p>

      {/* Only when the record genuinely covers this situation. See the header. */}
      {applies && m.record && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <PlanStat label="Beat the panel" value={`${m.record.winRatePct.toFixed(1)}%`} tone="text-success" />
          {/* The number a reader should actually size on — the hit rate is the
              optimistic end of the interval, not the estimate. */}
          <PlanStat label="95% floor" value={`${m.record.lowerBoundPct.toFixed(1)}%`} />
          <PlanStat label="Periods" value={`${m.record.n}`} tone="text-ink-faint" />
          <PlanStat
            label={`Excess / ${m.record.holdSessions}d`}
            value={`${m.record.meanExcessPct >= 0 ? "+" : ""}${m.record.meanExcessPct.toFixed(2)}%`}
            tone={m.record.meanExcessPct >= 0 ? "text-success" : "text-danger"}
          />
          {/* Never omitted. A hit rate says how often you win; this says what
              the worst period looked like, and they size differently. */}
          <PlanStat label="Worst period" value={`${m.record.worstPct.toFixed(1)}%`} tone="text-danger" />
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-ink-muted">{m.detail}</p>

      {/* THE RANKING WINDOW, drawn. Twelve months ending one month ago — the
          shaded band is what produced the return above, and the clear strip
          at the right edge is the skipped month that removes short-horizon
          reversal. Three sentences of prose, or one picture. */}
      {d.priceTrail && d.priceTrail.closes.length >= 30 && (
        <div className="flex flex-col gap-1">
          <Sparkline
            values={d.priceTrail.closes}
            windowSessions={scaled(252, d.priceTrail)}
            windowOffset={scaled(21, d.priceTrail)}
            tone={m.momentumPct >= 0 ? "up" : "down"}
            label={`${d.identity.symbol} price over ${d.priceTrail.sessions} sessions, with the twelve-month ranking window shaded and the skipped final month clear`}
          />
          <p className="text-[10px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Shaded ·</span> the twelve months this rank was measured over. The
            clear strip at the right is the skipped final month, excluded because short-horizon reversal points
            the other way and would cancel part of the effect.
          </p>
        </div>
      )}

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        <PlanStat label="12-1 return" value={`${m.momentumPct >= 0 ? "+" : ""}${m.momentumPct.toFixed(0)}%`} />
        <PlanStat label="Panel rank" value={`${ordinal(m.percentile)} pct`} />
        <PlanStat
          label="Market breadth"
          value={m.breadthPct === null ? "unknown" : `${(m.breadthPct * 100).toFixed(0)}% above 200d`}
          tone={
            m.regime === "broad-strength"
              ? "text-success"
              : m.regime === "broad-weakness"
                ? "text-danger"
                : "text-ink-faint"
          }
        />
      </div>

      <Collapsible title="What bounds this claim" summary={`${m.caveats.length} limits`}>
        <ul className="flex flex-col gap-2">
          {m.caveats.map((c, i) => (
            <li key={i} className="text-[12px] leading-relaxed text-ink-muted">
              — {c}
            </li>
          ))}
        </ul>
      </Collapsible>

      <DepthMeta section={s} />
    </Panel>
  );
}

export function AnalogsPanel({ d }: { d: TickerDossier }) {
  const a = d.analogs;
  return (
    <Panel title="Similar historical environments" subtitle={a.status === "available" ? "fingerprint-matched" : undefined}>
      {a.status === "available" ? (
        <>
          <p className="text-[13px] leading-relaxed text-ink">{a.data.summary}</p>

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            {/* The count that any confidence statement is allowed to use. */}
            <PlanStat
              label="Independent"
              value={a.data.effectiveN.toFixed(1)}
              tone={a.data.effectiveN < 8 ? "text-amber" : "text-ink"}
            />
            <PlanStat label="Raw matches" value={`${a.data.matches}`} tone="text-ink-faint" />
            <PlanStat
              label="Typical (median)"
              value={`${a.data.medianReturnPct >= 0 ? "+" : ""}${a.data.medianReturnPct.toFixed(1)}%`}
              tone={a.data.medianReturnPct >= 0 ? "text-success" : "text-danger"}
            />
            {/* Never shown alone. A median means nothing until you know what a
                random day over the same horizon returned. */}
            <PlanStat
              label="Random day"
              value={`${a.data.baselineReturnPct >= 0 ? "+" : ""}${a.data.baselineReturnPct.toFixed(1)}%`}
              tone="text-ink-faint"
            />
            <PlanStat label="Ended positive" value={`${a.data.positiveRatePct.toFixed(0)}%`} />
            <PlanStat label="Typical dip first" value={`−${a.data.typicalDrawdownPct.toFixed(1)}%`} />
          </div>

          {/* THE GAP, when there is one. Stated in the loudest available voice
              because a reader who takes `matches` at face value is being
              misled by a number that is technically correct. */}
          <p
            className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
              a.data.effectiveN < a.data.matches * 0.5
                ? "border-amber/25 bg-amber/[0.04] text-ink"
                : "border-hairline bg-void/30 text-ink-muted"
            }`}
          >
            <span className="font-semibold uppercase tracking-[0.12em] text-amber">Sample</span> ·{" "}
            {a.data.independenceLine}
          </p>

          <p className="text-[11px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Matched on ·</span> eleven declared dimensions, each standardised
            against the instrument&rsquo;s own history and fixed before any of this was measured. Closest match
            sat at distance {a.data.nearestDistance.toFixed(2)}, furthest accepted at{" "}
            {a.data.furthestDistance.toFixed(2)}. At most one day per instrument per three weeks, so a single
            regime cannot appear twenty times.
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
  const gaps: Array<{ label: string; section: Read<unknown> }> = [
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
              <Unavailable section={g.section as Extract<Read<unknown>, { status: "unavailable" }>} />
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

  /*
   * "Contracts" meant two different things on this panel and the collision
   * read as a contradiction: the subtitle is how many contracts are LISTED
   * (CIFR 1,348) while the concentration line below reports OPEN INTEREST
   * per strike (49,937). Same noun, different quantity, so one strike
   * appeared to hold thirty-seven times the whole chain. The arithmetic was
   * always right; the words were not. Both now say which they are.
   */
  return (
    <Panel title="Options positioning" subtitle={`${o.contractCount.toLocaleString()} contracts listed · CBOE, delayed`}>
      <p className="text-[13px] leading-relaxed text-ink">
        {/*
          THE RATIO NEVER TRAVELS WITHOUT ITS DENOMINATOR.
          1.40 over 300 contracts and 1.40 over 300,000 are the same number
          and different facts, and the thin one is noise a reader would size
          on. The total was already computed and was rendered only further
          down as a footnote to the largest strikes; it belongs beside the
          ratio it divides.
        */}
        Open interest is {oiLean} (put/call ratio {o.putCallOiRatio.toFixed(2)}, across{" "}
        {(o.callOi + o.putOi).toLocaleString()} contracts of open interest).{" "}
        {/* The sentence carries the tenor too, and says why it runs hot on a
            short expiry — otherwise a 300% reading looks like an error. */}
        {o.atmIvPct !== null &&
          `Contracts nearest the money on the ${
            o.atmIvDaysToExpiry === null
              ? "nearest"
              : o.atmIvDaysToExpiry === 0
                ? "expiring-today"
                : `${o.atmIvDaysToExpiry}-day`
          } expiry imply ${o.atmIvPct.toFixed(0)}% annualised volatility. Short-dated contracts routinely price well above the longer expiries, so read this against the expected move above rather than as one number.`}{" "}
        {o.netGexUsdPer1Pct !== null &&
          (o.netGexUsdPer1Pct > 0
            ? "Net dealer gamma is positive, which under the standard convention means hedging flows dampen moves — dips get bought, rips get sold."
            : "Net dealer gamma is negative, which under the standard convention means hedging flows amplify moves in both directions.")}
      </p>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <PlanStat label="Put/call (open interest)" value={o.putCallOiRatio.toFixed(2)} />
        {/*
          Distinct from the "contracts listed" count in the subtitle, which is
          an INSTRUMENT count — how many strikes and expiries exist. This is
          how many are actually held. A cross-validation check that compared
          the two would be comparing apples to oranges; this is the quantity a
          per-strike open-interest figure can legitimately be measured against.
        */}
        <PlanStat label="Chain open interest" value={(o.callOi + o.putOi).toLocaleString()} tone="text-ink-muted" />
        <PlanStat
          label="Put/call (today's volume)"
          value={o.putCallVolumeRatio === null ? "—" : o.putCallVolumeRatio.toFixed(2)}
        />
        {/* THE TENOR IS PART OF THE NUMBER. Annualised vol on a three-day
            option is a different quantity from the same figure on a monthly,
            and this page shows both — the options-intelligence card above
            quotes a ~monthly expected move. Without the horizon on this one,
            the two look like a contradiction rather than a term structure. */}
        <PlanStat
          label={
            o.atmIvDaysToExpiry === null
              ? "Annualised IV (nearest expiry)"
              : o.atmIvDaysToExpiry === 0
                ? "Annualised IV (expires today)"
                : `Annualised IV (${o.atmIvDaysToExpiry}d expiry)`
          }
          value={o.atmIvPct === null ? "—" : `${o.atmIvPct.toFixed(0)}%`}
        />
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
            .map(
              (x) =>
                `${formatPrice(x.strike)} ${x.kind}s (open interest ${x.openInterest.toLocaleString()}, ${x.expiry})`
            )
            .join(" · ")}
          {/*
           * A strike's open interest says nothing on its own — 49,937 is
           * enormous on a thin chain and unremarkable on a deep one. The
           * chain total is what makes it a concentration rather than a
           * number, and it is the figure a reader reaches for the moment
           * they see the word "concentrate".
           */}
          {` out of ${(o.callOi + o.putOi).toLocaleString()} open across the chain`}
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

                {/* A "target is unrealistic" warning used to render here,
                    triggered by target1Pct > 3x the cell's AVERAGE REALIZED
                    RETURN — a price distance judged against a P&L mean over
                    ~3-session median holds. Different units, different
                    horizon: any structural target fails that comparison, so
                    the warning was always on and said nothing. The matched-
                    horizon claims already render beside this: the reach rate
                    above (same distance, ten-session window) and the plan
                    gate's winners'-excursion annotation. Removed rather than
                    reworded — e.record holds no excursion statistic, so no
                    honest version of the sentence can be built from it. */}
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
                  {s.data.forward.since && <> (since {s.data.forward.since})</>} and scored ten sessions later.{" "}
                  {s.data.forward.open > 0 ? (
                    <>
                      {s.data.forward.open.toLocaleString()} are open and none has finished its window.
                      {s.data.forward.openReached > 0 && (
                        <>
                          {" "}
                          {s.data.forward.openReached.toLocaleString()} have already touched their level — which is
                          deliberately not shown as a hit rate, because a miss needs all ten sessions to become
                          one and a young cohort can therefore only show hits.
                        </>
                      )}
                    </>
                  ) : (
                    <>None has finished its window yet.</>
                  )}{" "}
                  Until those windows close, treat every number on this page as a hypothesis rather than a track
                  record.
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

/* ── THE RECOVERED ORPHANS ───────────────────────────────────────────── */

/**
 * AFTER-HOURS FILINGS — the catalyst class that decides an overnight hold.
 *
 * Built, tested and shipped into /api/pretrade, and rendered on no page at
 * all until the module registry gave it a slot. A filing accepted after the
 * close is precisely the event a position cannot react to: the stop is a
 * statement about continuous tape, and the tape is closed.
 *
 * "Nothing filed" is stated rather than left blank, because a blank is
 * indistinguishable from a lookup that failed — and those two answers point
 * a trader in opposite directions.
 */
export function CatalystsPanel({ d }: { d: TickerDossier }) {
  const s = d.catalysts;
  return (
    <Panel title="Filings since the prior close">
      {s.status === "unavailable" ? (
        <Unavailable section={s} />
      ) : s.data.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Nothing qualifying has been filed since the last close. This is a checked answer, not an
          empty feed — EDGAR was read and returned no 8-K carrying a material item, no prospectus and
          no shelf.
        </p>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-ink">
            {s.data.length === 1
              ? "One qualifying filing has landed since the last close."
              : `${s.data.length} qualifying filings have landed since the last close.`}{" "}
            A position held overnight could not have reacted to {s.data.length === 1 ? "it" : "them"}.
          </p>
          <ul className="flex flex-col gap-2">
            {s.data.map((f) => (
              <li key={f.accession} className="flex flex-wrap items-baseline gap-2 border-l-2 border-amber/40 pl-3">
                <span className="font-mono text-[12px] font-semibold text-ink">{f.form}</span>
                {f.items.length > 0 && (
                  <span className="font-mono text-[10px] text-ink-muted">items {f.items.join(", ")}</span>
                )}
                <span className="font-mono text-[10px] text-ink-faint">
                  {f.filed_at.replace("T", " ").slice(0, 16)} UTC
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {s.status === "available" && <DepthMeta section={s} />}
    </Panel>
  );
}

/**
 * PIPELINE LIVENESS — whether the machinery behind this page actually ran.
 *
 * Not a diagnostic for us. A terminal that looks live when it is not
 * discredits every number on it, and this platform has already had that
 * failure: the daily job stopped, the ledger sat at three entries, and it was
 * found by running `git log` by hand. From the site, everything looked fine.
 */
export function LivenessPanel({ d }: { d: TickerDossier }) {
  const s = d.liveness;
  if (s.status === "unavailable") {
    return (
      <Panel title="Pipeline liveness">
        <Unavailable section={s} />
      </Panel>
    );
  }
  const read = s.data;
  return (
    <Panel title="Pipeline liveness" subtitle={`as of ${read.asOf}`}>
      <p className="text-[13px] leading-relaxed text-ink">{describeLiveness(read)}</p>
      <ul className="flex flex-col gap-1.5">
        {read.stores.map((store) => (
          <li key={store.store} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[12px] text-ink-muted">{store.what}</span>
            <span className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-ink-faint">{store.lastUpdate ?? "never written"}</span>
              <span
                className={`text-[9px] font-semibold uppercase tracking-[0.14em] ${
                  store.status === "current"
                    ? "text-success"
                    : store.status === "late"
                      ? "text-amber"
                      : "text-danger"
                }`}
              >
                {store.status === "current"
                  ? "current"
                  : store.status === "never"
                    ? "never written"
                    : `${store.sessionsBehind} behind`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <DepthMeta section={s} />
    </Panel>
  );
}

/**
 * MONEY FLOW — where the capital is going.
 *
 * The third orphan: `moneyFlow` has been assembled on the dossier for as long
 * as the contract has existed and was read by nothing except the gaps report,
 * which listed it as missing. It was never missing; it had no slot.
 */
export function MoneyFlowPanel({ d }: { d: TickerDossier }) {
  const s = d.moneyFlow;
  return (
    <Panel title="Money flow">
      {s.status === "unavailable" ? (
        <Unavailable section={s} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[13px] leading-relaxed text-ink">{s.data.topReason}</span>
            <span className="font-mono text-[11px] text-ink-muted">{s.data.verdict}</span>
          </div>
          {s.data.metrics.length > 0 && (
            <ul className="flex flex-col gap-1">
              {s.data.metrics.slice(0, 5).map((m) => (
                <li key={m.id} className="flex flex-col gap-0.5">
                  <span className="text-[12px] text-ink-muted">{m.label}</span>
                  <span className="text-[11px] leading-relaxed text-ink-faint">{m.explanation}</span>
                </li>
              ))}
            </ul>
          )}
          <DepthMeta section={s} />
        </>
      )}
    </Panel>
  );
}
