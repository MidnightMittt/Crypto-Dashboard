import { AssetSymbol, ExchangeSnapshot } from "@/types/market";

/**
 * A "provider" differs from an adapter.
 *
 *   Adapter  → one exchange, queried directly at its own API.
 *   Provider → an aggregator (Coinalyze, DefiLlama) that redistributes data
 *              for MANY exchanges in a single call.
 *
 * Providers exist because several major venues (Binance, Bybit, OKX) block
 * requests from some regions with HTTP 403. Rather than trying to evade that
 * — which is both a compliance control and technically brittle — we read the
 * same numbers from services that license and redistribute them.
 *
 * Merge policy in the aggregator: a direct adapter always wins over a
 * provider for the same venue, because it's first-hand and lower latency.
 * Providers fill in the venues that direct access couldn't reach.
 *
 * A provider returns [] on failure — never throws, never invents data.
 */
export type MarketDataProvider = {
  id: string;
  name: string;
  /** Whether this provider is usable right now (e.g. has its API key set). */
  isConfigured: () => boolean;
  fetch: (asset: AssetSymbol) => Promise<ExchangeSnapshot[]>;
};

/**
 * Maps an aggregator's exchange label onto our registry ids.
 * Aggregators spell venue names inconsistently ("Binance", "binance",
 * "BinanceFutures"), so match case-insensitively on a normalized key.
 */
export function normalizeExchangeName(raw: string): string | null {
  // Aggregators decorate venue names in ways that all break naive matching:
  //   parentheticals   "Bybit (Futures)"
  //   version tokens   "GMX V2 Perpetuals"   (mid-string, not just trailing)
  //   descriptor words "Coinbase Derivatives Exchange"  (often stacked)
  const withoutParens = raw.replace(/\([^)]*\)/g, " ");
  // Strip version tokens ANYWHERE, not only at the end — "GMX V2 Perpetuals"
  // has the version in the middle.
  const withoutVersion = withoutParens.replace(/\bv?\d+(\.\d+)*\b/gi, " ");

  let key = withoutVersion.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;

  const map = EXCHANGE_NAME_MAP;

  // Check before stripping anything. Critical: "paradex" is a whole venue
  // name that happens to END in "dex". Stripping descriptors blindly turns
  // it into "para" and the venue disappears. Always test the current key
  // against the map first, and stop at the first match.
  if (map[key]) return map[key];

  const descriptors = [
    "perpetualexchange", "perpetuals", "perpetual", "derivatives", "derivative",
    "exchange", "futures", "future", "protocol", "finance", "markets", "market",
    "perps", "perp", "swaps", "swap", "trade", "global", "labs", "network", "dex",
  ];

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const d of descriptors) {
      if (key.length > d.length && key.endsWith(d)) {
        key = key.slice(0, -d.length);
        stripped = true;
        // Re-test immediately so we never strip past a valid name.
        if (map[key]) return map[key];
        break;
      }
    }
  }

  return map[key] ?? null;
}

const EXCHANGE_NAME_MAP: Record<string, string> = {
    binance: "binance",
    binancefutures: "binance",
    binanceusdm: "binance",
    bybit: "bybit",
    okx: "okx",
    okex: "okx",
    bitget: "bitget",
    gate: "gateio",
    gateio: "gateio",
    kraken: "kraken",
    krakenfutures: "kraken",
    hyperliquid: "hyperliquid",
    dydx: "dydx",
    dydxv4: "dydx",
    deribit: "deribit",
    mexc: "mexc",
    htx: "htx",
    huobi: "htx",
    bingx: "bingx",
    coinbase: "coinbase-intl",
    coinbaseintl: "coinbase-intl",
    coinbaseinternational: "coinbase-intl",
    vertex: "vertex",
    aevo: "aevo",
    gmx: "gmx",
    gmxv2: "gmx",
    drift: "drift",
    jupiter: "jupiter",
    jupiterperps: "jupiter",
    jupiterperpetualexchange: "jupiter",
    synthetix: "synthetix",
    gains: "gains",
    gtrade: "gains",
    apollox: "apollox",
    mango: "mango",
    paradex: "paradex",
    lighter: "lighter",
    aster: "aster",
    edgex: "edgex",
    extended: "extended",
};
