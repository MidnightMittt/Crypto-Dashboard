import {
  CexDexSplit,
  ExchangeSnapshot,
  FundingDivergence,
  LocalHistoryPoint,
  SqueezeComponent,
  SqueezeRisk,
  VenueSegment,
} from "@/types/market";
import { getExchange } from "@/lib/exchanges/registry";
import { fundingPer8h, toBps } from "@/lib/utils/format";
import { clamp } from "./compositeIndex";

/**
 * Derivatives positioning intelligence.
 *
 * Everything here is derived from the venue set already fetched — no new data
 * sources. The aggregate previously answered "what is funding right now"; these
 * answer the questions a trader actually asks next:
 *
 *   - Is this level unusual, or normal for this market?      -> percentile
 *   - Do the venues agree, or is something dislocated?       -> divergence
 *   - Are DEX traders positioned differently from CEX?       -> cexDex
 *   - If this unwinds, which side gets hurt and how badly?   -> squeezeRisk
 *
 * A rule that applies to every function in this file: funding rates are
 * normalized to an 8-hour equivalent via `fundingPer8h` BEFORE any comparison.
 * Kraken, Hyperliquid, dYdX and Backpack settle hourly while most CEXs settle
 * 8-hourly, so raw rates are not comparable — an hourly venue's number is one
 * eighth the size for identical economics. Skipping this would make hourly
 * venues look permanently neutral and inflate measured divergence.
 */

/** Minimum recorded points before a percentile means anything. */
const MIN_HISTORY_POINTS = 12;

/**
 * Percentile rank of current funding against the trailing window.
 *
 * WHY THIS IS MORE ROBUST THAN THE OI PERCENTILE: total open interest is a
 * SUM across venues, so it moves whenever coverage changes — which is why
 * `computeAggregateOiPercentile` has to insist on an identical venue set per
 * bucket and often returns null. Funding is an OI-weighted AVERAGE, so adding
 * or dropping a venue barely moves it. The same history that can't support an
 * OI percentile can usually support this one.
 */
export function computeFundingPercentile(
  currentPer8hPct: number,
  history: LocalHistoryPoint[]
): number | null {
  const values = history
    .map((p) => p.weightedFundingRatePct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  if (values.length < MIN_HISTORY_POINTS) return null;

  const below = values.filter((v) => v <= currentPer8hPct).length;
  return Math.round((below / values.length) * 100);
}


/**
 * How much the venues disagree about the cost of leverage.
 *
 * Arbitrageurs normally hold funding close across venues, so persistent
 * dispersion means something is impeding that — thin books, withdrawal
 * friction, or one venue's positioning genuinely dislocating. It's both a
 * cross-venue opportunity signal and a stress indicator.
 *
 * Dispersion is OI-weighted: a $6B venue disagreeing matters, a $2M venue
 * disagreeing is noise. The raw min/max spread is reported alongside because
 * it's what an arbitrageur actually trades against, but it is deliberately
 * NOT the headline — a single thin venue can dominate it.
 */
export function computeFundingDivergence(
  exchanges: ExchangeSnapshot[]
): FundingDivergence | null {
  const points = exchanges
    .filter((e) => e.openInterestUsd > 0)
    .map((e) => ({
      id: e.exchangeId,
      weight: e.openInterestUsd,
      per8h: fundingPer8h(e.fundingRatePct, e.fundingIntervalHours),
    }))
    .filter((p) => Number.isFinite(p.per8h));

  // Two venues is the minimum for "disagreement" to be a coherent idea.
  if (points.length < 2) return null;

  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return null;

  const mean = points.reduce((s, p) => s + p.per8h * p.weight, 0) / totalWeight;
  const variance =
    points.reduce((s, p) => s + p.weight * Math.pow(p.per8h - mean, 2), 0) / totalWeight;

  const sorted = [...points].sort((a, b) => a.per8h - b.per8h);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];

  const label = (id: string) => getExchange(id)?.name ?? id;

  return {
    dispersionBps: toBps(Math.sqrt(variance)),
    spreadBps: toBps(highest.per8h - lowest.per8h),
    highestVenue: { id: highest.id, name: label(highest.id), bps: toBps(highest.per8h) },
    lowestVenue: { id: lowest.id, name: label(lowest.id), bps: toBps(lowest.per8h) },
    venueCount: points.length,
  };
}



/**
 * Split positioning by venue type.
 *
 * Worth separating because the two populations behave differently: CEX flow is
 * dominated by size and market makers, on-chain perp flow skews retail and
 * directional, and on peer-to-pool venues the pool absorbs imbalance rather
 * than another trader. When DEX funding runs well above CEX, on-chain traders
 * are paying a premium for the same exposure — which historically resolves
 * toward the CEX level rather than away from it.
 *
 * Returns null unless BOTH sides have at least one venue. A "comparison" with
 * an empty side is not a comparison.
 */
export function computeCexDexSplit(exchanges: ExchangeSnapshot[]): CexDexSplit | null {
  const segment = (type: "CEX" | "DEX"): VenueSegment | null => {
    const members = exchanges.filter(
      (e) => e.openInterestUsd > 0 && getExchange(e.exchangeId)?.type === type
    );
    if (members.length === 0) return null;

    const oi = members.reduce((s, e) => s + e.openInterestUsd, 0);
    if (oi <= 0) return null;

    const weighted =
      members.reduce(
        (s, e) => s + fundingPer8h(e.fundingRatePct, e.fundingIntervalHours) * e.openInterestUsd,
        0
      ) / oi;

    return { openInterestUsd: oi, fundingBps: toBps(weighted), venueCount: members.length };
  };

  const cex = segment("CEX");
  const dex = segment("DEX");
  if (!cex || !dex) return null;

  const combined = cex.openInterestUsd + dex.openInterestUsd;

  return {
    cex,
    dex,
    cexOiSharePct: (cex.openInterestUsd / combined) * 100,
    fundingGapBps: dex.fundingBps - cex.fundingBps,
  };
}



interface SqueezeInputs {
  /** Per-8h weighted funding, as a percentage. */
  weightedFundingRatePct: number;
  fundingPercentile: number | null;
  oiPercentile: number | null;
  oiChange24hPct: number | null;
  longShortRatio: number | null;
  priceChange24hPct: number;
}

function scale(v: number, inMin: number, inMax: number): number {
  return clamp(((v - inMin) / (inMax - inMin)) * 100, 0, 100);
}

/**
 * How primed the market is for a forced unwind, and on which side.
 *
 * The setup this looks for is the one the dashboard's own README describes as
 * most dangerous: leverage accumulating while price goes nowhere. Crowded
 * positioning alone is not enough — a crowded market can grind higher for
 * weeks. It becomes fragile when there is a lot of it (open interest high),
 * it is one-sided (funding and long/short agree), and price has stopped
 * rewarding it (stalling).
 *
 * Components whose data is missing are dropped and remaining weights
 * renormalized, the same rule buildMarketBias uses — a missing input must
 * not quietly pull the score toward the middle.
 */
export function computeSqueezeRisk(inputs: SqueezeInputs): SqueezeRisk | null {
  const components: SqueezeComponent[] = [];

  const fundingBps = toBps(inputs.weightedFundingRatePct);

  /*
   * Crowding. Prefers the percentile when available because "0.01%" means
   * nothing without knowing whether that is high for this market; falls back
   * to absolute magnitude, where 20bps per 8h is historically extreme.
   */
  if (inputs.fundingPercentile !== null) {
    const extremity = Math.abs(inputs.fundingPercentile - 50) * 2; // 0 at neutral, 100 at either tail
    components.push({
      label: "Funding crowding",
      score: extremity,
      weight: 0.35,
      detail: `Funding at ${fundingBps.toFixed(2)} bps/8h sits in the ${inputs.fundingPercentile}th percentile of its recorded range`,
    });
  } else {
    components.push({
      label: "Funding crowding",
      score: scale(Math.abs(fundingBps), 0, 20),
      weight: 0.35,
      detail: `Funding at ${fundingBps.toFixed(2)} bps/8h (no history yet, so judged on absolute size)`,
    });
  }

  // Fuel: how much open interest there is to liquidate.
  if (inputs.oiPercentile !== null) {
    components.push({
      label: "Open interest level",
      score: inputs.oiPercentile,
      weight: 0.25,
      detail: `Open interest in the ${inputs.oiPercentile}th percentile — more positions means more to unwind`,
    });
  } else if (inputs.oiChange24hPct !== null) {
    components.push({
      label: "Open interest building",
      score: scale(inputs.oiChange24hPct, -10, 30),
      weight: 0.25,
      detail: `Open interest ${inputs.oiChange24hPct >= 0 ? "up" : "down"} ${Math.abs(inputs.oiChange24hPct).toFixed(1)}% over 24h`,
    });
  }

  // One-sidedness. Only some venues publish this.
  if (inputs.longShortRatio !== null) {
    const skew = Math.abs(inputs.longShortRatio - 1);
    components.push({
      label: "Positioning skew",
      score: scale(skew, 0, 0.8),
      weight: 0.2,
      detail: `Long/short ratio ${inputs.longShortRatio.toFixed(2)}:1 — ${
        skew < 0.15 ? "close to balanced" : inputs.longShortRatio > 1 ? "long-heavy" : "short-heavy"
      }`,
    });
  }

  /*
   * Coiling. A flat price alongside heavy leverage is the dangerous part: it
   * means nobody is being forced out gradually, so the eventual move happens
   * all at once.
   */
  const absMove = Math.abs(inputs.priceChange24hPct);
  components.push({
    label: "Price coiling",
    score: scale(3 - absMove, 0, 3),
    weight: 0.2,
    detail: `Price ${absMove < 1 ? "flat" : "moved"} ${absMove.toFixed(1)}% over 24h${
      absMove < 1 ? " — leverage building without resolution" : ""
    }`,
  });

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) return null;

  const score = Math.round(
    clamp(components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight, 0, 100)
  );

  /*
   * Which side is exposed. Funding is the primary tell — it is the direct
   * transfer from the crowded side — with long/short as confirmation. When the
   * two disagree the market genuinely isn't one-sided, so "balanced" is the
   * honest answer rather than picking the stronger signal.
   */
  const fundingSide = fundingBps > 0.5 ? "long" : fundingBps < -0.5 ? "short" : null;
  const ratioSide =
    inputs.longShortRatio === null
      ? null
      : inputs.longShortRatio > 1.15
        ? "long"
        : inputs.longShortRatio < 0.87
          ? "short"
          : null;

  let side: SqueezeRisk["side"] = "balanced";
  if (fundingSide && ratioSide) side = fundingSide === ratioSide ? fundingSide : "balanced";
  else side = fundingSide ?? ratioSide ?? "balanced";

  return { score, side, components };
}
