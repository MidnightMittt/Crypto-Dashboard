"use client";

import { motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { GaugeBase } from "@/components/gauges/GaugeBase";
import { bandFor, COMPOSITE_BANDS } from "@/lib/sentiment/bands";
import { AggregateMarketData, FearGreed } from "@/types/market";

const COLORS = ["#7A1E1E", "#EF4444", "#F59E0B", "#8890A0", "#2DD4E8", "#22C55E", "#F5A623"];

export function SentimentIndex({ data, fearGreed }: { data: AggregateMarketData; fearGreed?: FearGreed | null }) {
  const band = bandFor(data.compositeSentimentScore, COMPOSITE_BANDS);

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(45,212,232,0.08),transparent_60%)]" />
      <div className="relative flex flex-col items-center gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:gap-10">
        <div className="max-w-sm text-center sm:text-left">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber">
            Composite Market Sentiment Index
          </span>
          <motion.h2
            key={band.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-2 font-mono text-3xl font-bold text-ink sm:text-4xl"
          >
            {band.label}
          </motion.h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{band.description}</p>
          <div className="mt-4 hidden gap-4 sm:flex">
            <ScaleLegend />
          </div>
          {fearGreed && <FearGreedCompare data={data} fearGreed={fearGreed} />}
        </div>

        <GaugeBase
          gaugeId="composite"
          value={data.compositeSentimentScore}
          min={0}
          max={100}
          colors={COLORS}
          size={280}
          centerValue={String(data.compositeSentimentScore)}
          centerLabel="0 — 100"
        />

        <div className="flex gap-4 sm:hidden">
          <ScaleLegend />
        </div>
      </div>
    </Card>
  );
}

/**
 * Shows the market-wide Fear & Greed Index next to our leverage index.
 * They measure different things — spot sentiment vs perp positioning — so
 * the interesting signal is when they disagree.
 */
function FearGreedCompare({ data, fearGreed }: { data: AggregateMarketData; fearGreed: FearGreed }) {
  const gap = data.compositeSentimentScore - fearGreed.value;
  const diverging = Math.abs(gap) >= 20;

  return (
    <div className="mt-4 rounded-lg border border-hairline bg-white/[0.02] px-3 py-2">
      <div className="flex items-center justify-between gap-4 text-[11px]">
        <span className="text-ink-faint">
          Spot Fear &amp; Greed
          <span className="ml-2 font-mono text-ink">{fearGreed.value}</span>
          <span className="ml-1.5 text-ink-muted">{fearGreed.classification}</span>
        </span>
        <span className="text-ink-faint">
          Leverage
          <span className="ml-2 font-mono text-ink">{data.compositeSentimentScore}</span>
        </span>
      </div>
      {diverging && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber">
          {gap > 0
            ? "Leverage positioning is notably more optimistic than broad spot sentiment."
            : "Broad spot sentiment is notably more optimistic than leverage positioning."}
        </p>
      )}
      <p className="mt-1 text-[11px] text-ink-faint">
        Fear &amp; Greed measures spot-market sentiment; the index above measures perp leverage. Source:
        alternative.me
      </p>
    </div>
  );
}

function ScaleLegend() {
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-faint">
      <LegendDot color="#7A1E1E" label="Fear" />
      <LegendDot color="#8890A0" label="Neutral" />
      <LegendDot color="#F5A623" label="Greed" />
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
