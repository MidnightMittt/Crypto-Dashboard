import { Card, CardContent } from "@/components/ui/Card";
import { Collapsible } from "@/components/ui/Collapsible";
import { EvidenceModuleDetail } from "@/components/evidence/EvidenceModuleDetail";
import { formatPrice } from "@/lib/utils/format";
import { TRADE_PLAN_REFUSAL_SHORT, TRADE_PLAN_REFUSAL_TEXT } from "@/lib/signals/tradePlan";
import { Depth, EvidenceBullet, InvalidationTrigger, Section, TickerDossier } from "@/lib/dossier/types";
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
        {ours ? "Not built yet" : section.blockedBy === "not-applicable" ? "Not applicable" : "No data source"}
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
            <PlanStat label="Edge per trade" value={`${expectations.data.evLowerPct.toFixed(2)}%`} />
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

/* ── 4. WHY / WHAT FIGHTS IT ─────────────────────────────────────────── */

export function ReasonsPanel({ d }: { d: TickerDossier }) {
  return (
    <Panel title="Why this trade exists">
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        <BulletList
          title="Supports it"
          mark="✓"
          markClass="text-success"
          bullets={d.reasonsFor}
          empty="Nothing currently argues for this side."
        />
        <BulletList
          title="Fights it"
          mark="✕"
          markClass="text-danger"
          bullets={d.reasonsAgainst}
          empty="Nothing material argues the other way."
        />
      </div>
    </Panel>
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
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <PlanStat label="Times seen" value={`${a.data.occurrences}`} />
            <PlanStat label="Win rate" value={`${a.data.winRatePct.toFixed(0)}%`} />
            <PlanStat label="Median return" value={`${a.data.medianReturnPct >= 0 ? "+" : ""}${a.data.medianReturnPct.toFixed(1)}%`} />
            <PlanStat
              label="Typical dip first"
              value={a.data.averageDrawdownPct === null ? "—" : `${a.data.averageDrawdownPct.toFixed(1)}%`}
            />
            <PlanStat
              label="Typical hold"
              value={a.data.medianHoldSessions === null ? "—" : `${a.data.medianHoldSessions} days`}
            />
          </div>
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

export function EvidencePanel({ d }: { d: TickerDossier }) {
  return (
    <Panel title="The evidence" subtitle={`${d.bias.metrics.length} readings`}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {d.evidence.map((g) => (
          <div key={g.label} className="rounded-md border border-hairline bg-void/30 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {g.label}
              </span>
              {g.verdict !== null ? (
                <span
                  className={`font-mono text-xs ${
                    g.verdict === "bullish" ? "text-success" : g.verdict === "bearish" ? "text-danger" : "text-ink-muted"
                  }`}
                >
                  {g.score}
                </span>
              ) : (
                <span className="font-mono text-xs text-ink-faint">context only</span>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{g.topReason}</p>
          </div>
        ))}
      </div>

      <Collapsible title="Every reading in full" summary="measurements, confidence and what would flip each one">
        <ul className="flex flex-col gap-5 pt-2">
          {d.bias.metrics.map((m) => (
            <li key={m.id} className="border-l border-hairline pl-4">
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink">{m.label}</h4>
              <EvidenceModuleDetail metric={m} allMetrics={d.bias.metrics} basis={d.bias.basis} />
            </li>
          ))}
        </ul>
      </Collapsible>
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
