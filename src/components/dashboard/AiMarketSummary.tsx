"use client";

import { ArrowUpRight, ArrowDownRight, Pause, Minus, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { Collapsible } from "@/components/ui/Collapsible";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { topReasons, RankedReason } from "@/lib/signals/marketBias";
import { buildTradeRecommendation, TradeRecommendation } from "@/lib/signals/tradeRecommendation";
import { MarketThesis, TechnicalRead, AggregateMarketData } from "@/types/market";
import { TradePlan, buildEntryQualityView, starGrade, EntryQualityView } from "./EntryQualityCard";
import { intensityLabel } from "@/lib/signals/scoring";
import { technicalAgreement, TechnicalAgreement } from "@/lib/sentiment/technicals";
import { technicalDimensions, DimensionStance } from "@/lib/sentiment/technicalDimensions";
import { lookupBiasVerdictStat, lookupCalibrationBucket, ExecutionStatsSnapshot } from "@/lib/sentiment/backtestStats";
import { RegimeTags } from "@/lib/technicals/regimes";
import { BiasHistoryEntry } from "@/lib/history/biasHistory";
import { TimelineList } from "./MarketThesisTimeline";
import backtestStats from "@/data/backtestStats.json";
import executionStatsJson from "@/data/executionStats.json";

const executionStats = executionStatsJson as unknown as ExecutionStatsSnapshot;

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
  aggregate,
  bias,
  thesis,
  technicals,
  technicals4h,
  timeline,
}: {
  /** The whole aggregate, so the trade plan can render on this same surface rather than in a second card further down the page. */
  aggregate: AggregateMarketData;
  bias: MarketBias | null;
  thesis: MarketThesis | null;
  technicals: TechnicalRead | null;
  /** Live-only higher-timeframe (4H) read — see okxCandles.ts. Null whenever unavailable; every consumer already treats that as "nothing to show," same as `technicals` itself. */
  technicals4h?: TechnicalRead | null;
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
  const recommendation = buildTradeRecommendation(bias, thesis, technicals, technicals4h ?? null);
  // Resolved once here, then shared: the star rating renders beside the
  // ACTION while the levels render below it, without running
  // buildEntryQuality() twice over identical inputs.
  const entryView = buildEntryQualityView(aggregate, recommendation);

  return (
    <Card>
      <CardContent className="flex flex-col gap-7 py-6">
        <Decision bias={bias} thesis={thesis} recommendation={recommendation} entryView={entryView} />

        <TradePlan aggregate={aggregate} view={entryView} />

        <TopReasons reasons={reasons} />

        <TechnicalConfirmation technicals={technicals} technicals4h={technicals4h ?? null} thesis={thesis} />

        <ContradictingEvidence
          metric={bias.counterRisk}
          rationale={bias.riskRationale}
          technicals={technicals}
          technicals4h={technicals4h ?? null}
          thesis={thesis}
        />

        <InvalidationLevel watchNext={bias.watchNext} invalidationLines={invalidationLines} />

        {/*
          Everything below is Level 4/5 — supporting intelligence and raw
          detail. It sits behind disclosure so a trader answering "what do I
          do" never has to read past it. The two backtest/calibration
          paragraphs used to render inline directly under the score, putting
          ~90 words of statistics between the decision and the evidence.
        */}
        <div className="border-t border-hairline pt-5">
          <Collapsible title="Historical context" summary="backtested reliability, confidence calibration">
            <div className="flex flex-col gap-3 pt-2">
              <BiasBacktestStatLine verdict={bias.verdict} />
              <ConfidenceCalibrationLine confidence={bias.confidence} />
            </div>
          </Collapsible>
        </div>

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
  // A real directional thesis exists and technicals just haven't caught up
  // — amber, "watching for confirmation."
  "wait-long-confirmation": { border: "border-amber/30", bg: "bg-amber/[0.06]", text: "text-amber", Icon: Pause },
  "wait-short-confirmation": { border: "border-amber/30", bg: "bg-amber/[0.06]", text: "text-amber", Icon: Pause },
  // No real directional lean yet — a distinct, quieter neutral/gray
  // treatment, not "close, just watching."
  "no-trade": { border: "border-hairline", bg: "bg-surface-2", text: "text-ink-muted", Icon: Minus },
};

/**
 * LEVEL 1 — the decision, and the only thing on this card allowed to
 * dominate visually.
 *
 * Previously the ACTION rendered at text-sm inside a banner while the
 * composite score rendered at text-5xl directly beneath it, so the largest
 * element on the page was a 0-100 number rather than "what should I do."
 * A trader scanning for five seconds read "47" before "NO TRADE". The
 * action now leads at display size and the score is demoted to a
 * supporting qualifier beside the verdict, where it belongs: the score
 * explains the action, it is not the answer.
 *
 * Merged from what used to be two separate stacked blocks (action banner +
 * header) because they were answering one question between them, and the
 * split forced the eye through a size inversion to assemble it.
 *
 * Gated on both layers agreeing (see tradeRecommendation.ts): ENTER
 * LONG/SHORT only when the market thesis AND technical confirmation agree;
 * otherwise a WAIT state with the real reason and next trigger cited.
 */
function Decision({
  bias,
  thesis,
  recommendation,
  entryView,
}: {
  bias: MarketBias;
  thesis: MarketThesis | null;
  recommendation: TradeRecommendation;
  /** Null whenever no trade qualifies — the star row simply doesn't render, rather than showing an empty rating. */
  entryView: EntryQualityView | null;
}) {
  const style = ACTION_STYLE[recommendation.action];
  const { Icon } = style;

  return (
    <div className="flex flex-col gap-4">
      <span className="text-[11px] uppercase tracking-[0.22em] text-ink-muted">
        {bias.asset} · {thesis ? thesis.regime : "Market Read"}
      </span>

      <div className={`flex flex-col gap-3 rounded-lg border ${style.border} ${style.bg} px-4 py-4`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5">
            <Icon className={`h-6 w-6 shrink-0 ${style.text}`} aria-hidden />
            <span className={`text-2xl font-bold uppercase leading-none tracking-[0.04em] sm:text-3xl ${style.text}`}>
              {recommendation.label}
            </span>
          </div>
          {/*
            The score rides ALONGSIDE the verdict rather than above it, at
            a size that reads as a qualifier. Same numbers as before, an
            order of magnitude less visual weight.
          */}
          <div className="flex items-baseline gap-2.5">
            <VerdictBadge verdict={bias.verdict} size="sm" />
            <span className="font-mono text-lg leading-none text-ink">{bias.score}</span>
            <span className="text-[11px] text-ink-faint">{intensityLabel(bias.score)}</span>
            <span className="text-[11px] text-ink-faint" title="How good the evidence behind this read is — not the odds of a move.">
              · Confidence {bias.confidence}%
            </span>
          </div>
        </div>

        {/*
          ENTRY QUALITY sits directly beneath the ACTION, which is the
          single most-requested change in this pass. It used to live in a
          separate card further down the page, so the rating of a setup
          was nowhere near the setup it rated.
        */}
        {entryView && (
          <div className="flex items-center gap-2.5 border-t border-hairline/60 pt-3">
            <span className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">Entry quality</span>
            <span className="flex items-center gap-0.5" aria-label={`${entryView.eq.stars} out of 5 stars`}>
              {[1, 2, 3, 4, 5].map((i) => (
                <Star key={i} className={`h-3.5 w-3.5 ${i <= entryView.eq.stars ? "fill-amber text-amber" : "text-ink-faint/40"}`} />
              ))}
            </span>
            <span className="text-xs text-ink-muted">{starGrade(entryView.eq.stars)}</span>
          </div>
        )}

        <p className="text-[13px] leading-relaxed text-ink-muted">{recommendation.reason}</p>
        {recommendation.nextTrigger && (
          <p className="text-[12px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Next trigger:</span> {recommendation.nextTrigger}
          </p>
        )}
      </div>

      {/* Secondary qualifiers — real information, but none of them is the decision. */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Stat label="Agreement" value={`${bias.agreement}%`} hint="How much the metrics concur with each other." />
        {bias.trendStrength && (
          <Stat label="Trend Strength" value={bias.trendStrength.label} hint="How strongly price action itself is trending, from the technical read." />
        )}
        <Stat
          label="Risk"
          value={bias.riskLevel.toUpperCase()}
          hint={bias.riskRationale}
          tone={bias.riskLevel === "high" ? "danger" : bias.riskLevel === "medium" ? "amber" : "success"}
        />
        {thesis?.regimeTags && (
          <Stat
            // Deliberately NOT "Market Regime" — that word already labels
            // the qualitative regime name above (e.g. "CONSOLIDATION"), a
            // different concept (directional lean vs. today's trend/
            // volatility classification).
            label="Trend / Vol"
            value={regimeBadgeText(thesis.regimeTags)}
            hint="Today's trend/volatility classification — the same one every metric's backtested Best/Worst Environment is measured against."
          />
        )}
      </div>

      <ScoreBar score={bias.score} />
    </div>
  );
}

/**
 * Same pattern already shipped on PositioningIntelligence's squeeze read and
 * CategoryCard's category read: only renders once the backtested bucket
 * clears MIN_SAMPLE_N, so a thin bucket says nothing rather than stating a
 * number with false confidence.
 */
/**
 * What the confidence score has ACTUALLY been worth, rather than what a
 * 0-100 number sitting beside a market call implies.
 *
 * marketBias.ts is careful to define confidence as evidence quality, not
 * probability — but a reader sees "64" next to a direction and reads "64%
 * likely." Phase 3 measured it: over the backtested window the score is
 * neither calibrated (observed rates miss the implied probability by ~13
 * points) nor cleanly monotonic. Rather than quietly leaving the wrong
 * reading available, this states the measured rate for the band the live
 * score falls in, and says plainly when the score should not be read as a
 * probability.
 *
 * Renders nothing when the band was too thin to measure — silence is the
 * honest output there, not a hedged guess.
 */
function ConfidenceCalibrationLine({ confidence }: { confidence: number }) {
  const bucket = lookupCalibrationBucket(executionStats, confidence);
  if (!bucket) return null;
  const notProbability = executionStats.calibration24h.meanAbsoluteCalibrationErrorPct !== null &&
    executionStats.calibration24h.meanAbsoluteCalibrationErrorPct > 5;
  return (
    <p className="max-w-4xl text-[13px] leading-relaxed text-ink-faint">
      Days scoring {bucket.label} on confidence went on to move in the read&apos;s direction{" "}
      {bucket.observedRatePct.toFixed(0)}% of the time over the next 24h (N={bucket.n}, 95% CI{" "}
      {(bucket.interval.lower * 100).toFixed(0)}-{(bucket.interval.upper * 100).toFixed(0)}%).
      {notProbability
        ? " Confidence measures how good the evidence is, not the odds of a move — historically it has not tracked outcome rates closely enough to read as a probability."
        : ""}
    </p>
  );
}

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

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  /** Only Risk gets a tone — it's the one stat here that's inherently good/bad, not just informational (Confidence/Agreement/Trend Strength/Trend-Vol regime are neutral facts, not alarms). */
  tone?: "success" | "amber" | "danger";
}) {
  const toneClass = tone === "success" ? "text-success" : tone === "amber" ? "text-amber" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
      <span className={`font-mono text-lg leading-none ${toneClass}`}>{value}</span>
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

/**
 * WHY, as scannable chips rather than five full sentences.
 *
 * The default view answers "which forces are driving this, and which way
 * does each lean" — that is what a trader needs at this altitude. The
 * per-metric explanation sentences are real and still available, one click
 * away; inline they turned the primary decision surface into five
 * paragraphs of reading between the trade plan and the technicals.
 *
 * The lone contradiction is called out in one line, because "what argues
 * against this" deserves naming even in the compact view.
 */
function TopReasons({ reasons }: { reasons: RankedReason[] }) {
  if (reasons.length === 0) {
    return (
      <div className="border-t border-hairline pt-5">
        <SectionLabel>Why</SectionLabel>
        <p className="mt-3 text-xs text-ink-faint">No metric currently reports enough evidence to rank.</p>
      </div>
    );
  }

  const leading = reasons[0];
  const against = reasons.filter((r) => r.side !== leading.side);

  return (
    <div className="border-t border-hairline pt-5">
      <SectionLabel>Why</SectionLabel>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {reasons.map((r) => (
          <li key={r.id} className="flex items-center gap-1.5 text-xs">
            <span aria-hidden className={r.side === "bullish" ? "text-success" : "text-danger"}>
              {r.side === "bullish" ? "▲" : "▼"}
            </span>
            <span className="text-ink">{r.label}</span>
            <span className="sr-only">{r.side}</span>
          </li>
        ))}
      </ul>

      {against.length > 0 && (
        <p className="mt-2.5 text-[11px] leading-relaxed text-ink-faint">
          {against[0].label} is the main contradiction.
        </p>
      )}

      <div className="mt-2">
        <Collapsible title="Why in detail" summary={`${reasons.length} drivers`}>
          <ul className="flex flex-col gap-2.5 pt-2">
            {reasons.map((r) => (
              <li key={r.id} className="flex items-start gap-2 text-xs leading-relaxed">
                <span className={r.side === "bullish" ? "shrink-0 text-success" : "shrink-0 text-danger"}>
                  {r.label}
                </span>
                <span className="text-ink-faint"> — {r.explanation}</span>
              </li>
            ))}
          </ul>
        </Collapsible>
      </div>
    </div>
  );
}

/* ── Technical confirmation: does price action back the other metrics? ── */

const AGREEMENT_CONFIG: Record<TechnicalAgreement, { label: string; dot: string; text: string }> = {
  confirms: { label: "CONFIRMS", dot: "🟢", text: "text-success" },
  weakens: { label: "WEAKENS", dot: "🟠", text: "text-amber" },
  contradicts: { label: "CONTRADICTS", dot: "🔴", text: "text-danger" },
  "not-yet-confirmed": { label: "NOT YET CONFIRMED", dot: "🟡", text: "text-amber" },
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
 * vocabulary — CONFIRMS/WEAKENS/CONTRADICTS/NOT YET CONFIRMED describe
 * agreement, not bullish/bearish/neutral direction, so it deliberately isn't
 * a VerdictBadge. WEAKENS reuses the same amber token as NOT YET CONFIRMED
 * (a distinct dot color is enough to tell them apart at a glance) rather
 * than inventing a new UI color for a state that's still "proceed with
 * caution," not "stop."
 */
function TechnicalConfirmation({
  technicals,
  technicals4h,
  thesis,
}: {
  technicals: TechnicalRead | null;
  /** Live-only, optional — see okxCandles.ts. Rendered as a secondary qualifier line, never a competing verdict; per the multi-timeframe spec, HTF disagreement is context the trader weighs, not an override of the daily read. */
  technicals4h: TechnicalRead | null;
  thesis: MarketThesis | null;
}) {
  if (!technicals || !thesis || thesis.technicalConfirmation.length === 0) return null;

  const agreement = technicalAgreement(technicals, thesis.dominant);
  const config = AGREEMENT_CONFIG[agreement];
  const htfAgreement = technicals4h ? technicalAgreement(technicals4h, thesis.dominant) : null;
  const htfConfig = htfAgreement ? AGREEMENT_CONFIG[htfAgreement] : null;

  return (
    <div className="border-t border-hairline pt-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <SectionLabel>Technical confirmation</SectionLabel>
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wider ${config.text}`}>
            <span aria-hidden>{config.dot}</span>
            {config.label}
          </span>
        </div>
        {/*
          Escalated to the SAME size/weight as the primary daily badge
          specifically when the two timeframes disagree — a real daily/4H
          conflict is exactly the case the multi-timeframe spec wants
          unmissable, not a footnote. When 4H simply confirms (the
          unsurprising case), it stays a quiet secondary line so it doesn't
          compete with the daily verdict for attention.
        */}
        {htfConfig &&
          (htfAgreement === "weakens" || htfAgreement === "contradicts" ? (
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wider ${htfConfig.text}`}>
              <span className="text-ink-faint">4H:</span>
              <span aria-hidden>{htfConfig.dot}</span>
              {htfConfig.label}
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1 text-[10px] tracking-wide ${htfConfig.text}`}>
              <span className="text-ink-faint">4H:</span>
              <span aria-hidden>{htfConfig.dot}</span>
              {htfConfig.label}
            </span>
          ))}
      </div>
      {/*
        The per-indicator grid, so "CONTRADICTS" above is never an
        unexplained badge — a trader can see WHICH dimensions disagree
        without reading prose. Every stance comes from
        technicalDimensions(), which imports its thresholds from
        technicals.ts so this grid cannot drift from the verdict it sits
        under. Stance is carried by an explicit text label as well as
        colour, never colour alone.
      */}
      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
        {technicalDimensions(technicals, thesis.dominant).map((d) => {
          const s = DIMENSION_STANCE[d.stance];
          return (
            <div key={d.label} className="flex items-baseline justify-between gap-3 border-b border-hairline/40 py-1">
              <dt className="shrink-0 text-xs text-ink">{d.label}</dt>
              <dd className="flex min-w-0 items-baseline gap-2 text-right">
                <span className="truncate text-[11px] text-ink-faint">{d.detail}</span>
                <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${s.text}`}>
                  <span aria-hidden>{s.dot}</span> {s.label}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>

      {/*
        Non-negotiable caption. These six are the dimensions a trader
        scans, but buildTechnicalRead's composite also weighs Supertrend,
        Parabolic SAR, Ichimoku, Stochastic, OBV, Bollinger and VWAP. Left
        unsaid, a reader seeing two rows marked AGAINST beneath a CONFIRMS
        badge concludes the badge is broken — observed exactly that on the
        live BTC read while building this. Saying which votes are shown
        costs one line and keeps the two honest with each other.
      */}
      <p className="mt-2 text-[10px] leading-relaxed text-ink-faint/75">
        The six readings traders scan most. The verdict above weighs these plus Supertrend,
        Parabolic SAR, Ichimoku, Stochastic, OBV, Bollinger and VWAP, so it can differ from any
        single row here.
      </p>

      {/*
        Only the FIRST line survives inline — it is the synthesised
        conclusion ("price action confirms the bullish thesis"). Lines 2-4
        restated individual indicator readings that the grid above now
        shows at a glance, so keeping them meant saying the same thing
        twice in two formats. The rest stay one click away.
      */}
      {thesis.technicalConfirmation.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-ink">{thesis.technicalConfirmation[0]}</p>
      )}
      {thesis.technicalConfirmation.length > 1 && (
        <div className="mt-2">
          <Collapsible title="Indicator notes" summary={`${thesis.technicalConfirmation.length - 1} more`}>
            <ul className="flex flex-col gap-2 pt-2">
              {thesis.technicalConfirmation.slice(1).map((line, i) => (
                <li key={i} className="text-xs leading-relaxed text-ink-faint">
                  {line}
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

/** Compact per-dimension stance styling. Text label always accompanies the colour so the state never depends on colour perception alone. */
const DIMENSION_STANCE: Record<DimensionStance, { dot: string; label: string; text: string }> = {
  confirms: { dot: "🟢", label: "Confirms", text: "text-success" },
  weakens: { dot: "🟠", label: "Weakens", text: "text-amber" },
  contradicts: { dot: "🔴", label: "Against", text: "text-danger" },
  neutral: { dot: "⚪", label: "Neutral", text: "text-ink-faint" },
  unavailable: { dot: "—", label: "No data", text: "text-ink-faint" },
};

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

function ContradictingEvidence({
  metric,
  rationale,
  technicals,
  technicals4h,
  thesis,
}: {
  metric: MetricVerdict | null;
  rationale?: string;
  technicals: TechnicalRead | null;
  technicals4h: TechnicalRead | null;
  thesis: MarketThesis | null;
}) {
  /*
   * Price action counts as contradicting evidence.
   *
   * This section used to read only `bias.counterRisk` — a METRIC-level
   * disagreement — so the card could simultaneously render "TECHNICAL
   * CONFIRMATION: CONTRADICTS" and, three lines below, "Nothing material
   * is arguing the other way right now." Observed live on BTC. Whatever
   * else that is, it isn't true, and a trader who notices it stops
   * trusting the rest of the card. Technical and multi-timeframe
   * disagreement are now surfaced here as the first-class objections they
   * are, reusing the same technicalAgreement() the badge above uses so the
   * two can never disagree.
   */
  const objections: string[] = [];
  if (technicals && thesis) {
    const agreement = technicalAgreement(technicals, thesis.dominant);
    if (agreement === "contradicts") {
      objections.push("Price action argues against the thesis — the daily technical read points the other way.");
    } else if (agreement === "weakens") {
      objections.push("Momentum is diverging against the thesis, so price action isn't fully backing it.");
    }
    if (technicals4h) {
      const htf = technicalAgreement(technicals4h, thesis.dominant);
      if (htf === "contradicts") {
        objections.push("The 4-hour higher-timeframe read disagrees with this direction.");
      } else if (htf === "weakens") {
        objections.push("The 4-hour read is weakening against this direction.");
      }
    }
  }

  if (!metric && !rationale && objections.length === 0) return null;

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
        objections.length === 0 && (
          <p className="text-xs leading-relaxed text-ink-faint">Nothing material is arguing the other way right now.</p>
        )
      )}
      {objections.map((line) => (
        <p key={line} className="text-xs leading-relaxed text-ink-faint">
          {line}
        </p>
      ))}
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
      {/*
        The explainer paragraph that used to sit here ("what would flip this
        broader market read — distinct from the trade-level stop...") is
        gone. The distinction is now carried by the two labels themselves,
        which sit on the same surface a few rows apart: "Trade invalidation"
        in the plan above, "Thesis invalidation" here. Two labels beat a
        sentence explaining that two labels differ.
      */}
      <SectionLabel>Thesis invalidation</SectionLabel>

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

      {/*
        Merged into the list above rather than kept as its own "What would
        invalidate this" heading. Two consecutive headings both answering
        "what breaks this read" read as two different concepts and made the
        section twice as long as the idea inside it. These are the same
        idea stated at thesis level, so they now continue the same list,
        visually subordinate to the named metric triggers above them.
      */}
      {invalidationLines.slice(0, 2).map((line, i) => (
        <p key={i} className="mt-2 text-xs leading-relaxed text-ink-faint">
          {line}
        </p>
      ))}
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
