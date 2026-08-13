import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { Collapsible } from "@/components/ui/Collapsible";
import { EvidenceModuleDetail } from "@/components/evidence/EvidenceModuleDetail";
import { StructureLadder, LadderMarker } from "@/components/markets/StructureLadder";
import { MarketBias, MetricVerdict, CategoryScore } from "@/lib/signals/types";
import {
  TradePlan,
  TradePlanRefusal,
  TRADE_PLAN_REFUSAL_TEXT,
  TRADE_PLAN_REFUSAL_SHORT,
} from "@/lib/signals/tradePlan";
import { EarningsVetoResult } from "@/lib/markets/earningsVeto";
import { equityVerdict } from "@/lib/markets/equityVerdict";
import {
  describeAgreement,
  describeConviction,
  evidenceLevel,
  strengthStars,
} from "@/lib/signals/plainLanguage";
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

  /*
   * The headline answer, derived by the same gated rule the crypto side
   * uses: a directional read whose plan was REFUSED reads WAIT, never
   * "bullish". See equityVerdict.ts — the word has to survive every gate,
   * or it is marketing.
   */
  const verdict = equityVerdict({
    bias,
    plan,
    refusal: decision.planRefusal,
    earningsDate: decision.earnings?.date ?? null,
  });
  const stars = strengthStars(bias.score);
  const evidence = evidenceLevel(bias.confidence);

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

        {/* ── 1. THE ANSWER ─────────────────────────────────────────────
            Bullish, bearish or neither, and what to do about it. Everything
            about HOW the engine got here moves below the plan — a reader
            came to decide, not to audit, and the audit is one click away. */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <div className="flex items-center gap-3">
              <span className="text-4xl leading-none sm:text-5xl" aria-hidden>
                {verdict.emoji}
              </span>
              <div className="flex flex-col gap-0.5">
                <span
                  className={`text-3xl font-black uppercase leading-none tracking-[0.04em] sm:text-4xl ${verdict.tone}`}
                >
                  {verdict.word}
                </span>
                <span className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                  {decision.symbol} · daily
                </span>
              </div>
            </div>

            <p className="text-[15px] leading-relaxed text-ink">{verdict.sentence}</p>

            {/* Strength and evidence as WORDS. The exact figures live in the
                workings section, where someone auditing the read will look. */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline pt-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Strength</span>
                <span className={`font-mono text-sm ${tone}`} aria-label={`${stars} out of 5`}>
                  {"●".repeat(stars)}
                  <span className="text-ink-faint">{"○".repeat(5 - stars)}</span>
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Evidence</span>
                <span
                  className={`text-sm capitalize ${
                    evidence === "strong" ? "text-success" : evidence === "moderate" ? "text-amber" : "text-danger"
                  }`}
                >
                  {evidence}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">Signals</span>
                <span className="text-sm text-ink-muted">{describeAgreement(bias.agreement)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── 2. THE PLAN ───────────────────────────────────────────────
            The second thing on the page, always — either the levels, or the
            plain reason there are none. */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <SectionTitle>{plan ? "The plan" : "Why there is no trade"}</SectionTitle>
            {plan ? (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
                  <PlanStat
                    label={bias.verdict === "bearish" ? "Sell zone" : "Buy zone"}
                    value={`${formatPrice(plan.entryLow)}–${formatPrice(plan.entryHigh)}`}
                  />
                  <PlanStat label="Get out if it hits" value={formatPrice(plan.stopPrice)} tone="text-danger" />
                  <PlanStat label="First target" value={formatPrice(plan.target1Price)} tone="text-success" />
                  <PlanStat label="Second target" value={formatPrice(plan.target2Price)} tone="text-success" />
                  <PlanStat
                    label="Reward vs risk"
                    value={`${plan.riskRewardRatio.toFixed(1)}× to first`}
                  />
                </div>

                <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[13px] leading-relaxed text-ink">
                  <span className="font-semibold uppercase tracking-[0.12em] text-amber">If it goes wrong</span> · A
                  daily close beyond {formatPrice(plan.stopPrice)} means the reason for this trade is gone — not that
                  price simply moved. That level sits past the support the whole idea rests on, so losing it ends the
                  thesis rather than testing it.
                </p>

                <p className="text-[12px] leading-relaxed text-ink-muted">
                  You risk {formatPrice(Math.abs(plan.entryRef - plan.stopPrice))} per share to make{" "}
                  {formatPrice(Math.abs(plan.target1Price - plan.entryRef))} at the first target — about{" "}
                  {plan.riskRewardRatio.toFixed(1)} times what you put up. Waiting for the buy zone rather than buying
                  here is what produces that ratio; chasing the price changes the trade.
                </p>

                <Collapsible title="Where these levels came from" summary="the reasoning behind each price">
                  <dl className="flex flex-col gap-1 text-[11px] leading-relaxed">
                    <LevelBasis label="Entry" basis={plan.entryBasis} />
                    <LevelBasis label="Stop" basis={plan.stopBasis} />
                    <LevelBasis label="Target 1" basis={plan.target1Basis} />
                    <LevelBasis label="Target 2" basis={plan.target2Basis} />
                  </dl>
                  <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
                    Quality {plan.stars}/5. {plan.starRationale}{" "}
                    <span className="text-ink-muted">
                      This rating is computed WITHOUT a historical win rate:
                    </span>{" "}
                    there is no equity trade-by-trade replay yet, so the one input that measures whether comparable
                    trades actually finished green is missing. Treat the geometry as sound and the rating as
                    incomplete.
                  </p>
                </Collapsible>
              </>
            ) : (
              <NoSetup bias={bias} refusal={decision.planRefusal} earnings={decision.earnings} />
            )}
          </CardContent>
        </Card>

        {/* ── 3. WHY ────────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-4 py-5">
            <SectionTitle>Why</SectionTitle>
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <EvidenceList
                title="Points up"
                mark="✓"
                markClass="text-success"
                items={bias.topBullish}
                empty="Nothing currently argues for the upside."
              />
              <EvidenceList
                title="Points down"
                mark="✕"
                markClass="text-danger"
                items={bias.topBearish}
                empty="Nothing currently argues for the downside."
              />
            </div>

            {bias.counterRisk && (
              <div className="border-t border-hairline pt-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                  The most likely reason this is wrong
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
                  <span className="text-ink-muted">{bias.counterRisk.label} · </span>
                  {bias.counterRisk.explanation}
                </p>
              </div>
            )}

            {bias.watchNext.length > 0 && (
              <div className="border-t border-hairline pt-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                  What would change this
                </h3>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {bias.watchNext.map((m) => (
                    <li key={m.id} className="text-[12px] leading-relaxed text-ink-muted">
                      <span className="text-ink">{m.label}</span>
                      {m.nextTrigger ? ` ${m.nextTrigger}` : " has no stated level to cross"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 4. PRICE LEVELS ───────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <SectionTitle>Price levels that matter</SectionTitle>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Where price sits against the levels it has repeatedly reacted to. These are what a stop is placed
              against — a level is only meaningful because buyers or sellers have defended it before.
            </p>
            <StructureLadder
              zones={decision.zones}
              currentPrice={decision.lastClose}
              markers={markers}
              atrPct={decision.atrPct}
            />
            <p className="text-[11px] leading-relaxed text-ink-faint">
              <span className="text-ink-muted">Typical daily move · </span>
              {decision.atrPct === null
                ? "not measurable from the available history."
                : `${decision.atrPct.toFixed(2)}% of price. A stop closer than that would be hit by ordinary movement rather than by the idea being wrong.`}
            </p>
          </CardContent>
        </Card>

        {/* ── 5. THE FULL WORKINGS ──────────────────────────────────────
            Everything the page used to open with. Nothing was deleted; it
            was demoted, because a reader deciding whether to buy does not
            need the engine's self-assessment before the answer. */}
        <Card>
          <CardContent className="py-2">
            <Collapsible
              title="Show the full workings"
              summary={`the score, how confident it is, and all ${bias.metrics.length} readings behind it`}
            >
              <div className="flex flex-col gap-6 pt-2">
                <div>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    The score
                  </h3>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={`text-xl font-bold uppercase leading-none ${tone}`}>
                      {intensityLabel(bias.score)}
                    </span>
                    <span className="font-mono text-base leading-none text-ink">{bias.score}</span>
                    <span className="text-[11px] text-ink-faint">
                      / 100 · evidence {bias.confidence}% · agreement {bias.agreement}%
                    </span>
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-ink">{bias.headline}</p>
                  <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
                    {describeConviction(bias.confidence, bias.agreement)}
                  </p>
                  {bias.basis === "state" && (
                    <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                      Every reading here describes what this market IS doing — how it is trending, how broad the
                      move is, how volatile it has been. None of them has a track record of predicting what happens
                      next, so this score is a description of conditions and not a forecast.
                    </p>
                  )}
                </div>

                <div className="border-t border-hairline pt-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    What is raising and lowering confidence
                  </h3>
                  <ConfidenceDrivers bias={bias} />
                </div>

                <div className="border-t border-hairline pt-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    The four questions, scored separately
                  </h3>
                  <p className="mb-3 mt-1 text-[11px] leading-relaxed text-ink-muted">
                    Where these disagree, the overall score is a compromise rather than a consensus.
                  </p>
                  <CategoryGrid categories={bias.categories} />
                </div>

                <div className="border-t border-hairline pt-4">
                  <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    Every reading in full
                  </h3>
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
                </div>

                <p className="border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-faint">
                  <span className="text-ink-muted">Not available for stocks:</span> funding, open interest,
                  liquidations and on-chain data do not exist for equities and are structurally absent, not missing.
                  Options flow is not built — no provider for it is ingested. The score divides across the evidence
                  that exists rather than treating absent readings as neutral.
                </p>
              </div>
            </Collapsible>
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
      <div className="flex flex-col gap-3">
        {/* The plain sentence first; the full reasoning is one click below,
            so the reader learns WHAT before they can even see the HOW. */}
        <p className="text-[14px] leading-relaxed text-ink">{TRADE_PLAN_REFUSAL_SHORT[refusal]}</p>

        {refusal === "earnings-imminent" && earnings && (
          <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[13px] leading-relaxed text-ink">
            <span className="font-semibold uppercase tracking-[0.12em] text-amber">Reports</span> ·{" "}
            {earnings.date} —{" "}
            {earnings.sessions === 0
              ? "today"
              : earnings.sessions === 1
                ? "the next trading day"
                : `${earnings.sessions} trading days away`}
            . A plan comes back on its own once the report is out.
          </p>
        )}

        <p className="text-[12px] leading-relaxed text-ink-muted">
          This is the engine declining, not failing. A plan appears when price moves into a position that
          supports one — which usually means waiting for it to come to a level, rather than waiting for the
          read to change.
        </p>

        <Collapsible title="The full reasoning" summary="why this bar exists at all">
          <p className="text-xs leading-relaxed text-ink-muted">{TRADE_PLAN_REFUSAL_TEXT[refusal]}</p>
        </Collapsible>
      </div>
    );
  }

  const distance = Math.abs(bias.score - 50);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] leading-relaxed text-ink">
        There is no direction to build a plan on. The evidence for up and the evidence for down roughly
        cancel out.
      </p>
      <p className="text-[12px] leading-relaxed text-ink-muted">
        The score sits at {bias.score}, {distance.toFixed(0)} point{distance === 1 ? "" : "s"} away from dead
        neutral — inside the band where this engine treats the evidence as balanced rather than leaning. It
        would need to reach {50 + DIRECTIONAL_THRESHOLD} or {50 - DIRECTIONAL_THRESHOLD} before a side is
        worth committing to. Inventing a trade from {bias.score} is exactly the false confidence this engine
        exists to refuse.
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
