import { AssetSymbol } from "@/types/market";
import { SpotPrice, fetchSpotPrice as fetchDexScreenerSpot } from "./dexscreener";
import { fetchAlchemySpot } from "./alchemy";
import { fetchJupiterSpot } from "./jupiterPrice";
import { fetchCoinbaseSpot } from "./coinbaseSpot";
import { ALL_ASSETS } from "../exchanges/registry";

/**
 * Spot price resolver.
 *
 * Tries sources in quality order and returns the first that answers. This
 * is what makes the basis figure reliable rather than dependent on a single
 * upstream staying healthy:
 *
 *   1. Coinbase     — regulated exchange book against USD, no ticker ambiguity
 *   2. Alchemy      — volume-weighted average across CEXs and DEXs
 *   3. Jupiter V3   — oracle-anchored, outlier-filtered (Solana assets)
 *   4. DexScreener  — deepest single on-chain pool
 *
 * Coinbase leads because it is the only one of the four that cannot return
 * the wrong asset. Alchemy's shared demo key answers 403 without a key of
 * your own, and DexScreener matches on ticker text — between them they once
 * produced a $1 Solana meme token as the spot price for a $64,000 BTC perp.
 *
 * Returns null if all fail, so basis renders as "—" rather than as a
 * confident number built on nothing.
 */
export async function resolveSpotPrice(asset: AssetSymbol): Promise<SpotPrice | null> {
  const coinbase = await fetchCoinbaseSpot(asset);
  if (coinbase) return coinbase;

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
  const [coinbase, alchemy, jupiter, dex] = await Promise.all([
    fetchCoinbaseSpot(asset),
    fetchAlchemySpot(asset, ALL_ASSETS),
    fetchJupiterSpot(asset),
    fetchDexScreenerSpot(asset),
  ]);

  const candidates = [coinbase, alchemy, jupiter, dex].filter(
    (p): p is SpotPrice => p !== null
  );
  const price = coinbase ?? alchemy ?? jupiter ?? dex;

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
