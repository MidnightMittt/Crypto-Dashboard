import { AssetComposite } from "./assetComposite";

/**
 * Ranks the tracked universe by how strong an opportunity the DECISION ENGINE
 * currently sees — not by any indicator.
 *
 * NO NEW MATH. Every input is an existing production output of
 * `getAssetComposite`, which itself calls the same `getAggregateForAsset`
 * the single-asset page reads. This file only orders what the engine has
 * already concluded; it never re-derives a score, a verdict or a confidence.
 *
 * WHY CONVICTION x CONFIDENCE, and nothing else.
 *
 * The ranking deliberately multiplies two quantities the engine already
 * publishes:
 *
 *   conviction  = |score - 50|, how far off the fence the read sits
 *   confidence  = how good the evidence behind that read is
 *
 * A product, not a sum, because both must be present for an opportunity to
 * be real. A hugely directional read backed by thin evidence is a guess; a
 * beautifully evidenced read that concludes "flat" is not a trade. Summing
 * would let either one carry the other, which is exactly the failure mode a
 * ranked list must not have at the top of the page.
 *
 * Deliberately NOT ranked by trend alignment. The cross-asset replication
 * study (docs/TREND_PERSISTENCE_REPLICATION.md) retired the finding that a
 * higher-timeframe directional read persists beyond what a moving average
 * mechanically produces, so ranking on trend would be ranking on an artefact.
 * Evidence strength survived that test; trend persistence did not.
 */

export interface RankedOpportunity {
  asset: string;
  /** 0-100, the engine's directional score. Passed through untouched. */
  score: number;
  verdict: string;
  confidence: number;
  priceChange24hPct: number;
  headline: string;
  /** |score - 50|, 0-50. How far the engine is from the fence. */
  conviction: number;
  /**
   * conviction x confidence, normalised to 0-100 so it reads as a percentage
   * of the strongest opportunity the engine could theoretically express
   * (maximum conviction of 50 at 100% confidence).
   */
  opportunity: number;
  direction: "long" | "short" | "none";
}

/** The maximum `conviction * confidence` product, used to normalise onto 0-100. */
const MAX_PRODUCT = 50 * 100;

/**
 * Below this, "which is higher" is noise rather than signal. Such assets are
 * still returned — hiding them would misrepresent the universe — but a caller
 * can render them as a quiet tail rather than as ranked opportunities.
 */
export const ACTIONABLE_OPPORTUNITY = 10;

export function rankOpportunities(composites: AssetComposite[]): RankedOpportunity[] {
  return composites
    .map((c) => {
      const conviction = Math.abs(c.score - 50);
      return {
        asset: c.asset,
        score: c.score,
        verdict: c.verdict,
        confidence: c.confidence,
        priceChange24hPct: c.priceChange24hPct,
        headline: c.headline,
        conviction,
        opportunity: Math.round((conviction * c.confidence * 100) / MAX_PRODUCT),
        direction: directionOf(c.verdict),
      };
    })
    .sort((a, b) =>
      // Ties broken by conviction then alphabetically, so the order is stable
      // across refreshes rather than dependent on fetch completion order — a
      // list that reshuffles on every poll cannot be read.
      b.opportunity - a.opportunity || b.conviction - a.conviction || a.asset.localeCompare(b.asset)
    );
}

function directionOf(verdict: string): "long" | "short" | "none" {
  if (verdict === "bullish") return "long";
  if (verdict === "bearish") return "short";
  return "none";
}
