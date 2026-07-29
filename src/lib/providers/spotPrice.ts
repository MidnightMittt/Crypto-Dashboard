import { AssetSymbol } from "@/types/market";
import { SpotPrice, fetchSpotPrice as fetchDexScreenerSpot } from "./dexscreener";
import { fetchAlchemySpot } from "./alchemy";
import { fetchJupiterSpot } from "./jupiterPrice";
import { ALL_ASSETS } from "../exchanges/registry";

/**
 * Spot price resolver.
 *
 * Tries sources in quality order and returns the first that answers. This
 * is what makes the basis figure reliable rather than dependent on a single
 * upstream staying healthy:
 *
 *   1. Alchemy      — volume-weighted average across CEXs and DEXs
 *   2. Jupiter V3   — oracle-anchored, outlier-filtered (Solana assets)
 *   3. DexScreener  — deepest single on-chain pool
 *
 * Returns null if both fail, so basis renders as "—" rather than as a
 * confident number built on nothing.
 */
export async function resolveSpotPrice(asset: AssetSymbol): Promise<SpotPrice | null> {
  const alchemy = await fetchAlchemySpot(asset, ALL_ASSETS);
  if (alchemy) return alchemy;

  const jupiter = await fetchJupiterSpot(asset);
  if (jupiter) return jupiter;

  const dex = await fetchDexScreenerSpot(asset);
  if (dex) return dex;

  return null;
}

/**
 * Cross-checks the two sources when both respond. A large disagreement
 * means one of them is quoting something unreliable — a thin pool, a
 * bridged wrapper, or stale data — and the basis figure shouldn't be
 * trusted at face value.
 */
export async function resolveSpotWithConfidence(
  asset: AssetSymbol
): Promise<{ price: SpotPrice | null; disagreementPct: number | null; sourceCount: number }> {
  const [alchemy, jupiter, dex] = await Promise.all([
    fetchAlchemySpot(asset, ALL_ASSETS),
    fetchJupiterSpot(asset),
    fetchDexScreenerSpot(asset),
  ]);

  const candidates = [alchemy, jupiter, dex].filter((p): p is SpotPrice => p !== null);
  const price = alchemy ?? jupiter ?? dex;

  // Widest spread across everything that answered. With three sources this
  // catches an outlier that a two-way comparison would average away.
  let disagreementPct: number | null = null;
  if (candidates.length >= 2) {
    const values = candidates.map((c) => c.priceUsd).filter((v) => v > 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min > 0) disagreementPct = ((max - min) / min) * 100;
  }

  return { price, disagreementPct, sourceCount: candidates.length };
}
