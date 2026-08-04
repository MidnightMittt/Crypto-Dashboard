"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { topReasons, RankedReason } from "@/lib/signals/marketBias";
import { MarketThesis } from "@/types/market";
import { intensityLabel } from "@/lib/signals/scoring";
import { lookupBiasVerdictStat } from "@/lib/sentiment/backtestStats";
import backtestStats from "@/data/backtestStats.json";

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
}: {
  bias: MarketBias | null;
  thesis: MarketThesis | null;
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

  return (
    <Card>
      <CardContent className="flex flex-col gap-7 py-6">
        <Header bias={bias} thesis={thesis} />

        <TopReasons reasons={reasons} />

        <div className="grid grid-cols-1 gap-6 border-t border-hairline pt-5 lg:grid-cols-2">
          <Highlight
            label="Biggest opportunity"
            metric={bias.opportunity}
            empty="No single signal stands out — the read is balanced."
            tone="bull"
          />
          <Highlight
            label="Biggest risk"
            metric={bias.counterRisk}
            empty="Nothing material is arguing the other way right now."
            tone="bear"
            extra={bias.riskRationale}
          />
        </div>

        <InvalidationLevel watchNext={bias.watchNext} invalidationLines={invalidationLines} />

        <SinceLastUpdate bias={bias} />

        <p className="border-t border-hairline pt-4 text-xs leading-relaxed text-ink-faint">
          Weighted read of {bias.metrics.length} metrics, each scaled by how much evidence backs
          it. Not a probability, not a price target, not advice. Every figure here traces back to
          a value shown elsewhere on this page.
        </p>
      </CardContent>
    </Card>
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
          <Stat label="Market Health" value={`${bias.healthScore}%`} hint="Direction-agnostic: how trustworthy and calm the picture is, regardless of which way it leans." />
        </div>
      </div>

      <ScoreBar score={bias.score} />

      {/* Trade bias — the headline is the plainest statement of direction + conviction this app makes. */}
      <p className="max-w-4xl text-[15px] leading-relaxed text-ink">{bias.headline}</p>

      {thesis && (
        <p className="max-w-4xl text-[13px] leading-relaxed text-ink-muted">{thesis.regimeDescription}</p>
      )}

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

/* ── Biggest opportunity / biggest risk ───────────────────────────────── */

function Highlight({
  label,
  metric,
  empty,
  tone,
  extra,
}: {
  label: string;
  metric: MetricVerdict | null;
  empty: string;
  tone: "bull" | "bear";
  extra?: string;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      {!metric ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span className={`text-sm font-medium ${tone === "bull" ? "text-success" : "text-danger"}`}>
              {metric.label}
            </span>
            <ConfidenceLabel confidence={metric.confidence} basis={metric.confidenceBasis} />
          </div>
          <p className="text-xs leading-relaxed text-ink-faint">{metric.explanation}</p>
          <p className="text-xs leading-relaxed text-ink-faint/75">{metric.whyItMatters}</p>
        </div>
      )}
      {extra && <p className="mt-2.5 text-xs leading-relaxed text-ink-faint/75">{extra}</p>}
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

/* ── Since last update (what changed — lower priority, not in the user's explicit field list but real, kept) ── */

function SinceLastUpdate({ bias }: { bias: MarketBias }) {
  return (
    <div className="border-t border-hairline pt-5">
      <SectionLabel>Since last update</SectionLabel>
      {bias.isFirstReading ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          First reading for this asset — there is no earlier snapshot to compare against yet.
        </p>
      ) : bias.changes.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          No metric has flipped direction since the last reading.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {bias.changes.map((c) => (
            <li key={c.label} className="flex items-baseline gap-2 text-xs leading-relaxed">
              <span className="text-ink">{c.label}</span>
              <span className="font-mono text-ink-faint">
                {c.from} → {c.to}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] uppercase tracking-[0.18em] text-ink-muted">{children}</span>;
}
