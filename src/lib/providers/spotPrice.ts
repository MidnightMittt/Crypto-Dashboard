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

  const answered = [coinbase, alchemy, jupiter, dex].filter(
    (p): p is SpotPrice => p !== null && p.priceUsd > 0
  );
  const price = coinbase ?? alchemy ?? jupiter ?? dex;

  /*
   * Discard sources quoting a different asset before measuring agreement.
   *
   * DexScreener matches on ticker text and Solana is full of worthless tokens
   * calling themselves "BTC", so it can answer with a ~$1 price for a $64,000
   * asset. The basis calculation already rejects that, but the DISAGREEMENT
   * figure was computed across every responder including the bogus one — and
   * displayed "Spot sources disagree by 6100199.90% — treat this basis figure
   * with caution" on the dashboard. Technically true, entirely useless.
   *
   * The median is the robust centre here: with one wild outlier among three or
   * four sources it stays on the real price, where the mean would be dragged
   * away. Anything more than 50% from it is quoting a different asset, not
   * disagreeing about this one — that's generous enough to never fire on a
   * genuinely dislocated market.
   */
  const sorted = [...answered].sort((a, b) => a.priceUsd - b.priceUsd);
  const median = sorted.length
    ? sorted[Math.floor(sorted.length / 2)].priceUsd
    : 0;

  const candidates =
    median > 0
      ? answered.filter((c) => Math.abs(c.priceUsd - median) / median <= 0.5)
      : answered;

  const rejected = answered.length - candidates.length;
  if (rejected > 0) {
    console.warn(
      `[spot] ignoring ${rejected} source(s) for ${asset} more than 50% from the ` +
        `$${median.toFixed(2)} median — almost certainly a different asset with the same ticker`
    );
  }

  // Widest spread across the sources that agree on which asset this is.
  let disagreementPct: number | null = null;
  if (candidates.length >= 2) {
    const values = candidates.map((c) => c.priceUsd);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min > 0) disagreementPct = ((max - min) / min) * 100;
  }

  return { price, disagreementPct, sourceCount: candidates.length };
}
