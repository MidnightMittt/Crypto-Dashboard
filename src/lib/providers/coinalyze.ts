import { AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { MarketDataProvider, normalizeExchangeName } from "./types";
import { DropCounter, log, loggedFetch, loggedParse } from "./debug";

/**
 * Coinalyze — free API, requires a key from https://coinalyze.net/account/api-key/
 *
 * Redistributes perpetuals data across ~20 exchanges, including venues that
 * block direct API access from some regions. Uniquely among our sources it
 * also provides long/short ratio and liquidation history.
 *
 * Rate limit: 40 calls/minute, and EACH SYMBOL in a request counts as one
 * call. With ~8 venues × 10 assets that ceiling is easy to hit, so this
 * provider caches aggressively and batches symbols per request.
 */
const BASE = "https://api.coinalyze.net/v1";
const MARKETS_CACHE_MS = 6 * 60 * 60 * 1000; // market list changes rarely
const DATA_CACHE_MS = 180_000; // 3min — the limit matters more than freshness here
const MAX_SYMBOLS_PER_CALL = 20;

/**
 * Coinalyze allows 40 API calls per minute per key, and EACH SYMBOL in a
 * request counts as a call. Whole-market mode queries 10 assets, which
 * blew straight past that and got the provider 429'd into silence — long/
 * short ratios vanished from every card with no visible error.
 *
 * This is a token bucket sized conservatively below the documented limit.
 * When the budget is exhausted the provider returns whatever is cached
 * rather than failing, so coverage degrades gradually instead of collapsing.
 */
const RATE_LIMIT_PER_MIN = 34; // headroom under the documented 40
const rateWindow: number[] = [];

function budgetRemaining(): number {
  const cutoff = Date.now() - 60_000;
  while (rateWindow.length > 0 && rateWindow[0] < cutoff) rateWindow.shift();
  return RATE_LIMIT_PER_MIN - rateWindow.length;
}

/** Records `cost` calls against the budget. Returns false if unaffordable. */
function spendBudget(cost: number): boolean {
  if (budgetRemaining() < cost) return false;
  const now = Date.now();
  for (let i = 0; i < cost; i++) rateWindow.push(now);
  return true;
}

interface FutureMarket {
  symbol: string;
  exchange: string; // single-letter exchange code
  base_asset: string;
  quote_asset: string;
  is_perpetual: boolean;
  has_long_short_ratio_data?: boolean;
}

interface ExchangeInfo {
  name: string;
  code: string;
}

interface ValueRow {
  symbol: string;
  value: number;
  update: number;
}

interface HistoryRow {
  symbol: string;
  history: Array<{ t: number; o?: number; h?: number; l?: number; c?: number; r?: number }>;
}

function apiKey(): string | undefined {
  return process.env.COINALYZE_API_KEY?.trim() || undefined;
}

async function call<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = apiKey();
  if (!key) {
    log("coinalyze", "AUTH no COINALYZE_API_KEY set — provider inactive, no request made");
    throw new Error("COINALYZE_API_KEY not set");
  }
  log("coinalyze", `AUTH key present (length=${key.length}, ends …${key.slice(-4)})`);

  const qs = new URLSearchParams({ ...params, api_key: key });
  // loggedFetch redacts api_key before printing.
  const { res, text } = await loggedFetch("coinalyze", `${BASE}${path}?${qs}`, {
    headers: { accept: "application/json" },
    next: { revalidate: 30 },
  } as RequestInit);

  if (res.status === 429) {
    const retry = res.headers.get("Retry-After") ?? "?";
    log("coinalyze", `RATE LIMIT 429 — Retry-After=${retry}s (limit is 40 calls/min)`);
    throw new Error(`Coinalyze rate limit hit (retry after ${retry}s)`);
  }
  if (res.status === 401 || res.status === 403) {
    log("coinalyze", `AUTH REJECTED status=${res.status} — key is likely invalid or revoked`);
  }
  if (!res.ok) throw new Error(`Coinalyze HTTP ${res.status} on ${path}`);

  const parsed = loggedParse<T>("coinalyze", text);
  if (parsed === null) throw new Error(`Coinalyze returned unparseable JSON on ${path}`);
  return parsed;
}

let marketsCache: {
  markets: FutureMarket[];
  exchanges: Map<string, string>;
  fetchedAt: number;
} | null = null;

async function getMarkets() {
  if (marketsCache && Date.now() - marketsCache.fetchedAt < MARKETS_CACHE_MS) {
    return marketsCache;
  }

  const [markets, exchanges] = await Promise.all([
    call<FutureMarket[]>("/future-markets", {}),
    call<ExchangeInfo[]>("/exchanges", {}),
  ]);

  const perps = markets.filter((m) => m.is_perpetual);
  log(
    "coinalyze",
    `MARKETS total=${markets.length} perpetual=${perps.length} exchanges=${exchanges.length}`
  );
  log(
    "coinalyze",
    `MARKETS exchange codes: ${exchanges.map((e) => `${e.code}=${e.name}`).slice(0, 40).join(", ")}`
  );

  marketsCache = {
    markets: perps,
    exchanges: new Map(exchanges.map((e) => [e.code, e.name])),
    fetchedAt: Date.now(),
  };
  return marketsCache;
}

/**
 * Pick one perpetual market per exchange for this asset, preferring
 * USDT-quoted (deepest liquidity, and comparable across venues).
 */
async function symbolsFor(asset: AssetSymbol) {
  const { markets, exchanges } = await getMarkets();

  const drops = new DropCounter("coinalyze");
  const candidates = markets.filter((m) => {
    const baseOk = m.base_asset.toUpperCase() === asset;
    const quoteOk = ["USDT", "USD", "USDC"].includes(m.quote_asset.toUpperCase());
    if (!baseOk) return false;
    if (!quoteOk) drops.drop(`quote asset ${m.quote_asset} not in USDT/USD/USDC`, m.symbol);
    return quoteOk;
  });
  log("coinalyze", `SYMBOLS ${asset}: ${candidates.length} candidate perpetual markets`);

  const byExchange = new Map<string, FutureMarket>();
  for (const m of candidates) {
    const exchangeName = exchanges.get(m.exchange) ?? m.exchange;
    const id = normalizeExchangeName(exchangeName);
    if (!id) {
      drops.drop(`exchange "${exchangeName}" (code ${m.exchange}) did not map to a known id`, exchangeName);
      continue;
    }

    const existing = byExchange.get(id);
    // Prefer USDT over USD/USDC when a venue lists several.
    if (!existing || (m.quote_asset.toUpperCase() === "USDT" && existing.quote_asset.toUpperCase() !== "USDT")) {
      byExchange.set(id, m);
    }
  }

  const selected = [...byExchange.entries()].slice(0, MAX_SYMBOLS_PER_CALL);
  drops.report(selected.length, candidates.length);
  log(
    "coinalyze",
    `SYMBOLS selected for ${asset}: ${selected.map(([id, m]) => `${id}:${m.symbol}`).join(", ") || "(none)"}`
  );
  return selected;
}

const dataCache = new Map<string, { snapshots: ExchangeSnapshot[]; fetchedAt: number }>();

export const coinalyzeProvider: MarketDataProvider = {
  id: "coinalyze",
  name: "Coinalyze",
  isConfigured: () => Boolean(apiKey()),
  fetch: async (asset: AssetSymbol): Promise<ExchangeSnapshot[]> => {
    if (!apiKey()) {
      log("coinalyze", "SKIP provider not configured — COINALYZE_API_KEY is empty/unset");
      return [];
    }

    const cached = dataCache.get(asset);
    if (cached && Date.now() - cached.fetchedAt < DATA_CACHE_MS) {
      return cached.snapshots;
    }

    try {
      const pairs = await symbolsFor(asset);
      if (pairs.length === 0) {
        log("coinalyze", `RESULT no symbols resolved for ${asset} — returning 0 snapshots`);
        return [];
      }

      // Each symbol counts as a call, across 4 endpoints. Check we can
      // afford the whole batch before starting — a half-finished batch
      // wastes budget and still yields nothing usable.
      const cost = pairs.length * 4;
      if (!spendBudget(cost)) {
        log(
          "coinalyze",
          `BUDGET skipping ${asset} — needs ${cost} calls, only ${budgetRemaining()} left this minute. ` +
            `Serving stale cache if available.`
        );
        return cached?.snapshots ?? [];
      }
      log("coinalyze", `BUDGET spending ${cost} calls for ${asset}, ${budgetRemaining()} remain`);

      const symbols = pairs.map(([, m]) => m.symbol).join(",");
      const nowSec = Math.floor(Date.now() / 1000);
      const dayAgoSec = nowSec - 7 * 24 * 60 * 60;

      const [funding, oi, oiHist, lsHist] = await Promise.all([
        call<ValueRow[]>("/funding-rate", { symbols }),
        call<ValueRow[]>("/open-interest", { symbols, convert_to_usd: "true" }),
        call<HistoryRow[]>("/open-interest-history", {
          symbols,
          interval: "1hour",
          from: String(dayAgoSec),
          to: String(nowSec),
          convert_to_usd: "true",
        }).catch(() => [] as HistoryRow[]),
        call<HistoryRow[]>("/long-short-ratio-history", {
          symbols,
          interval: "1hour",
          from: String(nowSec - 6 * 3600),
          to: String(nowSec),
        }).catch(() => [] as HistoryRow[]),
      ]);

      log(
        "coinalyze",
        `DATA funding=${funding.length} oi=${oi.length} oiHist=${oiHist.length} lsHist=${lsHist.length} (requested ${pairs.length} symbols)`
      );

      const fundingBySymbol = new Map(funding.map((r) => [r.symbol, r.value]));
      const oiBySymbol = new Map(oi.map((r) => [r.symbol, r.value]));
      const oiHistBySymbol = new Map(oiHist.map((r) => [r.symbol, r.history]));
      const lsBySymbol = new Map(lsHist.map((r) => [r.symbol, r.history]));

      const now = Date.now();
      const snapshots: ExchangeSnapshot[] = [];

      const dataDrops = new DropCounter("coinalyze");
      for (const [exchangeId, market] of pairs) {
        const openInterestUsd = oiBySymbol.get(market.symbol);
        const rawFunding = fundingBySymbol.get(market.symbol);
        if (openInterestUsd === undefined || rawFunding === undefined) {
          dataDrops.drop(
            `missing ${openInterestUsd === undefined ? "open interest" : "funding"} for ${market.symbol} (${exchangeId})`,
            market.symbol
          );
          continue;
        }

        const hourly = new Set(["hyperliquid", "dydx", "kraken", "vertex", "aevo"]);
        const intervalHours = hourly.has(exchangeId) ? 1 : 8;

        // OI history → 24h change + chart series.
        const history = oiHistBySymbol.get(market.symbol) ?? [];
        const fundingHistory: FundingPoint[] = history.map((h) => ({
          t: h.t * 1000,
          openInterestUsd: h.c,
        }));

        let openInterestChange24hPct: number | null = null;
        const dayAgoPoint = history.find((h) => h.t >= nowSec - 24 * 3600);
        if (dayAgoPoint?.c && dayAgoPoint.c > 0) {
          openInterestChange24hPct = ((openInterestUsd - dayAgoPoint.c) / dayAgoPoint.c) * 100;
        }

        // Long/short ratio: take the most recent point.
        const lsSeries = lsBySymbol.get(market.symbol) ?? [];
        const latestLs = lsSeries[lsSeries.length - 1];
        const longShortRatio = latestLs?.r ?? null;

        snapshots.push({
          exchangeId,
          asset,
          // Coinalyze returns funding ALREADY AS A PERCENTAGE (0.0027 means
          // 0.0027%), unlike most exchange APIs which return a decimal
          // fraction. Multiplying by 100 here previously inflated every
          // Coinalyze-sourced venue 100x — a normal 0.27 bp reading showed
          // as 27 bps, which reads as "extremely crowded longs" on a
          // perfectly neutral market.
          //
          // Caught because Binance and Bybit via Coinalyze both showed ~27
          // bps while the same assets via CoinGecko showed 1-3 bps. Funding
          // does not diverge that far between major venues; arbitrage closes
          // those gaps within hours.
          fundingRatePct: rawFunding,
          fundingIntervalHours: intervalHours,
          nextFundingAt:
            Math.ceil(now / (intervalHours * 3_600_000)) * (intervalHours * 3_600_000),
          openInterestUsd,
          openInterestChange24hPct,
          volume24hUsd: 0, // available via OHLCV, but that's another call per symbol
          longShortRatio,
          price: 0, // not returned by these endpoints
          priceChange24hPct: 0,
          sparkline: [],
          fundingHistory,
          source: "coinalyze",
          updatedAt: now,
        });
      }

      dataDrops.report(snapshots.length, pairs.length);
      const withLs = snapshots.filter((s) => s.longShortRatio !== null).length;
      log(
        "coinalyze",
        `RESULT ${snapshots.length} snapshots for ${asset} (${withLs} with long/short ratio)`
      );

      dataCache.set(asset, { snapshots, fetchedAt: now });
      return snapshots;
    } catch (err) {
      console.warn(`[coinalyze] fetch failed for ${asset}:`, err);
      // Stale data beats no data here: these are the only venues supplying
      // long/short ratios, and a few minutes of staleness is far less
      // misleading than the gauge silently emptying.
      if (cached) {
        log("coinalyze", `RESULT serving ${cached.snapshots.length} stale snapshots for ${asset}`);
        return cached.snapshots;
      }
      log("coinalyze", `RESULT 0 snapshots for ${asset} due to the error above`);
      return [];
    }
  },
};
