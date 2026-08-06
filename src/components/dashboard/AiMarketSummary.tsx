"use client";

import { ArrowUpRight, ArrowDownRight, Pause } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { Collapsible } from "@/components/ui/Collapsible";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { topReasons, RankedReason } from "@/lib/signals/marketBias";
import { buildTradeRecommendation, TradeRecommendation } from "@/lib/signals/tradeRecommendation";
import { MarketThesis, TechnicalRead } from "@/types/market";
import { intensityLabel } from "@/lib/signals/scoring";
import { technicalAgreement, TechnicalAgreement } from "@/lib/sentiment/technicals";
import { lookupBiasVerdictStat } from "@/lib/sentiment/backtestStats";
import { RegimeTags } from "@/lib/technicals/regimes";
import { BiasHistoryEntry } from "@/lib/history/biasHistory";
import { TimelineList } from "./MarketThesisTimeline";
import backtestStats from "@/data/backtestStats.json";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Compact form for the header stat row — "Bull · Normal Vol", optionally + "Range-Bound". Distinct from HistoricalPerformancePanel's longer "Bull Markets"/"Normal Volatility" labels, which have more room. */
function regimeBadgeText(tags: RegimeTags): string {
  const parts = [capitalize(tags.trend), `${capitalize(tags.volatility)} Vol`];
  if (tags.rangeBound) parts.push("Range-Bound");
  return parts.join(" · ");
}

/**
 * The dashboard's single "what's the highest-probability direction right
 * now, and why" surface — replaces the old sticky `MarketSnapshotBar` AND
 * the full `MarketBriefing` card, which between them showed overlapping
 * verdict/confidence/reasoning in two different places. One card now, not
 * sticky (the full Score/Direction/Confidence/Top-5/trade-bias/invalidation/
 * risk shape is too much content to usefully pin across a long scroll — a
 * sticky version of this would just be the old snapshot bar under a new
 * name, the exact "two overlapping summaries" problem this collapses).
 *
 * Every field is a relabel of MarketBias's own output, not a new
 * computation — see marketBias.ts's `topReasons()` for the one small new
 * merge helper this needed (interleaving topBullish/topBearish into one
 * ranked list instead of two columns).
 */
export function AiMarketSummary({
  bias,
  thesis,
  technicals,
  timeline,
}: {
  bias: MarketBias | null;
  thesis: MarketThesis | null;
  technicals: TechnicalRead | null;
  /** Optional — when provided, renders an expandable "today's trajectory" panel absorbing what used to be the standalone MarketThesisTimeline card. */
  timeline?: BiasHistoryEntry[];
}) {
  if (!bias) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm leading-relaxed text-ink-muted">
            Not enough metrics have reported yet to form a market read. This fills in
            automatically as funding, positioning, and flow data arrive.
          </p>
        </CardContent>
      </Card>
    );
  }

  const reasons = topReasons(bias, 5);
  const invalidationLines = thesis?.invalidation ?? [];
  const recommendation = buildTradeRecommendation(bias, thesis, technicals);

  return (
    <Card>
      <CardContent className="flex flex-col gap-7 py-6">
        <SuggestedActionBanner recommendation={recommendation} />

        <Header bias={bias} thesis={thesis} />

        <TopReasons reasons={reasons} />

        <TechnicalConfirmation technicals={technicals} thesis={thesis} />

        <ContradictingEvidence metric={bias.counterRisk} rationale={bias.riskRationale} />

        <InvalidationLevel watchNext={bias.watchNext} invalidationLines={invalidationLines} />

        {timeline && (
          <div className="border-t border-hairline pt-5">
            <Collapsible title="Today's trajectory" summary={`${timeline.length} shift${timeline.length === 1 ? "" : "s"}`}>
              <div className="flex flex-col gap-4 pt-2">
                <SinceLastUpdate bias={bias} />
                <TimelineList timeline={timeline} bias={bias} />
              </div>
            </Collapsible>
          </div>
        )}

        <p className="border-t border-hairline pt-4 text-xs leading-relaxed text-ink-faint">
          Weighted read of {bias.metrics.length} metrics, each scaled by how much evidence backs
          it. Not a probability, not a price target, not advice. Every figure here traces back to
          a value shown elsewhere on this page.
        </p>
      </CardContent>
    </Card>
  );
}

/* ── Suggested Action — the recommendation, appearing before any evidence ── */

const ACTION_STYLE: Record<TradeRecommendation["action"], { border: string; bg: string; text: string; Icon: typeof ArrowUpRight }> = {
  "enter-long": { border: "border-success/30", bg: "bg-success/[0.06]", text: "text-success", Icon: ArrowUpRight },
  "enter-short": { border: "border-danger/30", bg: "bg-danger/[0.06]", text: "text-danger", Icon: ArrowDownRight },
  wait: { border: "border-amber/30", bg: "bg-amber/[0.06]", text: "text-amber", Icon: Pause },
};

/**
 * The recommendation, first — per the charter's explicit rule, this
 * appears BEFORE the score/reasons/evidence below it, not after. Gated on
 * both layers agreeing (see tradeRecommendation.ts): only ENTER LONG/SHORT
 * when the market thesis AND technical confirmation both agree; otherwise
 * WAIT, with the real reason and next trigger cited, never a fabricated
 * setup.
 */
function SuggestedActionBanner({ recommendation }: { recommendation: TradeRecommendation }) {
  const style = ACTION_STYLE[recommendation.action];
  const { Icon } = style;

  return (
    <div className={`flex flex-col gap-2 rounded-lg border ${style.border} ${style.bg} px-4 py-3.5`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${style.text}`} />
        <span className={`text-sm font-bold uppercase tracking-[0.1em] ${style.text}`}>{recommendation.label}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-muted">{recommendation.reason}</p>
      {recommendation.nextTrigger && (
        <p className="text-[12px] leading-relaxed text-ink-faint">
          <span className="text-ink-muted">Next trigger:</span> {recommendation.nextTrigger}
        </p>
      )}
    </div>
  );
}

/* ── Score / Direction / Confidence + trade bias ─────────────────────── */

function Header({ bias, thesis }: { bias: MarketBias; thesis: MarketThesis | null }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-[0.22em] text-ink-muted">
            {bias.asset} · {thesis ? thesis.regime : "Market Read"}
          </span>
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-5xl font-semibold leading-none tracking-tight text-ink">
              {bias.score}
            </span>
            <VerdictBadge verdict={bias.verdict} size="lg" />
            <span className="text-xs text-ink-faint">{intensityLabel(bias.score)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-6">
          <Stat label="Confidence" value={`${bias.confidence}%`} hint="How good the evidence behind this read is — not the odds of a move." />
          <Stat label="Agreement" value={`${bias.agreement}%`} hint="How much the metrics concur with each other." />
          {bias.trendStrength && (
            <Stat label="Trend Strength" value={bias.trendStrength.label} hint="How strongly price action itself is trending, from the technical read." />
          )}
          <Stat label="Risk" value={bias.riskLevel.toUpperCase()} hint={bias.riskRationale} />
          {thesis?.regimeTags && (
            <Stat
              label="Market Regime"
              value={regimeBadgeText(thesis.regimeTags)}
              hint="Today's trend/volatility classification — the same one every metric's backtested Best/Worst Environment below is measured against."
            />
          )}
        </div>
      </div>

      <ScoreBar score={bias.score} />

      {/*
        Dashboard V2 product review: the `headline`/`regimeDescription`
        paragraphs that used to live here are gone — the Suggested Action
        banner above now states the same conclusion once, cleanly, first
        (buildTradeRecommendation's `reason` is literally bias.headline
        verbatim). Repeating it here was the card arguing with itself in
        five different renderings of the same fact. Only the backtest
        reliability line (real, distinct evidence) stays.
      */}
      <BiasBacktestStatLine verdict={bias.verdict} />
    </div>
  );
}

/**
 * Same pattern already shipped on PositioningIntelligence's squeeze read and
 * CategoryCard's category read: only renders once the backtested bucket
 * clears MIN_SAMPLE_N, so a thin bucket says nothing rather than stating a
 * number with false confidence.
 */
function BiasBacktestStatLine({ verdict }: { verdict: MarketBias["verdict"] }) {
  const stat = lookupBiasVerdictStat(backtestStats, verdict);
  if (!stat) return null;

  return (
    <p className="max-w-4xl text-[13px] leading-relaxed text-ink-faint">
      Historically, in the backtested window ({backtestStats.coverageStart} to{" "}
      {backtestStats.coverageEnd}, N={stat.n} days the overall read was {verdict}): price moved a
      mean {stat.mean1dPct >= 0 ? "+" : ""}
      {stat.mean1dPct.toFixed(1)}% over the next 24h. One narrow window, not a guarantee.
    </p>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
      <span className="font-mono text-lg leading-none text-ink">{value}</span>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  // Drawn outward from the midpoint so the bar encodes direction, not just
  // magnitude — 30 and 70 are equally strong reads pointing opposite ways.
  const offset = score - 50;
  const width = Math.abs(offset);
  const bullish = offset >= 0;

  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/25" />
      <div
        className={`absolute top-0 h-full ${bullish ? "bg-success" : "bg-danger"}`}
        style={{ left: bullish ? "50%" : `${50 - width}%`, width: `${width}%` }}
      />
    </div>
  );
}

/* ── Top 5 reasons (merged bullish + bearish, ranked together) ───────── */

function TopReasons({ reasons }: { reasons: RankedReason[] }) {
  return (
    <div className="border-t border-hairline pt-5">
      <SectionLabel>Top 5 reasons</SectionLabel>
      {reasons.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">No metric currently reports enough evidence to rank.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {reasons.map((r) => (
            <li key={r.id} className="flex items-start gap-2 text-xs leading-relaxed">
              <span className={r.side === "bullish" ? "shrink-0 text-success" : "shrink-0 text-danger"}>
                {r.label}
              </span>
              <span className="text-ink-faint"> — {r.explanation}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Technical confirmation: does price action back the other metrics? ── */

const AGREEMENT_CONFIG: Record<TechnicalAgreement, { label: string; dot: string; text: string }> = {
  agrees: { label: "CONFIRMS", dot: "🟢", text: "text-success" },
  conflicts: { label: "CONFLICTS", dot: "🔴", text: "text-danger" },
  neutral: { label: "NO CLEAR READ", dot: "🟡", text: "text-amber" },
};

/**
 * Every other section above is built from POSITIONING and flow metrics —
 * this is the one check on whether price itself is actually going along
 * with that story. Kept separate from `topReasons()` rather than folded in
 * as one more ranked reason, because its whole value is relational ("does
 * this agree with everything above") not standalone ("here is a fact").
 *
 * `agreement` reuses risk's precedent (VerdictBadge.tsx's own doc comment)
 * of a second, non-directional color axis layered on the same 3-color
 * vocabulary — CONFIRMS/CONFLICTS/NO CLEAR READ describe agreement, not
 * bullish/bearish/neutral direction, so it deliberately isn't a VerdictBadge.
 */
function TechnicalConfirmation({
  technicals,
  thesis,
}: {
  technicals: TechnicalRead | null;
  thesis: MarketThesis | null;
}) {
  if (!technicals || !thesis || thesis.technicalConfirmation.length === 0) return null;

  const agreement = technicalAgreement(technicals, thesis.dominant);
  const config = AGREEMENT_CONFIG[agreement];

  return (
    <div className="border-t border-hairline pt-5">
      <div className="flex items-center gap-2">
        <SectionLabel>Technical confirmation</SectionLabel>
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wider ${config.text}`}>
          <span aria-hidden>{config.dot}</span>
          {config.label}
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {thesis.technicalConfirmation.map((line, i) => (
          <li key={i} className={`text-xs leading-relaxed ${i === 0 ? "text-ink" : "text-ink-faint"}`}>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Contradicting evidence ────────────────────────────────────────────
 *
 * Product review: this used to be a two-column "Biggest opportunity /
 * Biggest risk" split. Opportunity was cut — `bias.opportunity` is
 * definitionally the #1-ranked metric on the aligned side, and "Top 5
 * reasons" above already surfaces it, usually at #1. Showing the same
 * metric twice (once as a one-line reason, once as a full paragraph) was
 * pure duplication. Risk survives because it's genuinely new information
 * — the strongest evidence AGAINST the read — and the user explicitly
 * wants contradicting evidence preserved. Restyled to match CategoryCard's
 * own "Contradicting evidence" box for visual consistency across the page.
 */

function ContradictingEvidence({ metric, rationale }: { metric: MetricVerdict | null; rationale?: string }) {
  if (!metric && !rationale) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber">
        Contradicting evidence
      </span>
      {metric ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-danger">{metric.label}</span>
            <ConfidenceLabel confidence={metric.confidence} basis={metric.confidenceBasis} />
          </div>
          <p className="text-xs leading-relaxed text-ink-faint">{metric.explanation}</p>
          <p className="text-xs leading-relaxed text-ink-faint/75">{metric.whyItMatters}</p>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-ink-faint">Nothing material is arguing the other way right now.</p>
      )}
      {rationale && <p className="text-xs leading-relaxed text-ink-faint/80">{rationale}</p>}
    </div>
  );
}

/* ── Invalidation level (watchNext + thesis.invalidation) ─────────────── */

function InvalidationLevel({
  watchNext,
  invalidationLines,
}: {
  watchNext: MetricVerdict[];
  invalidationLines: string[];
}) {
  return (
    <div className="border-t border-hairline pt-5">
      <SectionLabel>Invalidation level</SectionLabel>

      {watchNext.length === 0 && invalidationLines.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          No metric is close enough to a threshold to call out a level.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {/*
            Each trigger is read back out of the same band table that produced
            the verdict, so the level quoted here can never drift from the
            logic it describes. See bandTrigger in sentiment/bands.ts.
          */}
          {watchNext.map((m) => (
            <li key={m.id} className="text-xs leading-relaxed">
              <span className="text-ink">{m.label}</span>
              <span className="text-ink-faint"> — {m.nextTrigger}</span>
            </li>
          ))}
        </ul>
      )}

      {invalidationLines.length > 0 && (
        <>
          <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            What would invalidate this
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {invalidationLines.slice(0, 2).map((line, i) => (
              <li key={i} className="text-xs leading-relaxed text-ink-faint">
                {line}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/*
 * ── Since last update ──────────────────────────────────────────────────
 * Product review: demoted from its own always-visible top-level section
 * to a leading line inside "Today's trajectory" — it answers "what changed
 * since the last poll," which is about this tool's own polling cadence,
 * not the market, so it doesn't earn a place in the 30-second read. It
 * already had a natural home: this same Collapsible already covers
 * change-over-time.
 */
function SinceLastUpdate({ bias }: { bias: MarketBias }) {
  if (bias.isFirstReading) {
    return (
      <p className="text-xs leading-relaxed text-ink-faint">
        First reading for this asset — there is no earlier snapshot to compare against yet.
      </p>
    );
  }
  if (bias.changes.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-faint">
        No metric has flipped direction since the last reading.
      </p>
    );
  }
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">Since last update</span>
      <ul className="mt-2 flex flex-col gap-2">
        {bias.changes.map((c) => (
          <li key={c.label} className="flex items-baseline gap-2 text-xs leading-relaxed">
            <span className="text-ink">{c.label}</span>
            <span className="font-mono text-ink-faint">
              {c.from} → {c.to}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] uppercase tracking-[0.18em] text-ink-muted">{children}</span>;
}
