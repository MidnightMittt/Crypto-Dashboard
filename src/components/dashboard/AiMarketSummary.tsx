"use client";

import { ArrowUpRight, ArrowDownRight, Pause, Minus, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { Collapsible } from "@/components/ui/Collapsible";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { topReasons, RankedReason } from "@/lib/signals/marketBias";
import { buildTradeRecommendation, TradeRecommendation, SuggestedAction } from "@/lib/signals/tradeRecommendation";
import { MarketThesis, TechnicalRead, AggregateMarketData } from "@/types/market";
import { TradePlan, swingTradePlanView, starGrade, EntryQualityView } from "./EntryQualityCard";
import { buildSwingView, shortTermCondition, SwingView, SwingTone } from "@/lib/signals/swingPresentation";
import { intensityLabel } from "@/lib/signals/scoring";
import { technicalAgreement, TechnicalAgreement } from "@/lib/sentiment/technicals";
import {
  technicalDimensions,
  timeframeRead,
  multiTimeframeVerdict,
  DimensionStance,
  Lean,
} from "@/lib/sentiment/technicalDimensions";
import { lookupBiasVerdictStat, ExecutionStatsSnapshot } from "@/lib/sentiment/backtestStats";
import { ScoreCalibrationLine } from "./ScoreCalibrationLine";
import { planConstraintsFor, PlannerStatsSnapshot } from "@/lib/signals/planConstraints";
import { RegimeTags, regimeTagsToStrings } from "@/lib/technicals/regimes";
import { BiasHistoryEntry } from "@/lib/history/biasHistory";
import { HarmonicEvidence } from "@/lib/signals/harmonicEvidence";
import { formatPrice } from "@/lib/utils/format";
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
  /*
   * The EV constraint for the bias direction, so the top-of-page word can
   * never recommend a side whose own replayed record loses money (same
   * gate the plan machinery applies; same published cells). Crypto only —
   * planConstraintsFor itself returns null without regime tags, and the
   * cells were measured on the replayed universe.
   */
  const evConstraint =
    bias.verdict !== "neutral" && thesis?.regimeTags
      ? planConstraintsFor(
          bias.verdict === "bullish" ? "long" : "short",
          regimeTagsToStrings(thesis.regimeTags),
          (executionStatsJson as { planner?: PlannerStatsSnapshot }).planner
        )
      : null;
  const recommendation = buildTradeRecommendation(bias, thesis, technicals, technicals4h ?? null, evConstraint);

  /*
   * The SWING thesis is the decision now, not the stateless recommendation.
   *
   * `buildTradeRecommendation` above is still computed and still shown — as
   * the TACTICAL read, one line, clearly subordinate. It changed ~7 times a
   * day in production, which is useful context and a terrible headline for
   * a trade meant to be held for days.
   */
  const swing = buildSwingView(aggregate.swingThesis, aggregate.updatedAt);

  /*
   * Levels come from the FROZEN plan whenever a swing thesis stands, so
   * repeated polls cannot move entry, stop or targets. Only when no thesis
   * exists does the live, tick-derived plan render — and then only as
   * reference structure, never as a standing instruction.
   */
  const entryView = swing.state ? swingTradePlanView(swing.state) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-7 py-6">
        <Decision bias={bias} thesis={thesis} swing={swing} recommendation={recommendation} entryView={entryView} />

        <TradePlan aggregate={aggregate} view={entryView} />

        <TopReasons reasons={reasons} />

        <TechnicalConfirmation
          technicals={technicals}
          technicals4h={technicals4h ?? null}
          thesis={thesis}
          harmonic={aggregate.harmonic ?? null}
        />

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
          <Collapsible title="Historical context" summary="backtested reliability by verdict">
            <div className="flex flex-col gap-3 pt-2">
              <BiasBacktestStatLine verdict={bias.verdict} />
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

/**
 * The one-glance verdict: emoji + word, the largest element on the page.
 *
 * The word is the GATED action from tradeRecommendation.ts, deliberately
 * not the raw bias verdict — the recommendation already requires the
 * composite to clear the directional threshold AND technicals to confirm,
 * and lets a divergence veto it, so this word can never green-light a read
 * the engine's own machinery refuses to act on. The emoji is the color
 * carrier by explicit product direction: deep knowledge, simple interface.
 */
const VERDICT_DISPLAY: Record<SuggestedAction, { emoji: string; word: string; tone: string }> = {
  "enter-long": { emoji: "\u{1F7E2}", word: "Long", tone: "text-success" },
  "enter-short": { emoji: "\u{1F534}", word: "Short", tone: "text-danger" },
  "wait-long-confirmation": { emoji: "\u{1F7E1}", word: "Wait", tone: "text-amber" },
  "wait-short-confirmation": { emoji: "\u{1F7E1}", word: "Wait", tone: "text-amber" },
  "no-trade": { emoji: "\u26AA", word: "Stand Aside", tone: "text-ink-muted" },
};

function VerdictStrip({ recommendation }: { recommendation: TradeRecommendation }) {
  const v = VERDICT_DISPLAY[recommendation.action];
  return (
    <div className="flex items-center gap-3">
      <span className="text-3xl leading-none sm:text-4xl" aria-hidden>
        {v.emoji}
      </span>
      <span className={`text-3xl font-black uppercase leading-none tracking-[0.05em] sm:text-4xl ${v.tone}`}>
        {v.word}
      </span>
    </div>
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
 * Tone for the SWING headline. Deliberately a separate map from
 * ACTION_STYLE above: that one is keyed by the stateless action, which now
 * renders as a small tactical line, and collapsing the two would tie the
 * loudest element on the page back to the fastest-moving input — the exact
 * coupling this refactor removes.
 */
const SWING_STYLE: Record<SwingTone, { border: string; bg: string; text: string; Icon: typeof ArrowUpRight }> = {
  long: { border: "border-success/30", bg: "bg-success/[0.06]", text: "text-success", Icon: ArrowUpRight },
  short: { border: "border-danger/30", bg: "bg-danger/[0.06]", text: "text-danger", Icon: ArrowDownRight },
  // Ran away without filling: a real warning, but not a loss — amber.
  warn: { border: "border-amber/30", bg: "bg-amber/[0.06]", text: "text-amber", Icon: Pause },
  danger: { border: "border-danger/40", bg: "bg-danger/[0.08]", text: "text-danger", Icon: Minus },
  neutral: { border: "border-hairline", bg: "bg-surface-2", text: "text-ink-muted", Icon: Minus },
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
  swing,
  recommendation,
  entryView,
}: {
  bias: MarketBias;
  thesis: MarketThesis | null;
  /** The standing multi-day thesis — the headline. */
  swing: SwingView;
  /** The short-term read, rendered as subordinate tactical context (§19). */
  recommendation: TradeRecommendation;
  /** Null whenever no swing plan stands — the star row simply doesn't render, rather than showing an empty rating. */
  entryView: EntryQualityView | null;
}) {
  const style = SWING_STYLE[swing.tone];
  const { Icon } = style;

  return (
    <div className="flex flex-col gap-4">
      <span className="text-[11px] uppercase tracking-[0.22em] text-ink-muted">
        {bias.asset} · {thesis ? thesis.regime : "Market Read"}
      </span>

      <div className={`flex flex-col gap-3 rounded-lg border ${style.border} ${style.bg} px-4 py-4`}>
        {/*
          THE DECISION, and nothing else, at headline size.
          `intensityLabel` already produces the five states the product
          needs — Neutral / Leaning / Bullish / Strongly Bullish and the
          bearish mirror — off the same `bias.score` and the same
          DIRECTIONAL_THRESHOLD the verdict uses. It was previously rendered
          as an 11px grey afterthought beside the score while the SWING
          ACTION took the headline. That inverted the hierarchy: the swing
          action is a statement about whether a trade plan is live, and on
          ~3 days in 4 it reads "NO SWING SETUP" — a negation occupying the
          most valuable line on the page while the engine's actual read was
          relegated to a footnote. The action moves down to the trade plan,
          where it is the correct answer to a different question.
        */}
        {/*
          THE ONE-GLANCE VERDICT — the whole product in one word.

          Emoji + word + one sentence, before anything else: should I trade
          this asset, and which way. The word is the trade RECOMMENDATION
          (the gated action, not the raw bias), because that is the only
          quantity here that already passes through every honesty layer the
          platform has built — the composite must clear the directional
          threshold, technicals must confirm, divergence can veto, and the
          plan machinery downstream applies the measured EV gate. A raw
          bias word would green-light reads the engine itself refuses to
          act on. Everything below this strip is the evidence; nothing
          below it may contradict it, because it is derived from the same
          single engine.
        */}
        <VerdictStrip recommendation={recommendation} />

        {/*
          THE ENGINE'S OWN EXPLANATION — recommendation.reason, which embeds
          `bias.headline` (direction, leading metric, strongest counter) and
          adds WHY the action is what it is (technical confirmation, a
          divergence veto, a higher-timeframe caveat). One sentence-cluster,
          never two competing explanations: the separate headline paragraph
          this replaces was a strict subset of it.
        */}
        <p className="max-w-4xl text-[13px] leading-relaxed text-ink">{recommendation.reason}</p>

        {/* The read's strength and data quality — detail under the verdict, no longer the headline. */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 shrink-0 ${style.text}`} aria-hidden />
            <span className={`text-sm font-bold uppercase leading-none tracking-[0.04em] ${style.text}`}>
              {intensityLabel(bias.score)}
            </span>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-sm leading-none text-ink">{bias.score}</span>
            <span className="text-[11px] text-ink-faint">/ 100</span>
            <span
              className="text-[11px] text-ink-faint"
              title="How complete and well-agreeing the underlying data is — never the odds of a move. Renamed from 'Confidence': the calibration study found this number's realized hit rate barely varies across its range, so it measures data quality, not accuracy."
            >
              · Data Quality {bias.confidence}%
            </span>
          </div>
        </div>

        <ScoreCalibrationLine asset={bias.asset} score={bias.score} verdict={bias.verdict} regimeTags={thesis?.regimeTags ? regimeTagsToStrings(thesis.regimeTags) : null} />

        {/*
          TACTICAL, kept visually and semantically separate from the action
          above it. This is the line that lets a trader read "conditions are
          softening" WITHOUT reading "get out" — the distinction this whole
          layer exists to draw.
        */}
        {swing.tactical && (
          <p className="rounded-md border border-amber/20 bg-amber/[0.04] px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
            <span className="font-semibold uppercase tracking-[0.12em] text-amber">Tactical</span> · {swing.tactical}
          </p>
        )}

        {/*
          The short-term read. Still real, still shown, but explicitly
          labelled as the fast-moving one so it can never be mistaken for
          the standing instruction above.
        */}
        <p className="text-[12px] leading-relaxed text-ink-faint">
          <span className="text-ink-muted">Short-term read:</span> {shortTermCondition(recommendation.action)}.
        </p>

        {/*
          TRADE PLAN STATUS — the swing action in its correct place.
          "No swing setup" is a true and useful answer to "is there a plan to
          trade right now"; it is a terrible answer to "what does the engine
          think", which is what the headline slot asks. Same string, same
          engine, correct question.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline/60 pt-3">
          <span className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">Trade plan</span>
          <span className={`text-xs font-semibold uppercase tracking-[0.08em] ${style.text}`}>{swing.label}</span>
          {swing.chip && (
            <span className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              {swing.chip}
            </span>
          )}
          {entryView && (
            <span className="flex items-center gap-1.5">
              <span className="flex items-center gap-0.5" aria-label={`${entryView.eq.stars} out of 5 stars`}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <Star
                    key={i}
                    className={`h-3.5 w-3.5 ${i <= entryView.eq.stars ? "fill-amber text-amber" : "text-ink-faint/40"}`}
                  />
                ))}
              </span>
              <span className="text-xs text-ink-muted">{starGrade(entryView.eq.stars)}</span>
            </span>
          )}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-muted">{swing.detail}</p>
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
/**
 * One side of the evidence ledger.
 *
 * `tone` is about the item's relationship to the DECISION, not its direction:
 * a bearish metric is "support" when the decision is bearish. Colouring by
 * bullish/bearish here would have re-created the flat list's problem in two
 * columns — the reader would still have to work out which colour meant
 * "agrees with the read".
 */
function EvidenceColumn({
  title,
  tone,
  items,
  empty,
}: {
  title: string;
  tone: "support" | "oppose";
  items: RankedReason[];
  empty: string;
}) {
  const mark = tone === "support" ? "✓" : "✕";
  const markClass = tone === "support" ? "text-success" : "text-danger";

  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {items.map((r) => (
            <li key={r.id} className="flex items-start gap-2 text-xs leading-relaxed">
              <span aria-hidden className={`shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span className="text-ink">{r.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopReasons({ reasons }: { reasons: RankedReason[] }) {
  if (reasons.length === 0) {
    return (
      <div className="border-t border-hairline pt-5">
        <SectionLabel>Why</SectionLabel>
        <p className="mt-3 text-xs text-ink-faint">No metric currently reports enough evidence to rank.</p>
      </div>
    );
  }

  /*
   * EVIDENCE FOR / EVIDENCE AGAINST, split against the DECISION rather than
   * shown as one undifferentiated row of arrows.
   *
   * The list was previously a single flat line mixing both sides, which made
   * the reader do the sorting — they had to notice that three arrows pointed
   * one way and two the other before they knew whether the evidence was
   * lopsided or nearly tied. Splitting it makes the balance readable at a
   * glance, and makes "what argues against this" a first-class section
   * instead of a trailing sentence.
   *
   * The side that leads is determined by the highest-ranked reason, which is
   * the same ordering `topReasons` already applies (weight x confidence). No
   * new ranking, no new signal.
   */
  const leading = reasons[0];
  const supporting = reasons.filter((r) => r.side === leading.side);
  const against = reasons.filter((r) => r.side !== leading.side);

  return (
    <div className="border-t border-hairline pt-5">
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        <EvidenceColumn
          title="Evidence for"
          tone="support"
          items={supporting}
          empty="No metric currently supports this read."
        />
        <EvidenceColumn
          title="Evidence against"
          tone="oppose"
          items={against}
          empty="Nothing material currently argues the other way."
        />
      </div>

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
/**
 * Absolute direction styling, replacing the thesis-relative stance colours
 * for the technical read. Direction is always carried by the word itself as
 * well as the colour — never colour alone.
 */
const DIRECTION_TEXT: Record<NonNullable<Lean> | "unavailable", string> = {
  bullish: "text-success",
  bearish: "text-danger",
  neutral: "text-ink-muted",
  unavailable: "text-ink-faint",
};

const LEAN_LABEL: Record<NonNullable<Lean> | "unavailable", string> = {
  bullish: "BULLISH",
  bearish: "BEARISH",
  neutral: "NEUTRAL",
  unavailable: "NO DATA",
};

/** Same three-state palette everything else on this surface already uses — bullish/bearish/neutral, never a fourth "harmonic" colour. */
const HARMONIC_STATUS_TEXT: Record<HarmonicEvidence["status"], string> = {
  "prz-projected": "text-ink-faint",
  approaching: "text-ink-muted",
  "inside-prz": "text-amber",
  "confirmation-pending": "text-amber",
  confirmed: "text-ink",
  tradeable: "text-ink",
  invalidated: "text-ink-faint",
  expired: "text-ink-faint",
};

function TechnicalConfirmation({
  technicals,
  technicals4h,
  thesis,
  harmonic,
}: {
  technicals: TechnicalRead | null;
  /** Live-only, optional — see okxCandles.ts. Rendered as a secondary qualifier line, never a competing verdict; per the multi-timeframe spec, HTF disagreement is context the trader weighs, not an override of the daily read. */
  technicals4h: TechnicalRead | null;
  thesis: MarketThesis | null;
  /**
   * Best Daily/4H harmonic pattern evidence, or null when nothing currently
   * qualifies — see lib/signals/harmonicEvidence.ts. Additive context only:
   * never changes the badge above it, never gates the swing thesis.
   */
  harmonic: HarmonicEvidence | null;
}) {
  if (!technicals || !thesis || thesis.technicalConfirmation.length === 0) return null;

  /*
   * Read each timeframe on its OWN terms.
   *
   * This used to render one thesis-relative badge (CONFIRMS/CONTRADICTS)
   * computed against `thesis.dominant`. That value has no deadband — it
   * flips whenever bullWeight and bearWeight cross, measured at ~8 times a
   * day — so the badge churned on days when no candle changed direction at
   * all. "DAILY: BEARISH" is plainer English AND can only change when a
   * daily bar closes.
   */
  const daily = timeframeRead("Daily", technicals);
  const fourHour = timeframeRead("4H", technicals4h);
  const alignment = multiTimeframeVerdict(daily, fourHour);

  return (
    <div className="border-t border-hairline pt-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <SectionLabel>Technical read</SectionLabel>
        {[daily, fourHour].map((tf) => (
          <span key={tf.timeframe} className="inline-flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint">{tf.timeframe}</span>
            <span className={`text-[11px] font-semibold tracking-wider ${DIRECTION_TEXT[tf.direction ?? "unavailable"]}`}>
              {tf.label}
            </span>
            <span className="text-[10px] text-ink-faint/80">{tf.qualifier}</span>
          </span>
        ))}
      </div>

      {/*
        The alignment sentence, stated outright rather than left for the
        reader to infer by comparing two badges. Conflict between the two
        swing timeframes is the single most decision-relevant thing this
        section can say, so it is never a footnote.
      */}
      <p className={`mt-1.5 text-xs ${alignment.aligned ? "text-ink-muted" : "text-amber"}`}>{alignment.sentence}</p>

      {/*
        One line, only when a pattern currently qualifies. Says WHERE (the
        PRZ, in the same $ format as every other level on this page) and
        WHAT STATE it's in — never a directional call of its own, and never
        a second badge competing with DAILY/4H above.
      */}
      {harmonic && (
        <p className={`mt-1 text-xs ${HARMONIC_STATUS_TEXT[harmonic.status]}`}>
          Harmonic: {harmonic.summary} PRZ {formatPrice(harmonic.przLow)}–{formatPrice(harmonic.przHigh)}.
        </p>
      )}

      {/*
        Per-indicator grid for BOTH timeframes, COLLAPSED BY DEFAULT.

        It is twelve cells, most of them NEUTRAL on a typical day, and it
        used to carry a note underneath explaining why it might disagree
        with the verdict above it. Needing that note was the argument for
        hiding it: a default-visible table that contradicts the decision it
        sits under raises doubt without informing. The summary line above
        already states each timeframe's direction and whether they agree, so
        the grid is audit depth — available on demand, never competing for
        attention with the decision.
      */}
      <Collapsible title="Indicator detail" summary="12 readings, daily and 4H">
      <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {[
          { label: "Daily", read: technicals },
          { label: "4H", read: technicals4h },
        ].map(({ label, read }) => (
          <div key={label}>
            <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
            {read ? (
              <dl>
                {technicalDimensions(read, thesis.dominant).map((d) => (
                  <div key={d.label} className="flex items-baseline justify-between gap-3 border-b border-hairline/40 py-1">
                    <dt className="shrink-0 text-xs text-ink">{d.label}</dt>
                    <dd className="flex min-w-0 items-baseline gap-2 text-right">
                      <span className="truncate text-[11px] text-ink-faint">{d.detail}</span>
                      <span
                        className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${DIRECTION_TEXT[d.lean ?? "unavailable"]}`}
                      >
                        {LEAN_LABEL[d.lean ?? "unavailable"]}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-[11px] text-ink-faint">No 4-hour read available.</p>
            )}
          </div>
        ))}
      </div>

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
      </Collapsible>

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
