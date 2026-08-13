import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { Collapsible } from "@/components/ui/Collapsible";
import { EvidenceModuleDetail } from "@/components/evidence/EvidenceModuleDetail";
import { StructureLadder, LadderMarker } from "@/components/markets/StructureLadder";
import { MarketBias, MetricVerdict, CategoryScore } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal, TRADE_PLAN_REFUSAL_TEXT } from "@/lib/signals/tradePlan";
import { EarningsVetoResult } from "@/lib/markets/earningsVeto";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { intensityLabel, DIRECTIONAL_THRESHOLD } from "@/lib/signals/scoring";
import { CATEGORY_WEIGHTS, CATEGORY_ORDER, CATEGORY_LABELS } from "@/lib/signals/categories";
import { findConfidenceDrivers } from "@/lib/signals/confidence";
import { formatPrice } from "@/lib/utils/format";
import snapshot from "@/data/equityMarkets.json";

/**
 * MARKET DETAIL — the equity counterpart to an asset page.
 *
 * Everything here is the same engine's output, rendered in the same reading
 * order the crypto Decision Panel uses: what the decision is, how confident it
 * is and why, what the evidence says, where the structure sits, what the risk
 * is, and what to do — or why there is nothing to do.
 *
 * ── The rule this page holds to ────────────────────────────────────────
 *
 * IT COMPUTES NO OPINION. Every number below is read off the precomputed
 * snapshot, which is produced by the same `buildMarketBias` / `buildTradePlan`
 * the crypto surface uses. The only derivation here is presentational —
 * picking which side of the evidence leads, and mapping a category weight to
 * a percentage. The moment a page starts scoring things, there are two
 * engines.
 *
 * The evidence is grouped rather than listed flat, which is what makes the
 * smaller equity evidence base legible: a reader can see that Positioning is
 * EMPTY because derivatives have no equity analogue, rather than wondering
 * whether it was simply omitted.
 */

interface MarketDecision {
  symbol: string;
  name: string;
  bias: MarketBias;
  lastClose: number;
  change24hPct: number;
  asOf: number;
  plan: TradePlan | null;
  planRefusal: TradePlanRefusal | null;
  earnings: EarningsVetoResult | null;
  zones: SupportResistanceZone[];
  atrPct: number | null;
}

const data = snapshot as unknown as { generatedAt: number; decisions: MarketDecision[] };

export function generateStaticParams() {
  return data.decisions.map((d) => ({ symbol: d.symbol.toLowerCase() }));
}

export default async function MarketDetailPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const decision = data.decisions.find((d) => d.symbol.toLowerCase() === symbol.toLowerCase());

  // An unknown ticker 404s rather than falling back to SPY — showing a
  // different market than the URL names would undermine every number on it.
  if (!decision) notFound();

  const { bias, plan } = decision;
  const tone = verdictTone(bias.verdict);
  const leadSide = bias.verdict === "bearish" ? bias.topBearish : bias.topBullish;
  const againstSide = bias.verdict === "bearish" ? bias.topBullish : bias.topBearish;
  const structure = bias.metrics.find((m) => m.id === "marketStructure") ?? null;

  const markers: LadderMarker[] = plan
    ? [
        { label: "Entry", price: plan.entryRef, tone: "entry" },
        { label: "Stop", price: plan.stopPrice, tone: "stop" },
        { label: "T1", price: plan.target1Price, tone: "target" },
        { label: "T2", price: plan.target2Price, tone: "target" },
      ]
    : [];

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-lg font-semibold text-ink">{decision.symbol}</h1>
            <span className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">{decision.name}</span>
            <span className="font-mono text-sm text-ink">{formatPrice(decision.lastClose)}</span>
            <span
              className={`font-mono text-[11px] ${
                decision.change24hPct > 0 ? "text-success" : decision.change24hPct < 0 ? "text-danger" : "text-ink-faint"
              }`}
            >
              {decision.change24hPct >= 0 ? "+" : ""}
              {decision.change24hPct.toFixed(2)}%
            </span>
          </div>
          <Link href="/markets" className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
            ← All markets
          </Link>
        </div>

        {/* ── THE DECISION ──────────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={`text-2xl font-bold uppercase leading-none tracking-[0.04em] sm:text-3xl ${tone}`}>
                {intensityLabel(bias.score)}
                {bias.basis === "state" && <span className="text-ink-muted"> conditions</span>}
              </span>
              <span className="font-mono text-lg leading-none text-ink">{bias.score}</span>
              <span className="text-[11px] text-ink-faint">
                / 100 · Data Quality {bias.confidence}% · Agreement {bias.agreement}%
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-ink">{bias.headline}</p>
            {bias.basis === "state" && (
              <p className="border-t border-hairline pt-2 text-[11px] leading-relaxed text-ink-faint">
                <span className="font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  Market state, not edge
                </span>{" "}
                · Every equity module here (relative strength, breadth, trend quality, risk appetite,
                volatility regime) DESCRIBES current conditions. None has a measured forward record, so this
                score claims what the market is — never what it does next. The crypto composite is the
                different, backtested question.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── DATA QUALITY, EXPLAINED ───────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <SectionTitle>Data Quality · {bias.confidence}%</SectionTitle>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              This measures <span className="text-ink">evidence quality</span>, not the probability of a
              move. {bias.confidence}% means the read rests on{" "}
              {bias.confidence >= 65 ? "solid, agreeing" : bias.confidence >= 40 ? "partial" : "thin"} data —
              never that price rises {bias.confidence}% of the time. Agreement ({bias.agreement}%) is the
              separate question of whether the modules concur with{" "}
              <span className="text-ink">each other</span>; a unanimous read built on thin data is high
              agreement and low data quality, which is exactly the case worth seeing.
            </p>
            <ConfidenceDrivers bias={bias} />
          </CardContent>
        </Card>

        {/* ── TECHNICAL SUMMARY (the category rollups) ──────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <SectionTitle>Technical summary</SectionTitle>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              The four questions the engine scores separately before combining them. Where they disagree,
              the composite is a compromise rather than a consensus — worth knowing before acting on it.
            </p>
            <CategoryGrid categories={bias.categories} />
          </CardContent>
        </Card>

        {/* ── MARKET STRUCTURE + LEVELS ─────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-4 py-5">
            {/*
              Titled "Structure & levels", not "Market Structure", on purpose.
              `marketStructure` is BOTH a metric id and a category id, and a
              page that used the same words for the swing-sequence module and
              for the four-module category above it would leave a reader unable
              to tell which "Market Structure 60" referred to.
            */}
            <SectionTitle>Structure &amp; levels</SectionTitle>
            {structure ? (
              <>
                <p className="-mt-1 text-[11px] leading-relaxed text-ink-faint">
                  The swing-sequence reading — one of the {
                    bias.categories.find((c) => c.category === "marketStructure")?.metrics.length ?? 1
                  }{" "}
                  modules inside the Market Structure category above, shown in full because it is what a
                  stop is placed against.
                </p>
                <EvidenceModuleDetail metric={structure} allMetrics={bias.metrics} basis={bias.basis} />
              </>
            ) : (
              <p className="text-xs leading-relaxed text-ink-faint">
                Not enough swing history to read a structural sequence. Two swing highs and two swing lows
                are the minimum that can express a sequence at all — one pivot is a location, not a
                direction.
              </p>
            )}

            <div className="border-t border-hairline pt-4">
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                Support &amp; resistance{plan ? ", with the plan's levels" : ""}
              </h3>
              <StructureLadder
                zones={decision.zones}
                currentPrice={decision.lastClose}
                markers={markers}
                atrPct={decision.atrPct}
              />
            </div>
          </CardContent>
        </Card>

        {/* ── EVIDENCE ──────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-4 py-5">
            <SectionTitle>Evidence</SectionTitle>
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <EvidenceList title="Evidence for" mark="✓" markClass="text-success" items={leadSide} empty="None." />
              <EvidenceList
                title="Evidence against"
                mark="✕"
                markClass="text-danger"
                items={againstSide}
                empty="Nothing material argues the other way."
              />
            </div>

            <div className="border-t border-hairline pt-4">
              <Collapsible
                title="Every reading, in full"
                summary={`${bias.metrics.length} modules · evidence, measurements and what would flip each one`}
              >
                <ul className="flex flex-col gap-5">
                  {bias.metrics.map((m) => (
                    <li key={m.id} className="border-l border-hairline pl-4">
                      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink">
                        {m.label}
                      </h4>
                      <EvidenceModuleDetail metric={m} allMetrics={bias.metrics} basis={bias.basis} />
                    </li>
                  ))}
                </ul>
              </Collapsible>
            </div>

            {/*
              Naming what is ABSENT is as important as what is present. A
              reader who knows crypto scores on eighteen modules needs to see
              that Positioning is structurally empty here, not omitted.
            */}
            <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
              <span className="text-ink-muted">Not available for equities:</span> funding, open interest,
              liquidations and on-chain have no equity analogue and are structurally absent, not missing.
              ETF flows, earnings and options flow are not built — no provider for them is ingested. The
              score renormalises over the evidence that exists rather than treating absent modules as zero.
              This gap is permanent for the derivatives modules and a backlog item only for the rest.
            </p>
          </CardContent>
        </Card>

        {/* ── RISK ──────────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <SectionTitle>Risk</SectionTitle>
              <span
                className={`text-sm font-semibold uppercase tracking-[0.06em] ${
                  bias.riskLevel === "high"
                    ? "text-danger"
                    : bias.riskLevel === "medium"
                      ? "text-amber"
                      : "text-success"
                }`}
              >
                {bias.riskLevel}
              </span>
              {decision.atrPct !== null && (
                <span className="font-mono text-[11px] text-ink-faint">
                  Daily range {decision.atrPct.toFixed(2)}% (ATR)
                </span>
              )}
            </div>
            <p className="text-[13px] leading-relaxed text-ink">{bias.riskRationale}</p>

            {bias.counterRisk && (
              <div className="border-t border-hairline pt-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                  The most likely reason this is wrong
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-ink">
                  <span className="text-ink-muted">{bias.counterRisk.label} · </span>
                  {bias.counterRisk.explanation}
                </p>
              </div>
            )}

            {bias.watchNext.length > 0 && (
              <div className="border-t border-hairline pt-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                  Closest to flipping
                </h3>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {bias.watchNext.map((m) => (
                    <li key={m.id} className="text-[11px] leading-relaxed text-ink-muted">
                      <span className="text-ink">{m.label}</span>
                      {m.nextTrigger ? ` ${m.nextTrigger}` : " has no stated threshold to cross"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── TRADE PLAN ────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <SectionTitle>Trade plan</SectionTitle>
            {plan ? (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
                  <PlanStat label="Entry" value={`${formatPrice(plan.entryLow)}–${formatPrice(plan.entryHigh)}`} />
                  <PlanStat label="Stop" value={formatPrice(plan.stopPrice)} tone="text-danger" />
                  <PlanStat label="Target 1" value={formatPrice(plan.target1Price)} tone="text-success" />
                  <PlanStat label="Target 2" value={formatPrice(plan.target2Price)} tone="text-success" />
                  <PlanStat label="Risk / Reward" value={`${plan.riskRewardRatio.toFixed(2)}R`} />
                  <PlanStat label="To Target 2" value={`${plan.riskRewardRatio2.toFixed(2)}R`} />
                </div>

                {/* Every level says where it came from — the plan is only as
                    trustworthy as the structure it is anchored to. */}
                <dl className="flex flex-col gap-1 border-t border-hairline pt-3 text-[11px] leading-relaxed">
                  <LevelBasis label="Entry" basis={plan.entryBasis} />
                  <LevelBasis label="Stop" basis={plan.stopBasis} />
                  <LevelBasis label="Target 1" basis={plan.target1Basis} />
                  <LevelBasis label="Target 2" basis={plan.target2Basis} />
                </dl>

                <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
                  <span className="font-semibold uppercase tracking-[0.12em] text-amber">Invalidation</span> · A
                  close beyond {formatPrice(plan.stopPrice)} ends this thesis. That level sits past the
                  structure the plan is built on, so losing it means the reason for the trade is gone — not
                  merely that price moved.
                </p>

                {/*
                  The star rating is deliberately caveated rather than shown
                  bare. Its historical-win-rate input is null for equities.
                */}
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  <span className="text-ink-muted">Quality {plan.stars}/5 · </span>
                  {plan.starRationale} Geometry is the same <code>buildTradePlan</code> the crypto side
                  uses.{" "}
                  <span className="text-ink-muted">
                    The rating is computed WITHOUT a historical win rate:
                  </span>{" "}
                  there is no equity execution replay yet, so the one input that measures whether comparable
                  trades actually finished green is absent. Treat the geometry as sound and the rating as
                  incomplete.
                </p>
              </>
            ) : (
              <NoSetup bias={bias} refusal={decision.planRefusal} earnings={decision.earnings} />
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] text-ink-faint">
          Daily closes through {new Date(decision.asOf).toISOString().slice(0, 10)}. Not financial advice.
        </p>
      </main>
    </div>
  );
}

/* ── Why there is no setup ─────────────────────────────────────────────
 *
 * Two genuinely different silences, and conflating them is what makes "NO
 * SETUP" useless. Either the engine has no direction, or it has one and the
 * geometry refused — and a reader can act on the second (wait for a level)
 * in a way they cannot act on the first.
 */
function NoSetup({
  bias,
  refusal,
  earnings,
}: {
  bias: MarketBias;
  refusal: TradePlanRefusal | null;
  earnings: EarningsVetoResult | null;
}) {
  if (refusal) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[13px] leading-relaxed text-ink">
          The engine reads {intensityLabel(bias.score).toLowerCase()}, so it does have a direction here —
          but no plan clears the bar.
        </p>
        <p className="text-xs leading-relaxed text-ink-muted">{TRADE_PLAN_REFUSAL_TEXT[refusal]}</p>
        {refusal === "earnings-imminent" && earnings && (
          <p className="text-xs leading-relaxed text-ink">
            <span className="font-semibold uppercase tracking-[0.12em] text-amber">Report date</span> ·{" "}
            {earnings.date} —{" "}
            {earnings.sessions === 0
              ? "today"
              : earnings.sessions === 1
                ? "the next session"
                : `${earnings.sessions} sessions away`}
            . A plan returns automatically once the report is out.
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-ink-faint">
          This is the engine declining, not failing. A plan appears when structure moves into a position
          that supports one — which usually means waiting for price to come to a level rather than for the
          read to change.
        </p>
      </div>
    );
  }

  const distance = Math.abs(bias.score - 50);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] leading-relaxed text-ink">
        No plan, because there is no direction to build one on.
      </p>
      <p className="text-xs leading-relaxed text-ink-muted">
        The composite sits at {bias.score}, {distance.toFixed(0)} point{distance === 1 ? "" : "s"} from
        neutral — inside the {DIRECTIONAL_THRESHOLD}-point band where the evidence is judged balanced
        rather than leaning. The score would need to reach{" "}
        {50 + DIRECTIONAL_THRESHOLD} or {50 - DIRECTIONAL_THRESHOLD} before a side is worth committing to.
        Manufacturing a plan from {bias.score} would be exactly the false precision this engine refuses.
      </p>
      {bias.watchNext.length > 0 && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Closest to moving it: {bias.watchNext.map((m) => m.label).join(", ")}.
        </p>
      )}
    </div>
  );
}

function ConfidenceDrivers({ bias }: { bias: MarketBias }) {
  const drivers = findConfidenceDrivers(
    bias.categories.map((c) => ({
      label: c.label,
      confidence: c.confidence,
      weight: CATEGORY_WEIGHTS[c.category],
      metrics: c.metrics,
    }))
  );

  if (!drivers) {
    return (
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Not enough scored categories to contrast what is raising confidence against what is lowering it.
      </p>
    );
  }

  return (
    <dl className="grid grid-cols-1 gap-4 border-t border-hairline pt-3 sm:grid-cols-2">
      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-success">
          Raising confidence
        </dt>
        <dd className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          <span className="text-ink">
            {drivers.booster.categoryLabel} at {drivers.booster.categoryConfidence}%
          </span>{" "}
          ({drivers.booster.weightPct}% of the composite). Strongest reading is{" "}
          {drivers.booster.metricLabel} — {drivers.booster.metricConfidenceBasis}
        </dd>
      </div>
      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber">
          Lowering confidence
        </dt>
        <dd className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          <span className="text-ink">
            {drivers.drag.categoryLabel} at {drivers.drag.categoryConfidence}%
          </span>{" "}
          ({drivers.drag.weightPct}% of the composite). Weakest reading is {drivers.drag.metricLabel} —{" "}
          {drivers.drag.metricConfidenceBasis}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Every category in the taxonomy, INCLUDING the ones with no evidence.
 *
 * Rendering only the scored ones would let a structurally empty category look
 * like one that was simply left out — and for equities, Positioning being
 * empty is a fact about the asset class, not a gap in the page.
 */
function CategoryGrid({ categories }: { categories: CategoryScore[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {CATEGORY_ORDER.map((id) => {
        const scored = categories.find((c) => c.category === id);
        return (
          <div key={id} className="rounded-md border border-hairline bg-void/30 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {CATEGORY_LABELS[id]}
                {scored && (
                  <span className="ml-1.5 normal-case tracking-normal text-ink-faint">
                    {scored.metrics.length} reading{scored.metrics.length === 1 ? "" : "s"}
                  </span>
                )}
              </span>
              {scored && scored.verdict !== null ? (
                <span className={`font-mono text-xs ${verdictTone(scored.verdict)}`}>
                  {scored.score} · conf {scored.confidence}%
                </span>
              ) : scored ? (
                // Context-only: reads exist but none carries a validated
                // record, so there is no score to print for the section.
                <span className="font-mono text-xs text-ink-faint">context only</span>
              ) : (
                <span className="font-mono text-xs text-ink-faint">—</span>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
              {scored
                ? scored.topReason
                : "No evidence module reports into this category for equities. It is excluded from the score rather than counted as neutral."}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function verdictTone(verdict: string): string {
  return verdict === "bullish" ? "text-success" : verdict === "bearish" ? "text-danger" : "text-ink-muted";
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{children}</h2>;
}

function LevelBasis({ label, basis }: { label: string; basis: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-faint">{label}</dt>
      <dd className="text-ink-muted">{basis}</dd>
    </div>
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

function EvidenceList({
  title,
  mark,
  markClass,
  items,
  empty,
}: {
  title: string;
  mark: string;
  markClass: string;
  items: MetricVerdict[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((m) => (
            <li key={m.id} className="flex items-start gap-2 text-xs leading-relaxed">
              <span aria-hidden className={`shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span className="text-ink">{m.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
