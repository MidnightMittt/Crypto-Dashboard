"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatCompactUsd } from "@/lib/utils/format";
import { AggregateMarketData, SqueezeRisk, TechnicalRead } from "@/types/market";
import { lookupSqueezeStat } from "@/lib/sentiment/backtestStats";
import backtestStats from "@/data/backtestStats.json";

/**
 * Derivatives positioning, in one panel.
 *
 * Four related readings deliberately share a card rather than getting four of
 * their own. They answer one question between them — "how crowded is this and
 * what happens if it unwinds" — and splitting them would add height without
 * adding meaning, which is the failure mode the exchange grid already had.
 *
 * Each row states what was observed and what it implies, because a number
 * without an interpretation makes the reader do the work the dashboard exists
 * to do for them.
 */
export function PositioningIntelligence({ data }: { data: AggregateMarketData }) {
  const { fundingPercentile, fundingDivergence, cexDex, squeezeRisk } = data;

  const nothingToShow =
    fundingPercentile === null && !fundingDivergence && !cexDex && !squeezeRisk;

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Positioning Intelligence</CardTitle>
        {squeezeRisk && <SqueezeBadge risk={squeezeRisk} />}
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pt-0">
        {nothingToShow && (
          <p className="text-xs leading-relaxed text-ink-muted">
            Needs at least two reporting venues, and a few hours of recorded history
            for the percentile. Everything here derives from data already being
            fetched, so it fills in on its own — nothing to configure.
          </p>
        )}

        {squeezeRisk && <SqueezeSection risk={squeezeRisk} technicals={data.technicals ?? null} />}
        {fundingPercentile !== null && (
          <FundingPercentileRow percentile={fundingPercentile} />
        )}
        {cexDex && <CexDexRow split={cexDex} />}
        {fundingDivergence && <DivergenceRow divergence={fundingDivergence} />}
      </CardContent>
    </Card>
  );
}

function SqueezeBadge({ risk }: { risk: SqueezeRisk }) {
  const tone = risk.score >= 70 ? "danger" : risk.score >= 45 ? "amber" : "neutral";
  const sideLabel =
    risk.side === "balanced" ? "balanced" : `${risk.side}s exposed`;
  return (
    <Badge variant={tone}>
      Squeeze setup {risk.score}/100 · {sideLabel}
    </Badge>
  );
}

function SqueezeSection({
  risk,
  technicals,
}: {
  risk: SqueezeRisk;
  technicals: TechnicalRead | null;
}) {
  const headline =
    risk.side === "balanced"
      ? "No clear one-sided crowding — neither side is obviously exposed."
      : risk.side === "long"
        ? "Longs are the crowded side, so a move down would force them out first."
        : "Shorts are the crowded side, so a move up would force them out first.";

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-ink">{headline}</p>

      {/* Weighted contributions, so the score is auditable rather than a black box. */}
      <div className="flex flex-col gap-1.5">
        {risk.components.map((c) => (
          <div key={c.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] text-ink-muted">{c.label}</span>
              <span className="font-mono text-[11px] text-ink-faint">
                {Math.round(c.score)} × {c.weight.toFixed(2)}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full bg-cyan/60"
                style={{ width: `${Math.max(Math.min(c.score, 100), 0)}%` }}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-ink-faint">{c.detail}</p>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        A weighted ranking of conditions that have preceded liquidation cascades —
        not a calibrated probability. 70 means more of the setup is present than at
        40, not that anything is 70% likely.
      </p>

      <BacktestStatLine risk={risk} />
      <SqueezeTechnicalContext risk={risk} technicals={technicals} />
    </div>
  );
}

/**
 * Whether price action agrees with the squeeze setup, which materially
 * changes how to read it: a crowded side that price is ALREADY moving
 * against is mid-unwind, whereas a crowded side price still favours is a
 * setup that hasn't triggered. The score alone can't distinguish those two.
 */
function SqueezeTechnicalContext({
  risk,
  technicals,
}: {
  risk: SqueezeRisk;
  technicals: TechnicalRead | null;
}) {
  if (!technicals || risk.side === "balanced") return null;

  // The direction an unwind would push price: crowded longs get forced out
  // downward, crowded shorts upward.
  const unwindDirection = risk.side === "long" ? "bearish" : "bullish";
  const agrees = technicals.direction === unwindDirection;
  const opposes = technicals.direction !== "neutral" && !agrees;

  const message = agrees
    ? `Price action is already leaning ${technicals.direction} — the direction an unwind would push it, so this setup may be in motion rather than pending.`
    : opposes
      ? `Price action still leans ${technicals.direction}, against the way an unwind would resolve — the crowded side is not yet under pressure.`
      : "Price action is directionless here, so nothing is yet forcing the crowded side out.";

  return <p className="text-[11px] leading-relaxed text-ink-faint">{message}</p>;
}

function BacktestStatLine({ risk }: { risk: SqueezeRisk }) {
  const stat = lookupSqueezeStat(backtestStats, risk.score, risk.side);
  if (!stat) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint">
      Historically, in the backtested window ({backtestStats.coverageStart} to{" "}
      {backtestStats.coverageEnd}, N={stat.n} occurrences at this score/side): price moved a mean{" "}
      {stat.mean7dPct >= 0 ? "+" : ""}
      {stat.mean7dPct.toFixed(1)}% over the next 7 days, matching the fade direction{" "}
      {stat.fadeHitRatePct?.toFixed(0)}% of the time. One narrow window, not a guarantee.
    </p>
  );
}

function FundingPercentileRow({ percentile }: { percentile: number }) {
  const reading =
    percentile >= 85
      ? "Funding is near the top of its recorded range — longs are paying unusually up."
      : percentile <= 15
        ? "Funding is near the bottom of its recorded range — unusually cheap to be long."
        : "Funding sits within its normal recorded range.";

  return (
    <div className="border-t border-hairline pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">
          Funding percentile
        </span>
        <span className="font-mono text-sm text-ink">{percentile}th</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{reading}</p>
    </div>
  );
}

function CexDexRow({ split }: { split: NonNullable<AggregateMarketData["cexDex"]> }) {
  const { cex, dex, cexOiSharePct, fundingGapBps } = split;

  // A gap under a basis point is noise, not a dislocation worth narrating.
  const reading =
    Math.abs(fundingGapBps) < 1
      ? "CEX and DEX are priced in line — no venue-type dislocation."
      : fundingGapBps > 0
        ? `On-chain longs are paying ${fundingGapBps.toFixed(1)} bps more than on centralized venues.`
        : `Centralized longs are paying ${Math.abs(fundingGapBps).toFixed(1)} bps more than on-chain.`;

  return (
    <div className="border-t border-hairline pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">
          CEX vs DEX
        </span>
        <span className="font-mono text-[11px] text-ink-faint">
          {cexOiSharePct.toFixed(0)}% / {(100 - cexOiSharePct).toFixed(0)}% of OI
        </span>
      </div>

      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div className="bg-cyan/60" style={{ width: `${cexOiSharePct}%` }} />
        <div className="bg-amber/60" style={{ width: `${100 - cexOiSharePct}%` }} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <span className="text-ink-faint">
          <span className="text-cyan">CEX</span> {formatCompactUsd(cex.openInterestUsd)} ·{" "}
          {cex.fundingBps.toFixed(2)} bps · {cex.venueCount} venues
        </span>
        <span className="text-right text-ink-faint">
          <span className="text-amber">DEX</span> {formatCompactUsd(dex.openInterestUsd)} ·{" "}
          {dex.fundingBps.toFixed(2)} bps · {dex.venueCount} venues
        </span>
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{reading}</p>
    </div>
  );
}

function DivergenceRow({
  divergence,
}: {
  divergence: NonNullable<AggregateMarketData["fundingDivergence"]>;
}) {
  const { dispersionBps, spreadBps, highestVenue, lowestVenue, venueCount } = divergence;

  const reading =
    dispersionBps < 1
      ? "Venues agree closely on the cost of leverage."
      : dispersionBps < 3
        ? "Mild disagreement across venues — normal friction."
        : "Venues disagree materially, which usually means thin books or a genuine dislocation.";

  return (
    <div className="border-t border-hairline pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">
          Funding divergence
        </span>
        <span className="font-mono text-sm text-ink">{dispersionBps.toFixed(2)} bps</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
        {reading} Widest gap {spreadBps.toFixed(1)} bps across {venueCount} venues:{" "}
        <span className="text-success">{highestVenue.name}</span>{" "}
        {highestVenue.bps.toFixed(2)} vs{" "}
        <span className="text-danger">{lowestVenue.name}</span>{" "}
        {lowestVenue.bps.toFixed(2)}.
      </p>
    </div>
  );
}
