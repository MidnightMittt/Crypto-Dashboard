import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/Card";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { TradePlan } from "@/lib/signals/tradePlan";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { intensityLabel } from "@/lib/signals/scoring";
import { formatPrice } from "@/lib/utils/format";
import snapshot from "@/data/equityMarkets.json";

/**
 * MARKET DETAIL — the equity counterpart to an asset page.
 *
 * Everything here is the same engine's output, rendered in the same reading
 * order the crypto Decision Panel uses: decision, confidence, the engine's own
 * explanation, evidence both ways, then the trade plan and what invalidates it.
 *
 * The evidence is grouped by category rather than listed flat, which is what
 * makes the smaller equity evidence base legible: a reader can see that
 * Positioning is EMPTY because derivatives have no equity analogue, rather
 * than wondering whether it was simply omitted.
 */

interface MarketDecision {
  symbol: string;
  name: string;
  bias: MarketBias;
  lastClose: number;
  change24hPct: number;
  asOf: number;
  plan: TradePlan | null;
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
  const tone =
    bias.verdict === "bullish" ? "text-success" : bias.verdict === "bearish" ? "text-danger" : "text-ink-muted";
  const leadSide = bias.verdict === "bearish" ? bias.topBearish : bias.topBullish;
  const againstSide = bias.verdict === "bearish" ? bias.topBullish : bias.topBearish;

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
              </span>
              <span className="font-mono text-lg leading-none text-ink">{bias.score}</span>
              <span className="text-[11px] text-ink-faint">
                / 100 · Confidence {bias.confidence}% · Agreement {bias.agreement}%
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-ink">{bias.headline}</p>
          </CardContent>
        </Card>

        {/* ── EVIDENCE, GROUPED ─────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-4 py-5">
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

            <div className="border-t border-hairline pt-3">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                Every reading, with its reasoning
              </h3>
              <ul className="mt-2 flex flex-col gap-2.5">
                {bias.metrics.map((m) => (
                  <li key={m.id} className="text-xs leading-relaxed">
                    <span className="text-ink">{m.label}</span>{" "}
                    <span
                      className={
                        m.verdict === "bullish"
                          ? "text-success"
                          : m.verdict === "bearish"
                            ? "text-danger"
                            : "text-ink-faint"
                      }
                    >
                      {m.verdict.toUpperCase()}
                    </span>{" "}
                    <span className="text-ink-faint">· conf {m.confidence}%</span>
                    <p className="mt-0.5 text-ink-muted">{m.explanation}</p>
                  </li>
                ))}
              </ul>
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
            </p>
          </CardContent>
        </Card>

        {/* ── TRADE PLAN ────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-5">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">Trade plan</h2>
            {plan ? (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
                  <PlanStat label="Entry" value={`${formatPrice(plan.entryLow)}–${formatPrice(plan.entryHigh)}`} />
                  <PlanStat label="Stop" value={formatPrice(plan.stopPrice)} tone="text-danger" />
                  <PlanStat label="Target 1" value={formatPrice(plan.target1Price)} tone="text-success" />
                  <PlanStat label="Target 2" value={formatPrice(plan.target2Price)} tone="text-success" />
                  <PlanStat label="Risk / Reward" value={`${plan.riskRewardRatio.toFixed(2)}R`} />
                  <PlanStat label="Horizon" value="Days to weeks" />
                </div>
                <p className="rounded-md border border-warn/20 bg-warn/[0.04] px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
                  <span className="font-semibold uppercase tracking-[0.12em] text-warn">Invalidation</span> · A close
                  beyond {formatPrice(plan.stopPrice)} ends this thesis. That level sits past the structure the plan
                  is built on, so losing it means the reason for the trade is gone — not merely that price moved.
                </p>
                {/*
                  The star rating is deliberately caveated rather than shown
                  bare. Its historical-win-rate input is null for equities.
                */}
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  Geometry is the same `buildTradePlan` the crypto side uses — structural stop beyond the
                  protective zone, targets at structure, R:R re-measured from the real entry.{" "}
                  <span className="text-ink-muted">
                    Its quality rating is computed WITHOUT a historical win rate:
                  </span>{" "}
                  there is no equity backtest yet, so the one input that measures whether comparable trades
                  actually finished green is absent. Treat the geometry as sound and the rating as incomplete.
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-ink-muted">
                No plan. The engine reads {intensityLabel(bias.score).toLowerCase()} here, and a trade plan
                needs a direction — manufacturing one from a score of {bias.score} would be exactly the false
                precision this engine refuses. A plan appears when the read becomes directional.
              </p>
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
