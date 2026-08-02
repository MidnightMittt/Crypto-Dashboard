"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { MarketThesis, ThesisEvidence } from "@/types/market";
import { lookupThesisStat } from "@/lib/sentiment/backtestStats";
import backtestStats from "@/data/backtestStats.json";

/**
 * Cross-indicator synthesis, read together as a briefing rather than as a
 * grid of separate gauges — the "read the whole board" card this dashboard
 * builds toward. See MarketThesis's own doc comment in types/market.ts and
 * sentiment/marketThesis.ts for what this deliberately is and is not: not a
 * probability, no price target, no backtest behind any number here. Every
 * line traces back to a real value already computed elsewhere on this
 * dashboard.
 */
export function MarketThesisBriefing({ thesis }: { thesis: MarketThesis | null }) {
  if (!thesis) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Market Thesis</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs leading-relaxed text-ink-muted">
            Not enough of the underlying indicators have reported yet this cycle to synthesize a
            thesis. This fills in automatically as funding, positioning, and flow data arrive.
          </p>
        </CardContent>
      </Card>
    );
  }

  const totalEvidence = thesis.bullishEvidence.length + thesis.bearishEvidence.length + thesis.neutralEvidence.length;
  const regimeTone = regimeBadgeVariant(thesis.regime);

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Market Thesis</CardTitle>
        <Badge variant={regimeTone}>{thesis.regime}</Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pt-0">
        <VerdictLine thesis={thesis} />

        <p className="text-sm leading-relaxed text-ink">{thesis.regimeDescription}</p>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted">
              Signal Agreement
            </span>
            <span className="font-mono text-xs text-ink-faint">
              {thesis.conviction}/10 · {thesis.convictionLabel}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full bg-cyan transition-all"
              style={{ width: `${(thesis.conviction / 10) * 100}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            Not a probability — a measure of how much the {totalEvidence} pieces of evidence below
            agree with each other, weighted by source. No backtest sits behind this number.
          </p>
          <RegimeBacktestLine regime={thesis.regime} />
        </div>

        {thesis.technicalConfirmation.length > 0 && (
          <div className="border-t border-hairline pt-3">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted">
              Technical Confirmation
            </span>
            <ul className="mt-2 flex flex-col gap-1.5">
              {thesis.technicalConfirmation.map((line, i) => (
                <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-ink-faint">
                  <span className="text-ink-muted">·</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 border-t border-hairline pt-4 sm:grid-cols-2">
          <EvidenceColumn title="Supporting the thesis" evidence={thesis.topSupporting} tone="for" />
          <EvidenceColumn title="Working against it" evidence={thesis.topOpposing} tone="against" />
        </div>

        {thesis.neutralEvidence.length > 0 && (
          <div className="border-t border-hairline pt-3">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted">
              Observed, not directional
            </span>
            <ul className="mt-2 flex flex-col gap-1.5">
              {thesis.neutralEvidence.map((e) => (
                <li key={e.source} className="text-[10px] leading-relaxed text-ink-faint">
                  <span className="text-ink-muted">{e.source}:</span> {e.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-hairline pt-3">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted">
            What would change this
          </span>
          <ul className="mt-2 flex flex-col gap-1.5">
            {thesis.invalidation.map((line, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-ink-faint">
                {line}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The one-line answer to "so which way is this leaning". Deliberately TEXT
 * and not a gauge: this dashboard already carries four radial gauges plus
 * several LeanGauges, and the ask here was for a clearer verdict, not
 * another dial to interpret.
 *
 * The qualifier is driven by conviction so the wording can't overstate a
 * weak, split reading — a 2/10 bearish thesis reads "leans bearish", not
 * "BEARISH".
 */
function VerdictLine({ thesis }: { thesis: MarketThesis }) {
  const { dominant, conviction } = thesis;

  if (dominant === "neutral") {
    return (
      <div className="rounded-md border border-hairline bg-white/[0.02] px-3 py-2.5">
        <p className="text-sm font-semibold text-ink-muted">No directional edge right now</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          Bullish and bearish evidence carry equal weight — the honest read is to wait rather
          than to pick a side.
        </p>
      </div>
    );
  }

  const bullish = dominant === "bullish";
  const strong = conviction >= 7;
  const weak = conviction <= 3;

  const headline = strong
    ? bullish
      ? "Bullish — evidence broadly aligned"
      : "Bearish — evidence broadly aligned"
    : weak
      ? bullish
        ? "Leans bullish, but weakly"
        : "Leans bearish, but weakly"
      : bullish
        ? "Bullish, with reservations"
        : "Bearish, with reservations";

  const subtext = weak
    ? "Most signals disagree with each other, so this lean is fragile — treat it as a tilt, not a setup."
    : strong
      ? "Most of the weighted evidence points the same way, which is as aligned as this dashboard gets."
      : "There is a clear lean, but meaningful evidence still points the other way — see below.";

  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${
        bullish ? "border-success/30 bg-success/[0.06]" : "border-danger/30 bg-danger/[0.06]"
      }`}
    >
      <p className={`text-sm font-semibold ${bullish ? "text-success" : "text-danger"}`}>
        {headline}
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{subtext}</p>
    </div>
  );
}

function RegimeBacktestLine({ regime }: { regime: MarketThesis["regime"] }) {
  const stat = lookupThesisStat(backtestStats, regime);
  if (!stat) return null;

  return (
    <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
      This regime is separately backtested, though: in the window ({backtestStats.coverageStart} to{" "}
      {backtestStats.coverageEnd}, N={stat.n} occurrences), price moved a mean{" "}
      {stat.mean7dPct >= 0 ? "+" : ""}
      {stat.mean7dPct.toFixed(1)}% over the following 7 days. One narrow window, not a validated
      probability.
    </p>
  );
}

function EvidenceColumn({
  title,
  evidence,
  tone,
}: {
  title: string;
  evidence: ThesisEvidence[];
  tone: "for" | "against";
}) {
  if (evidence.length === 0) {
    return (
      <div>
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">{title}</span>
        <p className="mt-2 text-[10px] text-ink-faint">Nothing here right now.</p>
      </div>
    );
  }

  return (
    <div>
      <span className="text-[11px] uppercase tracking-widest text-ink-muted">{title}</span>
      <ul className="mt-2 flex flex-col gap-2">
        {evidence.map((e) => (
          <li key={e.source} className="text-[10px] leading-relaxed">
            <span className={tone === "for" ? "text-success" : "text-danger"}>{e.source}</span>
            <span className="text-ink-faint"> — {e.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function regimeBadgeVariant(regime: MarketThesis["regime"]): "success" | "danger" | "amber" | "neutral" {
  if (regime.startsWith("Squeeze Setup")) return "amber";
  if (regime === "Trending Bullish" || regime === "Leaning Bullish") return "success";
  if (regime === "Trending Bearish" || regime === "Leaning Bearish") return "danger";
  return "neutral";
}
