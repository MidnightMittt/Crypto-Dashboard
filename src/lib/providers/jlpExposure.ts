import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { PROVIDER_FETCH_TIMEOUT_MS, timeoutSignal } from "../net/timeout";

/**
 * Jupiter JLP pool exposure — per-asset long and short notional.
 *
 * Endpoint: https://perps-api.jup.ag/v1/jlp-info  (public, no key)
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * Order-book venues can't publish a meaningful long/short notional split:
 * every long is matched by a short, so it's always 1:1. That's why OKX and
 * Binance publish an *account* ratio instead — a headcount of traders.
 *
 * Jupiter is peer-to-pool. The JLP pool takes the other side of every trade,
 * so long and short notional genuinely diverge, and the gap is the pool's net
 * exposure. That is real information no order-book venue can provide, and it
 * is NOT the same measurement as an account ratio — the two must never be
 * averaged together.
 *
 * ── How the numbers are derived, and how that was verified ─────────────
 *
 *   shortUsd = globalShortSizes                    (already USD, 6 decimals)
 *   longUsd  = locked (tokens) x current price
 *
 * `locked` is the token reserve backing long positions. Jupiter locks tokens
 * equal to the position size so profits are always payable, which makes
 * locked x price the long notional.
 *
 * Confirmed three ways:
 *   1. locked / owned == the `utilizationPct` the same payload reports
 *      (WBTC: 18,034,732,757 / 176,990,559,753 = 10.19% vs 10.18% stated).
 *   2. `guaranteedUsd` is Sum(size - collateral) and must therefore be less
 *      than long size. It is, for every custody: 9.42M < 11.58M (BTC),
 *      18.74M < 24.68M (SOL), 7.51M < 8.24M (ETH).
 *   3. The implied leverage (size / (size - guaranteedUsd)) lands at 5.4x,
 *      4.2x and 11.3x — ordinary figures for this venue.
 *
 * Do NOT add guaranteedUsd to longUsd. It is an accounting quantity for the
 * pool's AUM, not additional open interest, and adding it double-counts.
 *
 * These same fields were independently decoded from the on-chain custody
 * accounts (Anchor discriminator 01b830515d833f91, assets struct at byte
 * 214) and matched this endpoint exactly. The REST route is used because it
 * needs no RPC provider.
 */
const URL = "https://perps-api.jup.ag/v1/jlp-info";
const CACHE_MS = 30_000;

/** JLP custody symbols differ from our asset symbols. */
const SYMBOL_TO_ASSET: Record<string, AssetSymbol> = {
  SOL: "SOL",
  ETH: "ETH",
  WBTC: "BTC",
};

interface JlpCustody {
  symbol?: string;
  /** Raw token units. */
  owned?: string;
  /** Raw token units reserved against long positions. */
  locked?: string;
  /** USD with 6 decimals. */
  guaranteedUsd?: string;
  globalShortSizes?: string;
  globalShortAveragePrice?: string;
  utilizationPct?: string;
  aumTokenAmount?: string;
  aumTokenAmountFormatted?: string;
}

interface JlpInfo {
  aumUsd?: string;
  custodies?: JlpCustody[];
}

export interface PoolExposure {
  asset: AssetSymbol;
  longUsd: number;
  shortUsd: number;
}

/** USD fields in this payload carry six decimals. */
const USD_DECIMALS = 1e6;

/**
 * Token decimals aren't stated, so they're derived from the raw amount
 * against its own formatted string. Hardcoding a table would silently break
 * if Jupiter ever swapped a wrapped asset for one with different decimals.
 */
function decimalsFor(c: JlpCustody): number {
  const raw = safeNumber(c.aumTokenAmount);
  const formatted = parseFloat((c.aumTokenAmountFormatted ?? "").replace(/,/g, ""));
  if (!(raw > 0) || !(formatted > 0)) return 0;
  const exponent = Math.round(Math.log10(raw / formatted));
  return exponent >= 0 && exponent <= 18 ? exponent : 0;
}

let cache: { rows: JlpCustody[]; fetchedAt: number } | null = null;
let inflight: Promise<JlpCustody[]> | null = null;

async function getCustodies(): Promise<JlpCustody[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;
  if (inflight) return inflight;

  // One request covers all three assets, so it is a bulk call in the same
  // sense as CoinGecko's — it gets the longer deadline. Under the full
  // fan-out this endpoint runs 3s+, which overran the tight adapter cap.
  inflight = fetchJson<JlpInfo>(URL, { signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS) })
    .then((res) => {
      const rows = res.custodies ?? [];
      cache = { rows, fetchedAt: Date.now() };
      return rows;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Long and short notional for one asset. `price` is required because the
 * long side is stored in tokens; pass the venue's current mark.
 *
 * Returns null for stablecoin custodies and anything Jupiter doesn't trade.
 */
export async function fetchJlpExposure(
  asset: AssetSymbol,
  price: number
): Promise<PoolExposure | null> {
  if (!(price > 0)) return null;

  try {
    const custodies = await getCustodies();
    const row = custodies.find(
      (c) => c.symbol && SYMBOL_TO_ASSET[c.symbol.toUpperCase()] === asset
    );
    if (!row) return null;

    const decimals = decimalsFor(row);
    if (!decimals) return null;

    const lockedTokens = safeNumber(row.locked) / Math.pow(10, decimals);
    const longUsd = lockedTokens * price;
    const shortUsd = safeNumber(row.globalShortSizes) / USD_DECIMALS;

    if (longUsd <= 0 && shortUsd <= 0) return null;

    return { asset, longUsd, shortUsd };
  } catch (err) {
    console.warn(`[jlp-exposure] fetch failed for ${asset}:`, err);
    return null;
  }
}
