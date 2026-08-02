"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { VerdictBadge, ConfidenceLabel } from "@/components/ui/VerdictBadge";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";

/**
 * The dashboard's headline answer: what is the market likely to do next,
 * and why.
 *
 * Deliberately typographic rather than graphical — large numbers, minimal
 * colour, no charts. Every other card here is one indicator; this is all of
 * them, weighted and read together.
 *
 * The 0-100 score is a weighted sum of opinions, not a probability and not
 * a price target. See lib/signals/marketBias.ts and lib/signals/types.ts.
 */
export function MarketBiasCard({ bias }: { bias: MarketBias | null }) {
  if (!bias) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-xs leading-relaxed text-ink-muted">
            Not enough metrics have reported yet to form a market read. This fills in
            automatically as funding, positioning, and flow data arrive.
          </p>
        </CardContent>
      </Card>
    );
  }

  const toneBorder =
    bias.verdict === "bullish"
      ? "border-success/25"
      : bias.verdict === "bearish"
        ? "border-danger/25"
        : "border-hairline";

  return (
    <Card className={toneBorder}>
      <CardContent className="flex flex-col gap-5 py-5">
        {/* Headline block — the one thing a reader should get in a glance. */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.2em] text-ink-muted">
              Market Bias · {bias.asset}
            </span>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-4xl font-semibold leading-none text-ink">
                {bias.score}
              </span>
              <span className="text-xs text-ink-faint">/ 100</span>
              <VerdictBadge verdict={bias.verdict} size="lg" />
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 text-right">
            <RiskChip level={bias.riskLevel} />
            <ConfidenceLabel confidence={bias.confidence} />
          </div>
        </div>

        <p className="max-w-3xl text-sm leading-relaxed text-ink">{bias.headline}</p>

        {/* 50 is genuinely neutral, so the bar is drawn from the centre out. */}
        <ScoreBar score={bias.score} />

        <div className="grid grid-cols-1 gap-5 border-t border-hairline pt-4 sm:grid-cols-2">
          <ReasonColumn title="Top bullish reasons" reasons={bias.topBullish} tone="bull" />
          <ReasonColumn title="Top bearish reasons" reasons={bias.topBearish} tone="bear" />
        </div>

        <div className="grid grid-cols-1 gap-5 border-t border-hairline pt-4 sm:grid-cols-2">
          <div>
            <SectionLabel>What changed</SectionLabel>
            {bias.isFirstReading ? (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                First reading for this asset — nothing to compare against yet. Changes appear once
                a previous snapshot exists.
              </p>
            ) : bias.changes.length === 0 ? (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                No metric has flipped direction since the last reading.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {bias.changes.map((c) => (
                  <li key={c.label} className="text-[11px] leading-relaxed text-ink-faint">
                    <span className="text-ink-muted">{c.label}</span>{" "}
                    <span className="font-mono">
                      {c.from} → <span className="text-ink">{c.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <SectionLabel>Risk</SectionLabel>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">{bias.riskRationale}</p>
          </div>
        </div>

        <p className="border-t border-hairline pt-3 text-[10px] leading-relaxed text-ink-faint">
          A weighted read of {bias.metrics.length} metrics, each scaled by how much evidence backs
          it. Not a probability, not a price target, and not advice — signal confidence measures
          evidence quality, never the odds of a move.
        </p>
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-[0.2em] text-ink-muted">{children}</span>
  );
}

function ScoreBar({ score }: { score: number }) {
  // Drawn outward from the midpoint so the bar encodes direction, not just
  // magnitude — a 30 and a 70 are equally strong reads pointing opposite ways.
  const offset = score - 50;
  const width = Math.abs(offset);
  const bullish = offset >= 0;

  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/20" />
      <div
        className={`absolute top-0 h-full ${bullish ? "bg-success/70" : "bg-danger/70"}`}
        style={{
          left: bullish ? "50%" : `${50 - width}%`,
          width: `${width}%`,
        }}
      />
    </div>
  );
}

function RiskChip({ level }: { level: MarketBias["riskLevel"] }) {
  const tone =
    level === "high"
      ? "border-danger/40 text-danger"
      : level === "medium"
        ? "border-amber/40 text-amber"
        : "border-hairline text-ink-muted";

  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest ${tone}`}>
      {level} risk
    </span>
  );
}

function ReasonColumn({
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
        <p className="mt-2 text-[11px] text-ink-faint">Nothing on this side right now.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {reasons.map((r) => (
            <li key={r.id} className="text-[11px] leading-relaxed">
              <span className={tone === "bull" ? "text-success" : "text-danger"}>{r.label}</span>
              <span className="text-ink-faint"> — {r.explanation}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
