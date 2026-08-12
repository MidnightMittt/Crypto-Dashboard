import { AssetSymbol } from "@/types/market";
import { Verdict, RiskLevel } from "./types";
import { SetupSummary } from "./opportunityRanking";

/**
 * BTC/ETH/Altcoin composite view — the Dashboard v2 spec's simultaneous
 * asset-level scores. Pure derivation only; the fetch/cache layer that
 * calls these lives in lib/exchanges/assetComposites.ts, which reuses
 * getAggregateForAsset()/bias.score directly — this file never recomputes
 * a bias score of its own (the charter's "one market, one truth": no
 * competing opinion, just a different rollup of the same one).
 */

export interface AssetComposite {
  asset: AssetSymbol;
  score: number;
  verdict: Verdict;
  confidence: number;
  priceChange24hPct: number;
  /** Null when fewer than 7 real days of price history are available — never a fabricated shorter-window number presented as 7d. */
  priceChange7dPct: number | null;
  headline: string;
  /**
   * How much the metrics agree WITH EACH OTHER — `bias.agreement`, passed
   * through. Already computed on every poll; it simply was not carried here,
   * so the scanner could not offer the "strongest agreement" ordering the
   * single-asset surface has always displayed.
   */
  agreement: number;
  /** `bias.riskLevel`, passed through for the same reason. */
  riskLevel: RiskLevel;
  /**
   * The engine's current plan for this asset, if it has one — an ACTIVE swing
   * thesis first, otherwise the favoured PLANNED setup waiting on a level.
   * Null when neither exists, which is the majority of days and is a finding
   * rather than a gap.
   */
  setup: SetupSummary | null;
}

/**
 * The current price a stateless read (setup status, distance to a level) is
 * measured against.
 *
 * `AggregateMarketData` has no single `price` field — it carries a per-venue
 * array — so callers had settled on `exchanges[0]?.price`. That expression was
 * about to appear in a second place, and two copies of "which venue counts as
 * the price" is how one surface starts reporting a setup AT ENTRY while
 * another still says APPROACHING.
 *
 * Returns 0 when no venue reported, which `readPlannedSetups` already treats
 * as "cannot read" rather than as a real price.
 */
export function referencePrice(aggregate: { exchanges: Array<{ price: number }> }): number {
  return aggregate.exchanges[0]?.price ?? 0;
}

export interface PricePoint {
  t: number;
  price: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 7-day % change from a price series. Sorts defensively rather than
 * assuming input order. Returns null when the series doesn't actually
 * reach back 7 days — an honest "not enough history" rather than a
 * shorter window silently mislabeled as 7d.
 */
export function derive7dChangePct(points: PricePoint[]): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const latest = sorted[sorted.length - 1];
  const targetT = latest.t - SEVEN_DAYS_MS;

  if (sorted[0].t > targetT) return null;

  let reference = sorted[0];
  for (const p of sorted) {
    if (p.t > targetT) break;
    reference = p;
  }

  if (reference.price <= 0 || latest.price <= 0) return null;
  return ((latest.price - reference.price) / reference.price) * 100;
}

export interface AltcoinAggregateInput {
  score: number;
  confidence: number;
}

/**
 * Confidence-weighted score across N altcoins, same weighting philosophy
 * as categories.ts's combineCategoryScores — a low-confidence reading
 * shouldn't pull the aggregate as hard as a well-evidenced one. Returns
 * null with no inputs, or when every input has zero confidence (nothing
 * to honestly average, not a fabricated neutral midpoint).
 */
export function aggregateAltcoinComposite(
  inputs: AltcoinAggregateInput[]
): { score: number; confidence: number } | null {
  if (inputs.length === 0) return null;

  let weightedScoreSum = 0;
  let weightTotal = 0;
  let confidenceSum = 0;

  for (const i of inputs) {
    confidenceSum += i.confidence;
    const w = i.confidence / 100;
    if (w <= 0) continue;
    weightedScoreSum += i.score * w;
    weightTotal += w;
  }

  if (weightTotal <= 0) return null;

  return {
    score: Math.round(weightedScoreSum / weightTotal),
    confidence: Math.round(confidenceSum / inputs.length),
  };
}
