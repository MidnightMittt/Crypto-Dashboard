import { AssetSymbol } from "@/types/market";
import { ALL_ASSETS } from "./registry";
import { getAggregateForAsset } from "./aggregator";
import { swr } from "../cache/swr";
import { AssetComposite, PricePoint, derive7dChangePct, aggregateAltcoinComposite } from "../signals/assetComposite";
import { verdictFromScore } from "../signals/scoring";
import { Verdict } from "../signals/types";

/**
 * Wraps getAggregateForAsset in a MUCH slower cache specifically for the
 * BTC/ETH/Altcoin composite view. Reuses the exact same aggregate/
 * bias.score every other view reads — no competing computation, per the
 * charter's "one market, one truth."
 *
 * The live per-asset view already caches at 8s (AGGREGATE_CACHE in
 * aggregator.ts), which is right because a user is actively watching one
 * asset. Running the FULL weighted-aggregation pipeline (20+ exchange
 * adapters) for all 10 assets that often would 10x this app's background
 * exchange-API load for a summary view nobody stares at second-by-second —
 * the exact cost concern flagged when this phase was planned. 5 minutes
 * keeps the composite view meaningfully fresh while bounding that cost. If
 * a user already has one of these assets selected live, this piggybacks on
 * that already-warm 8s cache for free (same underlying `aggregate:${asset}`
 * swr key) — this cache only pays its own cost for assets nobody's
 * currently viewing.
 */
const COMPOSITE_CACHE = { freshMs: 5 * 60_000, maxAgeMs: 30 * 60_000 };

async function getAssetComposite(
  asset: AssetSymbol,
  history: PricePoint[] | undefined
): Promise<AssetComposite | null> {
  return swr(
    `composite:${asset}`,
    async () => {
      const agg = await getAggregateForAsset(asset);
      if (!agg.marketBias) return null;
      const composite: AssetComposite = {
        asset,
        score: agg.marketBias.score,
        verdict: agg.marketBias.verdict,
        confidence: agg.marketBias.confidence,
        priceChange24hPct: agg.priceChange24hPct,
        priceChange7dPct: history ? derive7dChangePct(history) : null,
        headline: agg.marketBias.headline,
      };
      return composite;
    },
    COMPOSITE_CACHE
  ).catch((err) => {
    console.warn(`[asset-composites] failed for ${asset}:`, err);
    return null;
  });
}

export interface AltcoinComposite {
  score: number;
  verdict: Verdict;
  confidence: number;
  assets: AssetComposite[];
}

export interface AssetComposites {
  btc: AssetComposite | null;
  eth: AssetComposite | null;
  altcoins: AltcoinComposite | null;
  updatedAt: number;
}

const ALTCOIN_SYMBOLS = ALL_ASSETS.filter((a) => a !== "BTC" && a !== "ETH");

/**
 * `histories` is the same 30-day daily price series the correlation matrix
 * already fetches (coingeckoHistory.ts, 55min-cached) — passed in rather
 * than fetched again here, so this never duplicates that call.
 */
export async function getAssetComposites(
  histories: Partial<Record<AssetSymbol, PricePoint[]>>
): Promise<AssetComposites> {
  const [btc, eth, ...altcoinResults] = await Promise.all([
    getAssetComposite("BTC", histories.BTC),
    getAssetComposite("ETH", histories.ETH),
    ...ALTCOIN_SYMBOLS.map((a) => getAssetComposite(a, histories[a])),
  ]);

  const altcoinComposites = altcoinResults.filter((c): c is AssetComposite => c !== null);
  const aggregate = aggregateAltcoinComposite(
    altcoinComposites.map((c) => ({ score: c.score, confidence: c.confidence }))
  );

  return {
    btc,
    eth,
    altcoins: aggregate
      ? { ...aggregate, verdict: verdictFromScore(aggregate.score), assets: altcoinComposites }
      : null,
    updatedAt: Date.now(),
  };
}
