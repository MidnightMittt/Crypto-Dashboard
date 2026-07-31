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
export async function resolveSpotWithConfidence(asset: AssetSymbol): Promise<{
  price: SpotPrice | null;
  disagreementPct: number | null;
  sourceCount: number;
  /**
   * (Coinbase spot - median of the OTHER responding spot sources) / that
   * median * 100. Null unless both Coinbase AND at least one other source
   * answered — a premium against nothing isn't a premium.
   *
   * This is a deliberate redefinition of "Coinbase Premium" from its
   * traditional form (Coinbase vs. Binance specifically): Binance's spot
   * API is unreachable directly from this app's hosting region for the same
   * geo-blocking reason its perp data already routes through Coinalyze/
   * CoinGecko. Comparing Coinbase against the blended Alchemy/Jupiter/
   * DexScreener reference instead is a defensible stand-in for "Coinbase vs.
   * the rest of the market" — and it's free, reusing spot sources this
   * function was already fetching for basis. Disclosed as exactly that in
   * the UI, not presented as the textbook Binance-comparison figure.
   */
  coinbasePremiumPct: number | null;
}> {
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
  /*
   * Coinbase is the reference when it answers.
   *
   * A median across responders isn't enough on its own. For SOL, every
   * DexScreener pool that passed its own filters was still 5-23% away from
   * true spot ($91.10 / $88.29 / $81.61 / $77.49 against $73.95) — the
   * majority were wrong, so the median was wrong too.
   *
   * Coinbase quotes a regulated exchange's own book against USD and cannot
   * return a different asset, which makes it a reference rather than just
   * another opinion. When present, everything else has to corroborate it
   * within a tolerance that is wide for spot-vs-spot and far narrower than a
   * ticker collision.
   *
   * Falls back to the median when Coinbase is unavailable, which still catches
   * a lone outlier among several sources.
   */
  const REFERENCE_TOLERANCE = 0.05;
  const MEDIAN_TOLERANCE = 0.5;

  const sorted = [...answered].sort((a, b) => a.priceUsd - b.priceUsd);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)].priceUsd : 0;

  const reference = coinbase?.priceUsd ?? 0;
  const anchor = reference > 0 ? reference : median;
  const tolerance = reference > 0 ? REFERENCE_TOLERANCE : MEDIAN_TOLERANCE;

  const candidates =
    anchor > 0
      ? answered.filter((c) => Math.abs(c.priceUsd - anchor) / anchor <= tolerance)
      : answered;

  const rejected = answered.length - candidates.length;
  if (rejected > 0) {
    console.warn(
      `[spot] ignoring ${rejected} of ${answered.length} source(s) for ${asset}: ` +
        `more than ${(tolerance * 100).toFixed(0)}% from the $${anchor.toFixed(2)} ` +
        `${reference > 0 ? "Coinbase reference" : "median"}`
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

  // Median of the OTHER sources only — comparing Coinbase against a blend
  // that includes Coinbase itself would understate any real gap.
  let coinbasePremiumPct: number | null = null;
  if (coinbase && coinbase.priceUsd > 0) {
    const others = [alchemy, jupiter, dex]
      .filter((p): p is SpotPrice => p !== null && p.priceUsd > 0)
      .map((p) => p.priceUsd)
      .sort((a, b) => a - b);
    if (others.length > 0) {
      const othersMedian = others[Math.floor(others.length / 2)];
      if (othersMedian > 0) {
        coinbasePremiumPct = ((coinbase.priceUsd - othersMedian) / othersMedian) * 100;
      }
    }
  }

  return { price, disagreementPct, sourceCount: candidates.length, coinbasePremiumPct };
}
