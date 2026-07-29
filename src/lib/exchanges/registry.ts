import { AssetSymbol, ExchangeMeta } from "@/types/market";

export const ALL_ASSETS: AssetSymbol[] = [
  "BTC", "ETH", "SOL", "BNB", "SUI", "XRP", "DOGE", "LINK", "ADA", "AVAX",
];

/**
 * The exchange registry — every venue here has a working adapter hitting a
 * real public API. There is no mock or simulated data anywhere in this app.
 *
 * `assets` is advisory: it avoids a pointless network call for a market we
 * know a venue doesn't list. The authoritative check is the adapter itself,
 * which returns null when a symbol isn't found; the aggregator then drops
 * that venue from the results rather than inventing a value.
 *
 * To add an exchange:
 *   1. Write an adapter in ./adapters (copy binance.ts as a template).
 *   2. Add an entry here.
 *   3. Register it in ADAPTER_MAP in ../aggregator.ts.
 */
export const EXCHANGES: ExchangeMeta[] = [
  {
    id: "binance",
    name: "Binance",
    type: "CEX",
    status: "live",
    color: "#F0B90B",
    docsUrl: "https://binance-docs.github.io/apidocs/futures/en/",
    assets: ALL_ASSETS,
  },
  {
    id: "bybit",
    name: "Bybit",
    type: "CEX",
    status: "live",
    color: "#F7A600",
    docsUrl: "https://bybit-exchange.github.io/docs/v5/intro",
    assets: ALL_ASSETS,
  },
  {
    id: "okx",
    name: "OKX",
    type: "CEX",
    status: "live",
    color: "#E8EDF2",
    docsUrl: "https://www.okx.com/docs-v5/en/",
    assets: ALL_ASSETS,
  },
  {
    id: "bitget",
    name: "Bitget",
    type: "CEX",
    status: "live",
    color: "#00F0FF",
    docsUrl: "https://www.bitget.com/api-doc/contract/intro",
    assets: ALL_ASSETS,
  },
  {
    id: "gateio",
    name: "Gate.io",
    type: "CEX",
    status: "live",
    color: "#E2394B",
    docsUrl: "https://www.gate.io/docs/developers/apiv4/en/",
    assets: ALL_ASSETS,
  },
  {
    id: "kraken",
    name: "Kraken",
    type: "CEX",
    status: "live",
    color: "#7B68EE",
    docsUrl: "https://docs.kraken.com/api/docs/futures-api/trading/get-tickers",
    assets: ALL_ASSETS,
  },
  {
    id: "hyperliquid",
    name: "Hyperliquid",
    type: "DEX",
    status: "live",
    color: "#4ADE80",
    docsUrl: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api",
    assets: ALL_ASSETS,
  },
  {
    id: "jupiter",
    name: "Jupiter Perps",
    type: "DEX",
    status: "live",
    color: "#C7F284",
    docsUrl: "https://dev.jup.ag/docs/",
    // LP-to-trader model against the JLP pool — only these three markets.
    assets: ["BTC", "ETH", "SOL"],
    // Direct adapter supplies borrow rates from perps-api.jup.ag; open
    // interest still comes from the provider layer, merged field-by-field.
    // See adapters/jupiter.ts for why OI can't be attributed per asset.
  },
  {
    id: "drift",
    name: "Drift",
    type: "DEX",
    status: "live",
    color: "#8266F0",
    docsUrl: "https://drift-labs.github.io/v2-teacher/",
    assets: ALL_ASSETS,
    // data.api.drift.trade returns HTTP 403 from geofenced regions (incl.
    // the US) — Drift applies the same restrictions as the major CEXs
    // despite being a DEX. Marked providerOnly so aggregators can supply it
    // and the direct adapter doesn't log a failure every poll.
    providerOnly: true,
  },
  {
    id: "dydx",
    name: "dYdX",
    type: "DEX",
    status: "live",
    color: "#8B87FF",
    docsUrl: "https://docs.dydx.xyz/api_integration-indexer/indexer_api",
    assets: ALL_ASSETS,
  },

  // ── Reachable only through an aggregator (Coinalyze / DefiLlama) ────────
  // No direct adapter; they appear when a provider supplies them and are
  // simply absent otherwise.
  // Direct adapter — queries BOTH the inverse and USDC perps and sums them.
  { id: "deribit", name: "Deribit", type: "CEX", status: "live", color: "#00A7E1",
    docsUrl: "https://docs.deribit.com/", assets: ALL_ASSETS },
  { id: "mexc", name: "MEXC", type: "CEX", status: "live", color: "#00CFAE",
    docsUrl: "https://mexcdevelop.github.io/apidocs/contract_v1_en/", assets: ALL_ASSETS },
  // KuCoin uses XBT for bitcoin; see adapters/kucoin.ts.
  { id: "kucoin", name: "KuCoin Futures", type: "CEX", status: "live", color: "#24AE8F",
    docsUrl: "https://www.kucoin.com/docs/rest/futures-trading/market-data", assets: ALL_ASSETS },
  { id: "htx", name: "HTX", type: "CEX", status: "live", color: "#2CA6E0",
    docsUrl: "https://huobiapi.github.io/docs/dm/v1/en/", assets: ALL_ASSETS },
  { id: "bingx", name: "BingX", type: "CEX", status: "live", color: "#1B72FF",
    docsUrl: "https://bingx-api.github.io/docs/", assets: ALL_ASSETS, providerOnly: true },
  // Direct adapter — public market data, no key. Listed here rather than
  // above only to keep the CEX block visually together.
  { id: "coinbase-intl", name: "Coinbase Intl.", type: "CEX", status: "live", color: "#1652F0",
    docsUrl: "https://docs.cdp.coinbase.com/intx/docs/welcome", assets: ALL_ASSETS },
  { id: "vertex", name: "Vertex", type: "DEX", status: "live", color: "#43E5A0",
    docsUrl: "https://docs.vertexprotocol.com/", assets: ALL_ASSETS, providerOnly: true },
  { id: "aevo", name: "Aevo", type: "DEX", status: "live", color: "#FF3B69",
    docsUrl: "https://docs.aevo.xyz/", assets: ALL_ASSETS },
  // GMX + Synthetix have subgraph adapters, but those need THE_GRAPH_API_KEY.
  // Left flagged so an unconfigured setup doesn't report them as "unavailable" —
  // they just don't appear until a key is set, or an aggregator covers them.
  { id: "gmx", name: "GMX", type: "DEX", status: "live", color: "#2D42FC",
    docsUrl: "https://gmx-docs.io/", assets: ["BTC","ETH","SOL","LINK","AVAX","DOGE"], providerOnly: true },
  { id: "synthetix", name: "Synthetix Perps", type: "DEX", status: "live", color: "#00D1FF",
    docsUrl: "https://docs.synthetix.io/", assets: ALL_ASSETS, providerOnly: true },
  { id: "paradex", name: "Paradex", type: "DEX", status: "live", color: "#B026FF",
    docsUrl: "https://docs.paradex.trade/", assets: ALL_ASSETS },
  { id: "lighter", name: "Lighter", type: "DEX", status: "live", color: "#7DD3FC",
    docsUrl: "https://docs.lighter.xyz/", assets: ALL_ASSETS, providerOnly: true },
  // Binance-compatible API and not geo-blocked, so this one is first-hand.
  // ── Newly added direct venues ──────────────────────────────────────────
  // BitMEX quotes bitcoin as XBT and mixes inverse and linear contracts with
  // different open-interest units; see adapters/bitmex.ts.
  { id: "bitmex", name: "BitMEX", type: "CEX", status: "live", color: "#EE3D23",
    docsUrl: "https://www.bitmex.com/api/explorer/", assets: ALL_ASSETS },
  { id: "phemex", name: "Phemex", type: "CEX", status: "live", color: "#00B4C8",
    docsUrl: "https://phemex-docs.github.io/", assets: ALL_ASSETS },
  { id: "backpack", name: "Backpack", type: "DEX", status: "live", color: "#E33E3F",
    docsUrl: "https://docs.backpack.exchange/", assets: ALL_ASSETS },
  { id: "orderly", name: "Orderly", type: "DEX", status: "live", color: "#6A4DFF",
    docsUrl: "https://orderly.network/docs", assets: ALL_ASSETS },
  { id: "aster", name: "Aster", type: "DEX", status: "live", color: "#F59E0B",
    docsUrl: "https://docs.asterdex.com/", assets: ALL_ASSETS },
];


export function getExchange(id: string): ExchangeMeta | undefined {
  return EXCHANGES.find((e) => e.id === id);
}

export function exchangesForAsset(asset: AssetSymbol): ExchangeMeta[] {
  return EXCHANGES.filter((e) => e.assets.includes(asset));
}