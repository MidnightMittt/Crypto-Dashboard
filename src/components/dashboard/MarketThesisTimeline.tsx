"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { VerdictBadge } from "@/components/ui/VerdictBadge";
import { BiasHistoryEntry } from "@/lib/history/biasHistory";
import { MarketBias } from "@/lib/signals/types";

/**
 * How the thesis got to where it is, not just where it is.
 *
 * The briefing above answers "what is the read now". This answers "how did
 * it get here" — which is often the more useful question, because a
 * cautiously bullish read that has been decaying since morning means
 * something different from one that has been strengthening all day.
 *
 * Rows appear only when the read genuinely MOVED (see biasHistory's
 * shouldRecord). A row per poll would bury the two moments that mattered
 * under ninety identical ones.
 *
 * The series accumulates forward from first deployment and is never
 * backfilled — so a new install shows one row and grows. The empty state
 * says that rather than implying the market has been flat.
 *
 * Dashboard V2: this no longer renders as its own top-level card — it's
 * absorbed into AiMarketSummary's "today's trajectory" expandable panel
 * (see that file). `TimelineList` below is the un-wrapped content
 * AiMarketSummary embeds; `MarketThesisTimeline` (the Card-wrapped
 * version) is kept for any future standalone use but isn't rendered from
 * page.tsx anymore.
 */
export function TimelineList({
  timeline,
  bias,
}: {
  timeline: BiasHistoryEntry[];
  bias: MarketBias | null;
}) {
  if (!bias) return null;

  // Most recent last, matching how a briefing reads: earliest at the top,
  // "Current" at the bottom.
  const entries = [...timeline].sort((a, b) => a.t - b.t).slice(-6);
  const isFirstEver = entries.length <= 1;

  return (
    <>
      {isFirstEver && (
        <p className="mb-5 text-xs leading-relaxed text-ink-faint">
          This timeline records the thesis each time it genuinely shifts, and builds up from
          here — there is no back-fill, so it starts with today. Nothing historical is being
          hidden; it simply has not been recorded yet.
        </p>
      )}

      <ol className="flex flex-col">
        {entries.map((entry, i) => (
          <TimelineRow
            key={entry.t}
            entry={entry}
            previousScore={i > 0 ? entries[i - 1].score : null}
          />
        ))}

        {/* The live read always terminates the list, so the arc ends at now. */}
        <CurrentRow bias={bias} previousScore={entries[entries.length - 1]?.score ?? null} />
      </ol>
    </>
  );
}

export function MarketThesisTimeline({
  timeline,
  bias,
}: {
  timeline: BiasHistoryEntry[];
  bias: MarketBias | null;
}) {
  if (!bias) return null;
  const isFirstEver = [...timeline].filter((e) => e.t).length <= 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Thesis Timeline</CardTitle>
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">
          {isFirstEver ? "collecting" : `${timeline.length} shifts`}
        </span>
      </CardHeader>

      <CardContent className="pt-0">
        <TimelineList timeline={timeline} bias={bias} />
      </CardContent>
    </Card>
  );
}

function TimelineRow({
  entry,
  previousScore,
}: {
  entry: BiasHistoryEntry;
  previousScore: number | null;
}) {
  return (
    <li className="relative flex gap-4 pb-5">
      <Rail />
      <Dot verdict={entry.verdict} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-xs text-ink-muted">{formatTime(entry.t)}</span>
          <VerdictBadge verdict={entry.verdict} />
          <ScoreDelta score={entry.score} previousScore={previousScore} />
        </div>

        {entry.regime && <p className="text-xs text-ink">{entry.regime}</p>}

        {entry.reasons.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {entry.reasons.map((r) => (
              <li key={r} className="text-xs leading-relaxed text-ink-faint">
                {r}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function CurrentRow({ bias, previousScore }: { bias: MarketBias; previousScore: number | null }) {
  const risk = bias.counterRisk;

  return (
    <li className="relative flex gap-4">
      <Dot verdict={bias.verdict} current />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-xs font-semibold text-ink">Current</span>
          <VerdictBadge verdict={bias.verdict} />
          <ScoreDelta score={bias.score} previousScore={previousScore} />
        </div>

        <p className="text-xs leading-relaxed text-ink">{bias.headline}</p>

        {risk && (
          <p className="text-xs leading-relaxed text-ink-faint">
            <span className="text-ink-muted">Largest risk:</span> {risk.label} — {risk.explanation}
          </p>
        )}
      </div>
    </li>
  );
}

/** The connecting line between dots. Purely structural. */
function Rail() {
  return <span className="absolute left-[5px] top-3 h-full w-px bg-hairline" aria-hidden />;
}

function Dot({ verdict, current = false }: { verdict: BiasHistoryEntry["verdict"]; current?: boolean }) {
  const tone =
    verdict === "bullish" ? "bg-success" : verdict === "bearish" ? "bg-danger" : "bg-amber";
  return (
    <span
      className={`relative z-10 mt-[5px] h-[11px] w-[11px] shrink-0 rounded-full ${tone} ${
        current ? "ring-2 ring-white/25" : "opacity-70"
      }`}
      aria-hidden
    />
  );
}

/**
 * Movement since the previous recorded row. Shown because the DIRECTION of
 * travel is the point of a timeline — a 55 that arrived from 40 is a
 * different market from a 55 that arrived from 70.
 */
function ScoreDelta({ score, previousScore }: { score: number; previousScore: number | null }) {
  if (previousScore === null) {
    return <span className="font-mono text-xs text-ink-faint">{score}</span>;
  }
  const delta = score - previousScore;
  if (delta === 0) {
    return <span className="font-mono text-xs text-ink-faint">{score} · flat</span>;
  }
  return (
    <span className="font-mono text-xs text-ink-faint">
      {score} · {delta > 0 ? "+" : ""}
      {delta}
    </span>
  );
}

function formatTime(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Older rows need a date or "9:15 AM" is ambiguous across a week-long window.
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
