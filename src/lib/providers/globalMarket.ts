import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * CoinGecko global market data — free, keyless.
 *
 *   GET /global                 -> total market cap, BTC/ETH dominance
 *   GET /coins/markets?...      -> top-N coins with 30d performance
 *
 * Market-wide, not per-asset — doesn't belong on any one asset's card.
 *
 * ── Altseason index caveat ──────────────────────────────────────────────
 *
 * The widely-cited "Altcoin Season Index" (blockchaincenter.net's original
 * definition) uses a TRAILING 90-DAY window. CoinGecko's free /coins/markets
 * endpoint only exposes `price_change_percentage_{period}_in_currency` for
 * 1h/24h/7d/14d/30d/200d/1y — there is no 90d option at this tier. Rather
 * than silently mislabel a 30d figure as "the" altseason index, this uses
 * 30d and says so everywhere it's surfaced. Same "flag out the constraint,
 * don't reroute the value" precedent as Tradier's sandbox 15-minute delay.
 */
const GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
const MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&price_change_percentage=30d";
const CACHE_MS = 5 * 60_000;

export const ALTSEASON_WINDOW_DAYS = 30;

export interface GlobalMarketSummary {
  totalMcapUsd: number;
  mcapChange24hPct: number;
  btcDominancePct: number;
  ethDominancePct: number;
  /** % of the top-50 non-BTC, non-stablecoin coins that outperformed BTC over ALTSEASON_WINDOW_DAYS. 0-100. */
  altseasonIndex: number;
  updatedAt: number;
}

interface GeckoGlobalResponse {
  data?: {
    total_market_cap?: { usd?: number };
    market_cap_change_percentage_24h_usd?: number;
    market_cap_percentage?: { btc?: number; eth?: number };
  };
}

interface GeckoMarketRow {
  symbol?: string;
  price_change_percentage_30d_in_currency?: number | null;
}

/**
 * Common USD-pegged stablecoin tickers, excluded from the altseason
 * calculation — by construction they don't move, and counting them would
 * understate how many GENUINE alts are outperforming BTC. CoinGecko's
 * /coins/markets doesn't carry a pegType flag the way its dedicated
 * stablecoins endpoint does, so this is a maintained blocklist rather than
 * a field check — same tradeoff normalizeExchangeName's venue-name map
 * already makes elsewhere in this codebase.
 */
const STABLECOIN_SYMBOLS = new Set([
  "usdt", "usdc", "dai", "busd", "tusd", "usdp", "gusd", "usdd",
  "fdusd", "pyusd", "usde", "frax", "lusd", "ustc", "eurt", "usds",
]);

function demoKeyHeader(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

let cache: { summary: GlobalMarketSummary | null; fetchedAt: number } | null = null;

export async function fetchGlobalMarketSummary(): Promise<GlobalMarketSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.summary;

  try {
    const [globalRes, marketsRes] = await Promise.all([
      fetch(GLOBAL_URL, {
        headers: { accept: "application/json", ...demoKeyHeader() },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }),
      fetch(MARKETS_URL, {
        headers: { accept: "application/json", ...demoKeyHeader() },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }),
    ]);

    if (!globalRes.ok) throw new Error(`CoinGecko /global HTTP ${globalRes.status}`);

    const globalJson = (await globalRes.json()) as GeckoGlobalResponse;
    const totalMcapUsd = globalJson.data?.total_market_cap?.usd ?? 0;
    const btcDominancePct = globalJson.data?.market_cap_percentage?.btc ?? 0;
    if (totalMcapUsd <= 0 || btcDominancePct <= 0) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    // Altseason index degrades gracefully to 0 (not null) if the markets
    // call fails — dominance/mcap are still worth showing on their own.
    let altseasonIndex = 0;
    if (marketsRes.ok) {
      const rows = (await marketsRes.json()) as GeckoMarketRow[];
      const btcRow = rows.find((r) => r.symbol?.toLowerCase() === "btc");
      const btcChange = btcRow?.price_change_percentage_30d_in_currency;

      if (typeof btcChange === "number") {
        const alts = rows.filter(
          (r) =>
            r.symbol &&
            r.symbol.toLowerCase() !== "btc" &&
            !STABLECOIN_SYMBOLS.has(r.symbol.toLowerCase()) &&
            typeof r.price_change_percentage_30d_in_currency === "number"
        );
        if (alts.length > 0) {
          const outperformed = alts.filter(
            (r) => (r.price_change_percentage_30d_in_currency as number) > btcChange
          ).length;
          altseasonIndex = (outperformed / alts.length) * 100;
        }
      }
    }

    const summary: GlobalMarketSummary = {
      totalMcapUsd,
      mcapChange24hPct: globalJson.data?.market_cap_change_percentage_24h_usd ?? 0,
      btcDominancePct,
      ethDominancePct: globalJson.data?.market_cap_percentage?.eth ?? 0,
      altseasonIndex,
      updatedAt: Date.now(),
    };

    cache = { summary, fetchedAt: Date.now() };
    return summary;
  } catch (err) {
    console.warn("[global-market] fetch failed:", err);
    return null;
  }
}
