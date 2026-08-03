"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { MarketThesis } from "@/types/market";

/**
 * The morning briefing. One card that answers, in reading order:
 *
 *   1. Current market regime          5. Biggest opportunity
 *   2. Overall conviction             6. Biggest risk
 *   3. Bullish vs bearish evidence    7. What changed
 *   4. Signal agreement               8. What to watch next
 *
 * Replaces the old MarketBiasCard and MarketThesisBriefing, which between
 * them showed two competing 0-100 scores and two overlapping narratives.
 * Everything either card said is here; nothing is computed twice.
 *
 * Every line traces to a real value the engine already produced. There are
 * no probabilities anywhere in this component, and the two headline numbers
 * are deliberately different things: CONVICTION is the weighted direction,
 * AGREEMENT is how much the metrics concur, CONFIDENCE is how good the
 * evidence is. Collapsing them would hide the case where everything agrees
 * on very little data.
 */
export function MarketBriefing({
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

  return (
    <Card>
      <CardContent className="flex flex-col gap-7 py-6">
        <Headline bias={bias} thesis={thesis} />

        <Evidence bias={bias} />

        <div className="grid grid-cols-1 gap-6 border-t border-hairline pt-5 lg:grid-cols-2">
          <Highlight
            label="Biggest opportunity"
            metric={bias.opportunity}
            empty="No single signal stands out — the read is balanced."
            tone="bull"
          />
          <Highlight
            label="Biggest risk to this view"
            metric={bias.counterRisk}
            empty="Nothing material is arguing the other way right now."
            tone="bear"
            extra={bias.riskRationale}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 border-t border-hairline pt-5 lg:grid-cols-2">
          <WhatChanged bias={bias} />
          <WhatToWatch bias={bias} thesis={thesis} />
        </div>

        <p className="border-t border-hairline pt-4 text-xs leading-relaxed text-ink-faint">
          Weighted read of {bias.metrics.length} metrics, each scaled by how much evidence backs
          it. Not a probability, not a price target, not advice. Every figure here traces back to
          a value shown elsewhere on this page.
        </p>
      </CardContent>
    </Card>
  );
}

/* ── 1, 2 & 4: regime, conviction, agreement ─────────────────────────── */

function Headline({ bias, thesis }: { bias: MarketBias; thesis: MarketThesis | null }) {
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
          </div>
        </div>

        <div className="flex items-start gap-6">
          <Stat label="Agreement" value={`${bias.agreement}%`} hint="How much the metrics concur with each other." />
          <Stat label="Confidence" value={`${bias.confidence}%`} hint="How good the evidence behind them is — not the odds of a move." />
          <Stat label="Risk" value={bias.riskLevel.toUpperCase()} hint={bias.riskRationale} />
        </div>
      </div>

      <ScoreBar score={bias.score} />

      <p className="max-w-4xl text-[15px] leading-relaxed text-ink">{bias.headline}</p>

      {thesis && (
        <p className="max-w-4xl text-[13px] leading-relaxed text-ink-muted">
          {thesis.regimeDescription}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <span className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">{label}</span>
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

/* ── 3: bullish vs bearish evidence ──────────────────────────────────── */

function Evidence({ bias }: { bias: MarketBias }) {
  return (
    <div className="grid grid-cols-1 gap-6 border-t border-hairline pt-5 sm:grid-cols-2">
      <EvidenceColumn title="Bullish evidence" reasons={bias.topBullish} tone="bull" />
      <EvidenceColumn title="Bearish evidence" reasons={bias.topBearish} tone="bear" />
    </div>
  );
}

function EvidenceColumn({
  title,
  reasons,
  tone,
}: {
  title: string;
  reasons: MetricVerdict[];
  tone: "bull" | "bear";
}) {
  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      {reasons.length === 0 ? (
        <p className="mt-3 text-xs text-ink-faint">Nothing on this side right now.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {reasons.map((r) => (
            <li key={r.id} className="text-xs leading-relaxed">
              <span className={tone === "bull" ? "text-success" : "text-danger"}>{r.label}</span>
              <span className="text-ink-faint"> — {r.explanation}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── 5 & 6: opportunity and risk ─────────────────────────────────────── */

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

/* ── 7: what changed ─────────────────────────────────────────────────── */

function WhatChanged({ bias }: { bias: MarketBias }) {
  return (
    <div>
      <SectionLabel>What changed</SectionLabel>
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

/* ── 8: what to watch next ───────────────────────────────────────────── */

function WhatToWatch({ bias, thesis }: { bias: MarketBias; thesis: MarketThesis | null }) {
  const invalidation = thesis?.invalidation ?? [];

  return (
    <div>
      <SectionLabel>What to watch next</SectionLabel>

      {bias.watchNext.length === 0 && invalidation.length === 0 ? (
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
          {bias.watchNext.map((m) => (
            <li key={m.id} className="text-xs leading-relaxed">
              <span className="text-ink">{m.label}</span>
              <span className="text-ink-faint"> — {m.nextTrigger}</span>
            </li>
          ))}
        </ul>
      )}

      {invalidation.length > 0 && (
        <>
          <p className="mt-4 text-[10px] uppercase tracking-[0.16em] text-ink-muted">
            What would invalidate this
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {invalidation.slice(0, 2).map((line, i) => (
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] uppercase tracking-[0.18em] text-ink-muted">{children}</span>;
}
