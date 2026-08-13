"use client";

import { Star, Target as TargetIcon, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Collapsible } from "@/components/ui/Collapsible";
import { VerdictBadge } from "@/components/ui/VerdictBadge";
import { AggregateMarketData } from "@/types/market";
import { buildEntryQuality, StarRating } from "@/lib/signals/entryQuality";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { executionDistanceContext, ExecutionWallContext } from "@/lib/technicals/liquidityWalls";
import type { SwingThesisState } from "@/lib/signals/swingThesis";
import { readPlannedSetups, PlannedSetupsView, PlannedSetupView, SetupStatus } from "@/lib/signals/plannedSetup";
import { referencePrice } from "@/lib/signals/assetComposite";
import { lookupTradeStatsBySide, ExecutionStatsSnapshot } from "@/lib/sentiment/backtestStats";
import { formatPrice, formatCompactUsd } from "@/lib/utils/format";
import executionStatsJson from "@/data/executionStats.json";

const executionStats = executionStatsJson as unknown as ExecutionStatsSnapshot;

/**
 * "Is this actually a high-quality entry?" — homepage module #3 from the
 * project charter's explicit spec. A pure derived view over data already
 * computed elsewhere (marketBias, technicals, liquidityMap, the backtested
 * biasVerdict win rate) — see lib/signals/entryQuality.ts's own doc comment
 * for exactly what feeds it and why nothing here is a fabricated
 * probability or a trade recommendation.
 *
 * Gated on `buildTradeRecommendation()`, not bare `bias.verdict` — a
 * directional bias alone isn't enough to show a setup; technical
 * confirmation must ALSO agree (see tradeRecommendation.ts's two-layer
 * gate), otherwise this card would show a full long/short plan with stars
 * even while price action is actively fighting the thesis.
 */
/**
 * The trade plan, resolved once so the decision surface can render the
 * star rating beside the ACTION while the levels render below it, without
 * calling buildEntryQuality() twice on the same inputs.
 *
 * Returns null in exactly the cases the plan itself is undefined: no bias
 * yet, no qualifying ENTER, or no ATR to size an honest stop.
 */
export interface EntryQualityView {
  eq: NonNullable<ReturnType<typeof buildEntryQuality>>;
  tradeStats: ReturnType<typeof lookupTradeStatsBySide>;
  isLong: boolean;
  price: number;
  /**
   * Present when the levels came from a FROZEN swing thesis rather than a
   * live recomputation. Entry is then a zone rather than a tick, which is
   * the whole point — see lib/signals/swingThesis.ts.
   */
  entryZone?: { low: number; high: number; basis: string };
}

/**
 * Adapts a frozen swing plan into the same view shape the live path
 * produces, so the execution grid below renders from ONE component instead
 * of growing a parallel copy for swing plans.
 *
 * Nothing is recomputed here: every number is read straight off the plan
 * that was frozen when the thesis activated.
 */
export function swingTradePlanView(state: SwingThesisState): EntryQualityView {
  const { plan, direction } = state;
  const isLong = direction === "long";

  return {
    isLong,
    price: plan.anchorPrice,
    tradeStats: lookupTradeStatsBySide(executionStats, direction),
    entryZone: { low: plan.entryLow, high: plan.entryHigh, basis: plan.entryBasis },
    eq: {
      verdict: isLong ? "bullish" : "bearish",
      stars: plan.stars,
      starRationale: plan.starRationale,
      // Midpoint of the frozen zone — the reference the plan's own R:R was
      // measured from, so this can never disagree with the ratio shown.
      entryPrice: (plan.entryLow + plan.entryHigh) / 2,
      stopPrice: plan.stopPrice,
      targetPrice: plan.target1Price,
      riskRewardRatio: plan.riskRewardRatio,
      stopBasis: plan.stopBasis,
      targetBasis: plan.target1Basis,
      target2Price: plan.target2Price,
      target2Basis: plan.target2Basis,
      riskRewardRatio2: plan.riskRewardRatio2,
      nearestSupport: plan.supportZone,
      nearestResistance: plan.resistanceZone,
      historicalWinRatePct: null,
      historicalWinRateN: null,
    },
  };
}


/** 1-5 stars as a plain-language grade, so the rating reads without counting glyphs. */
export function starGrade(stars: StarRating): string {
  return stars >= 5 ? "Excellent" : stars === 4 ? "Good" : stars === 3 ? "Moderate" : stars === 2 ? "Weak" : "Poor";
}

/**
 * The execution plan, rendered WITHOUT its own Card wrapper so it can live
 * inside the single decision surface directly beneath the ACTION and star
 * rating (see AiMarketSummary). Previously this was a separate card further
 * down the page, which meant a trader assembled one trade from two places
 * and the star rating sat nowhere near the action it rated.
 *
 * Same pattern LiquidityMapCard already uses for embedding.
 */
export function TradePlan({
  aggregate,
  view,
}: {
  aggregate: AggregateMarketData;
  /** Already resolved by the parent so buildEntryQuality() runs once, not twice. */
  view: EntryQualityView | null;
}) {
  const bias = aggregate.marketBias;
  if (!bias) return null;

  /*
   * No qualifying entry: show STRUCTURE anyway. Support and resistance
   * don't depend on whether a trade cleared the gate, and a trader waiting
   * for a trigger needs "where is price relative to structure" more than
   * anyone. Deliberately does NOT restate the action's reason — that
   * sentence is already directly above this on the same surface.
   *
   * The caller decides whether a plan exists by passing `view` or not; this
   * component no longer re-derives that itself, because the swing layer and
   * the stateless read disagree by design and re-deriving here would let
   * the grid contradict the action above it.
   */
  if (!view) {
    const price = referencePrice(aggregate);
    const planned = readPlannedSetups(aggregate.swingThesis?.store.plannedSetups ?? null, price);
    return (
      <div className="flex flex-col gap-5">
        {/*
          The forward-looking half. No thesis has cleared the evidence gate,
          but the levels a swing trader would want are still real — so show
          them, priced, with what has to happen first. This is the difference
          between "nothing to do" and "here is what I am waiting for".
        */}
        {planned && <PlannedSetups view={planned} />}
        <MarketStructureRow price={price} zones={aggregate.liquidityMap?.supportResistance ?? []} />
      </div>
    );
  }

  const { eq, tradeStats, isLong, entryZone } = view;

  const walls = aggregate.liquidityMap?.walls ?? null;
  const wallContext = walls
    ? executionDistanceContext(
        [
          { point: "entry", price: eq.entryPrice },
          { point: "stop", price: eq.stopPrice },
          { point: "tp1", price: eq.targetPrice },
          { point: "tp2", price: eq.target2Price },
        ],
        walls.bidWalls,
        walls.askWalls,
        walls.bookPriceRange
      )
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {/*
          A swing plan's entry is a RANGE to work, not a single price — the
          plan waits for a retest rather than buying wherever the last poll
          landed. Falls back to the single price for the stateless path.
        */}
        {entryZone ? (
          <div>
            <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Entry zone</dt>
            <dd className="mt-0.5 font-mono text-lg leading-tight text-ink">
              {formatPrice(entryZone.low)}
              <span className="text-ink-faint">–</span>
              {formatPrice(entryZone.high)}
            </dd>
            <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">{entryZone.basis}</dd>
          </div>
        ) : (
          <PriceStat label="Entry" value={eq.entryPrice} tone="neutral" />
        )}
        <PriceStat label="Stop" value={eq.stopPrice} tone="bear" />
        <PriceStat label="TP1" value={eq.targetPrice} tone="bull" />
        <PriceStat label="TP2" value={eq.target2Price} tone="bull" />
        <div>
          <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Reward / Risk</dt>
          <dd className="mt-0.5 flex items-center gap-1.5 font-mono text-lg text-ink">
            <TargetIcon className="h-3.5 w-3.5 text-ink-faint" />
            {eq.riskRewardRatio.toFixed(1)}:1
          </dd>
          <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">TP2 {eq.riskRewardRatio2.toFixed(1)}:1</dd>
        </div>
      </div>

      {/*
        Support/resistance stays in the execution block, beside the levels
        derived from it — never relegated to a separate market-data card.
      */}
      <div className="grid grid-cols-2 gap-4">
        <ZoneStat label="Support" zone={eq.nearestSupport} tone="bull" />
        <ZoneStat label="Resistance" zone={eq.nearestResistance} tone="bear" />
      </div>

      <LiquidityContextLine context={wallContext} />

      {/*
        Trade invalidation as a scannable row, not a paragraph. The old
        version spent two sentences explaining that a stop differs from a
        thesis invalidation; the two are now simply labelled distinctly and
        sit next to each other, which makes the point without the prose.
      */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-danger/20 bg-danger/[0.04] px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-danger">Trade invalidation</span>
        <span className="font-mono text-sm text-ink">{formatPrice(eq.stopPrice)}</span>
        <span className="text-[11px] text-ink-faint">{eq.stopBasis}</span>
      </div>

      {/*
        Level 5 detail. The star rationale, the measured trade statistics
        and the methodology disclaimer are all real and all preserved —
        they were simply three paragraphs deep in the primary decision
        surface, which is the wrong altitude for them.
      */}
      <Collapsible title="Setup detail" summary={`${eq.stars}-star rationale, historical outcomes`}>
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-xs leading-relaxed text-ink-muted">{eq.starRationale}</p>
          {tradeStats && (
            <p className="text-[11px] leading-relaxed text-ink-faint">
              <span className="text-ink-muted">Historically:</span> of {tradeStats.n} comparable{" "}
              {isLong ? "long" : "short"} setups, {tradeStats.winRatePct.toFixed(0)}% finished in profit after fees,
              slippage and funding. {tradeStats.targetHitRatePct.toFixed(0)}% reached TP1 before the stop,{" "}
              {tradeStats.stopHitRatePct.toFixed(0)}% stopped out, {tradeStats.timeoutRatePct.toFixed(0)}% were still
              open at the 7-day limit.
              {tradeStats.mae && tradeStats.mfe && (
                <>
                  {" "}
                  Median trade drew down {Math.abs(tradeStats.mae.median).toFixed(1)}% before resolving and ran{" "}
                  {tradeStats.mfe.median.toFixed(1)}% in favour at best.
                </>
              )}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Reference levels derived from support/resistance and recent volatility (ATR) — not a trade
            recommendation.
          </p>
        </div>
      </Collapsible>
    </div>
  );
}

/** Consistent title across every branch (populated or empty) so the card is always identifiable as "Entry Quality," regardless of whether today's read has a qualifying setup. */
function CardLabel() {
  return <span className="text-[11px] uppercase tracking-[0.22em] text-ink-muted">Entry Quality</span>;
}

function EmptyState({ headline, message, structure }: { headline?: string; message: string; structure?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-8">
        <div className="mb-2 flex items-center gap-3">
          <CardLabel />
        </div>
        {headline && (
          <div className="flex items-center gap-2 text-ink-muted">
            <ShieldAlert className="h-4 w-4" />
            <span className="text-sm font-medium">{headline}</span>
          </div>
        )}
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-faint">{message}</p>
        {structure}
      </CardContent>
    </Card>
  );
}

/**
 * Where price sits relative to structure, shown even when no trade
 * qualifies. The levels come from the same `supportResistance` zones
 * buildEntryQuality() would use for a real setup — nothing is recomputed
 * or invented, it's the identical canonical zone list the Liquidity Map
 * renders. Renders nothing at all when there are no zones, rather than
 * showing empty scaffolding.
 */
function MarketStructureRow({ price, zones }: { price: number; zones: SupportResistanceZone[] }) {
  const support = zones.filter((z) => z.kind === "support" && z.priceHigh < price).sort((a, b) => b.priceHigh - a.priceHigh)[0] ?? null;
  const resistance = zones.filter((z) => z.kind === "resistance" && z.priceLow > price).sort((a, b) => a.priceLow - b.priceLow)[0] ?? null;
  if (!support && !resistance) return null;

  return (
    <div className="mt-5 grid grid-cols-3 gap-4 border-t border-hairline pt-4">
      <ZoneStat label="Support" zone={support} tone="bull" />
      <div>
        <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">Price now</dt>
        <dd className="mt-0.5 font-mono text-sm text-ink">{price > 0 ? formatPrice(price) : "—"}</dd>
      </div>
      <ZoneStat label="Resistance" zone={resistance} tone="bear" />
    </div>
  );
}

const POINT_LABEL: Record<ExecutionWallContext["point"], string> = {
  entry: "Entry",
  stop: "Stop",
  tp1: "TP1",
  tp2: "TP2",
};

/**
 * Renders nothing when the book found no wall at any of the four prices —
 * the expected, common outcome for stop/TP1/TP2 (see liquidityWalls.ts's
 * header). Silence here is the honest behavior, not a fallback state to
 * explain away.
 */
function LiquidityContextLine({ context }: { context: ExecutionWallContext[] }) {
  const hits = context.filter((c) => c.wall !== null);
  if (hits.length === 0) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint">
      <span className="text-ink-muted">Order book:</span>{" "}
      {hits
        .map((h) => {
          const w = h.wall!;
          return `a significant ${w.side} wall (${formatCompactUsd(w.usd)}) sits right at ${POINT_LABEL[h.point].toLowerCase()} (${formatPrice(w.price)})`;
        })
        .join("; ")}
      .
    </p>
  );
}

function StarDisplay({ stars }: { stars: StarRating }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${i <= stars ? "fill-amber text-amber" : "text-ink-faint"}`}
        />
      ))}
    </div>
  );
}

function ZoneStat({ label, zone, tone }: { label: string; zone: SupportResistanceZone | null; tone: "bull" | "bear" }) {
  const toneClass = tone === "bull" ? "text-success" : "text-danger";
  if (!zone) {
    return (
      <div>
        <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
        <dd className="mt-0.5 text-sm text-ink-faint">None identified nearby</dd>
      </div>
    );
  }
  const range = zone.priceLow === zone.priceHigh ? formatPrice(zone.priceLow) : `${formatPrice(zone.priceLow)}–${formatPrice(zone.priceHigh)}`;
  const detail = [
    zone.reactionCount > 0 ? `${zone.reactionCount} touch${zone.reactionCount === 1 ? "" : "es"}` : "volume-based",
    zone.status !== "inactive" ? zone.status : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm ${toneClass}`}>{range}</dd>
      <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">{detail}</dd>
    </div>
  );
}

function PriceStat({
  label,
  value,
  tone,
  caption,
}: {
  label: string;
  value: number;
  tone: "bull" | "bear" | "neutral";
  caption?: string;
}) {
  const toneClass = tone === "bull" ? "text-success" : tone === "bear" ? "text-danger" : "text-ink";
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg ${toneClass}`}>{formatPrice(value)}</dd>
      {caption && <dd className="mt-0.5 text-[10px] leading-snug text-ink-faint">{caption}</dd>}
    </div>
  );
}

/* ── Planned setups — the forward-looking levels, frozen at the daily close ── */

/**
 * Status styling. Every state is carried by its WORD as well as its colour,
 * and the vocabulary is deliberately plain: a trader should not have to
 * learn what "armed" or "primed" means here.
 */
const SETUP_STATUS: Record<SetupStatus, { label: string; text: string }> = {
  "at-entry": { label: "AT ENTRY", text: "text-success" },
  approaching: { label: "APPROACHING", text: "text-amber" },
  waiting: { label: "WAITING", text: "text-ink-muted" },
  invalidated: { label: "LEVEL BROKEN", text: "text-ink-faint" },
};

function PlannedSetupRow({ setup }: { setup: PlannedSetupView }) {
  const status = SETUP_STATUS[setup.status];
  const { plan } = setup;
  const side = setup.direction === "long" ? "LONG" : "SHORT";

  return (
    <div className="border-t border-hairline/60 pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={`text-xs font-semibold tracking-wider ${setup.direction === "long" ? "text-success" : "text-danger"}`}>
          {side}
        </span>
        <span className="font-mono text-sm text-ink">
          {formatPrice(plan.entryLow)}–{formatPrice(plan.entryHigh)}
        </span>
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${status.text}`}>{status.label}</span>
        {setup.primary && (
          <span className="text-[10px] uppercase tracking-wider text-ink-faint">favoured by both timeframes</span>
        )}
      </div>

      <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px]">
        <div>
          <dt className="inline text-ink-faint">Stop </dt>
          <dd className="inline text-ink">{formatPrice(plan.stopPrice)}</dd>
        </div>
        <div>
          <dt className="inline text-ink-faint">TP1 </dt>
          <dd className="inline text-ink">{formatPrice(plan.target1Price)}</dd>
        </div>
        <div>
          <dt className="inline text-ink-faint">TP2 </dt>
          <dd className="inline text-ink">{formatPrice(plan.target2Price)}</dd>
        </div>
        <div>
          <dt className="inline text-ink-faint">R:R </dt>
          <dd className="inline text-ink">{plan.riskRewardRatio.toFixed(1)}:1</dd>
        </div>
      </dl>

      {/*
        The excursion record's two numbers for this side+regime (redesign
        §10), present only on plans built after the constraints landed:
        what a winner typically drew down before working — what HOLDING
        this feels like — and the expectancy at the record's own
        pessimistic bound. Null-gated, never fabricated for older frozen
        plans.
      */}
      {(plan.expectedDrawdownPct != null || plan.evLowerPct != null) && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {plan.expectedDrawdownPct != null && (
            <>
              Winning trades like this typically drew down{" "}
              <span className="font-mono text-ink-muted">{plan.expectedDrawdownPct.toFixed(1)}%</span> before
              working — expect to sit through that.
            </>
          )}
          {plan.evLowerPct != null && (
            <>
              {" "}
              Measured expectancy for this side in this regime:{" "}
              <span className="font-mono text-ink-muted">
                {plan.evLowerPct >= 0 ? "+" : ""}
                {plan.evLowerPct.toFixed(2)}%
              </span>{" "}
              per trade at the record&apos;s pessimistic bound.
            </>
          )}
        </p>
      )}

      <p className="mt-1 text-[11px] text-ink-muted">
        {setup.trigger}
        {setup.triggerPrice !== null && <span className="text-ink-faint"> ({formatPrice(setup.triggerPrice)})</span>}
      </p>
    </div>
  );
}

export function PlannedSetups({ view }: { view: PlannedSetupsView }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5">
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">Watching for entry</span>
        <span className="text-[10px] text-ink-faint">
          set at the {new Date(view.builtAt).toUTCString().slice(5, 16)} daily close
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {view.setups.map((s) => (
          <PlannedSetupRow key={s.direction} setup={s} />
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        {view.rationale} These levels are set once per daily close and do not move with price — only
        their status does. A conditional plan against structure, not a signal to act.
      </p>
    </div>
  );
}
