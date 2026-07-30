import { AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { MarketDataProvider, normalizeExchangeName } from "./types";
import { DropCounter, log, loggedFetch, loggedParse } from "./debug";
import { swr } from "../cache/swr";

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

/**
 * Endpoints queried per symbol. This number IS the cost multiplier, and
 * getting it wrong silently disables the provider.
 *
 * IT WAS WRONG. With 4 endpoints and a 20-symbol cap the cost was 80 against
 * a 34/minute budget, so `spendBudget` refused every batch — for every asset,
 * on every poll, permanently. The provider returned an empty array and looked
 * for all the world like a bad API key. Nothing was ever fetched.
 *
 * `/open-interest-history` was dropped to bring this to 3. It was the least
 * valuable of the four: OKX's rubik endpoint already supplies open-interest
 * history for the percentile gauge, whereas the long/short ratio here is
 * genuinely unavailable elsewhere once Binance and Bybit are geoblocked.
 */
const ENDPOINTS_PER_SYMBOL = 3;

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
    cache: "no-store",
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

  /*
   * Order by what this provider uniquely adds. Funding and open interest now
   * come first-hand from 20 direct adapters, so a Coinalyze row for a venue
   * we already cover contributes only its long/short ratio — and only some
   * venues publish one. When the budget can't cover every symbol, those are
   * the ones worth spending it on.
   */
  const ranked = [...byExchange.entries()].sort(([, a], [, b]) => {
    const aLs = a.has_long_short_ratio_data ? 1 : 0;
    const bLs = b.has_long_short_ratio_data ? 1 : 0;
    return bLs - aLs;
  });

  const selected = ranked.slice(0, MAX_SYMBOLS_PER_CALL);
  drops.report(selected.length, candidates.length);
  log(
    "coinalyze",
    `SYMBOLS selected for ${asset}: ${selected.map(([id, m]) => `${id}:${m.symbol}`).join(", ") || "(none)"}`
  );
  return selected;
}

export const coinalyzeProvider: MarketDataProvider = {
  id: "coinalyze",
  name: "Coinalyze",
  isConfigured: () => Boolean(apiKey()),
  /**
   * Results are cached through the SHARED swr layer, not a local Map.
   *
   * This provider is rate-limited to 40 calls/minute and a single asset's
   * batch costs 33 of them, so at most one fetch per minute can succeed. With
   * a per-instance cache and per-instance rate window, most serverless
   * instances found the budget spent and returned nothing — and because the
   * aggregate is itself shared, that empty result was published to every
   * instance, overwriting a good one. Binance's long/short ratio was being
   * fetched correctly and then thrown away.
   *
   * Going through swr means one instance pays for the batch and every
   * instance uses it for the full cache window. `fetchFromApi` THROWS rather
   * than returning empty when the budget is exhausted, so swr serves the
   * previous good value instead of caching a blank.
   */
  fetch: async (asset: AssetSymbol): Promise<ExchangeSnapshot[]> => {
    if (!apiKey()) {
      log("coinalyze", "SKIP provider not configured — COINALYZE_API_KEY is empty/unset");
      return [];
    }
    try {
      return await swr(`coinalyze:${asset}`, () => fetchFromApi(asset), {
        freshMs: DATA_CACHE_MS,
        // Well beyond fresh: stale long/short data is far better than none,
        // and none is what a blocked budget would otherwise produce.
        maxAgeMs: 15 * 60_000,
      });
    } catch (err) {
      console.warn(`[coinalyze] no data for ${asset}:`, err);
      return [];
    }
  },
};

/**
 * One real batch against the API. Throws on any failure, including an
 * exhausted budget, so the caller's swr layer keeps the previous good value
 * rather than caching an empty result.
 */
async function fetchFromApi(asset: AssetSymbol): Promise<ExchangeSnapshot[]> {
  const pairs = await symbolsFor(asset);
  if (pairs.length === 0) {
    log("coinalyze", `RESULT no symbols resolved for ${asset}`);
    return [];
  }

  /*
   * Trim the batch to what the budget can actually cover, rather than
   * demanding all of it and giving up.
   *
   * The previous all-or-nothing check is what made this provider inert:
   * a full batch cost more than a minute's entire allowance, so it was
   * refused every time and no data was ever fetched. Taking as many
   * symbols as we can afford means the highest-value venues (ranked
   * above) come back on every cycle, and the rest arrive as budget frees
   * up.
   */
  const affordable = Math.floor(budgetRemaining() / ENDPOINTS_PER_SYMBOL);
  if (affordable < 1) {
    // Thrown, not returned empty: swr treats a rejection as "keep the
    // previous value", which is the whole point. Returning [] here would
    // cache a blank and wipe out good data for every instance.
    throw new Error(
      `Coinalyze budget exhausted (${budgetRemaining()} calls left this minute)`
    );
  }

  const batch = pairs.slice(0, affordable);
  const cost = batch.length * ENDPOINTS_PER_SYMBOL;
  spendBudget(cost);
  log(
    "coinalyze",
    `BUDGET spending ${cost} calls for ${asset} (${batch.length} of ${pairs.length} symbols), ` +
      `${budgetRemaining()} remain`
  );

  const symbols = batch.map(([, m]) => m.symbol).join(",");
  const nowSec = Math.floor(Date.now() / 1000);

  const [funding, oi, lsHist] = await Promise.all([
    call<ValueRow[]>("/funding-rate", { symbols }),
    call<ValueRow[]>("/open-interest", { symbols, convert_to_usd: "true" }),
    call<HistoryRow[]>("/long-short-ratio-history", {
      symbols,
      interval: "1hour",
      from: String(nowSec - 6 * 3600),
      to: String(nowSec),
    }).catch(() => [] as HistoryRow[]),
  ]);

  log(
    "coinalyze",
    `DATA funding=${funding.length} oi=${oi.length} lsHist=${lsHist.length} (requested ${batch.length} symbols)`
  );

  const fundingBySymbol = new Map(funding.map((r) => [r.symbol, r.value]));
  const oiBySymbol = new Map(oi.map((r) => [r.symbol, r.value]));
  const lsBySymbol = new Map(lsHist.map((r) => [r.symbol, r.history]));

  const now = Date.now();
  const snapshots: ExchangeSnapshot[] = [];

  const dataDrops = new DropCounter("coinalyze");
  for (const [exchangeId, market] of batch) {
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

    // No OI history from this provider — /open-interest-history was
    // dropped to fit the rate budget. OKX supplies the series the
    // percentile gauge needs, and venueStore backfills the 24h delta.
    const fundingHistory: FundingPoint[] = [];
    const openInterestChange24hPct: number | null = null;

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

  dataDrops.report(snapshots.length, batch.length);
  const withLs = snapshots.filter((s) => s.longShortRatio !== null).length;
  log(
    "coinalyze",
    `RESULT ${snapshots.length} snapshots for ${asset} (${withLs} with long/short ratio)`
  );

  // Serving stale on failure is swr's job now, so errors propagate.
  return snapshots;
}

/** One venue's raw liquidation series, already unit-converted to USD. */
export interface VenueLiquidations {
  venueId: string;
  points: Array<{ t: number; longUsd: number; shortUsd: number }>;
}

interface LiquidationHistoryRow {
  symbol: string;
  history: Array<{ t: number; l?: number; s?: number }>;
}

/**
 * Liquidations are billed and budgeted SEPARATELY from the funding/OI/L-S
 * batch above, on purpose.
 *
 * Folding this into `fetchFromApi` as a 4th endpoint would repeat exactly the
 * bug documented on ENDPOINTS_PER_SYMBOL above: it would shrink that batch's
 * affordable symbol count from 11 to 8, quietly losing long/short coverage on
 * venues nobody asked to trade off. Keeping it a separate consumer of the
 * SAME shared token bucket (`spendBudget`/`budgetRemaining`, still one 34/min
 * ceiling per process) means neither feature can starve the other's existing
 * behavior — each independently degrades to fewer symbols under contention,
 * which is the same graceful-degradation contract `fetchFromApi` already has.
 *
 * Fewer symbols on purpose (see MAX_LIQUIDATION_SYMBOLS below): liquidation
 * volume concentrates on the venues with the deepest books, so there is much
 * less value in reaching for the 11th-ranked venue here than there is for
 * long/short ratio, where every additional venue is a genuinely independent
 * reading.
 */
const LIQUIDATION_CACHE_MS = 5 * 60_000; // 5min fresh
const LIQUIDATION_MAX_AGE_MS = 30 * 60_000; // 30min stale-tolerance
const MAX_LIQUIDATION_SYMBOLS = 8;
const LIQUIDATION_WINDOW_HOURS = 24;

export const liquidationsConfigured = (): boolean => Boolean(apiKey());

/**
 * Raw per-venue liquidation series for one asset over the trailing 24h,
 * hourly buckets, USD notional. Aggregation across venues into totals and a
 * dominant-side read happens in sentiment/liquidations.ts — this function's
 * job stops at "fetch and unit-convert", matching how the rest of this file
 * separates API-shape concerns from derived math.
 */
export async function fetchCoinalyzeLiquidations(
  asset: AssetSymbol
): Promise<VenueLiquidations[]> {
  if (!apiKey()) return [];
  try {
    return await swr(`coinalyze-liq:${asset}`, () => fetchLiquidationsFromApi(asset), {
      freshMs: LIQUIDATION_CACHE_MS,
      maxAgeMs: LIQUIDATION_MAX_AGE_MS,
    });
  } catch (err) {
    console.warn(`[coinalyze] no liquidation data for ${asset}:`, err);
    return [];
  }
}

async function fetchLiquidationsFromApi(asset: AssetSymbol): Promise<VenueLiquidations[]> {
  const pairs = (await symbolsFor(asset)).slice(0, MAX_LIQUIDATION_SYMBOLS);
  if (pairs.length === 0) {
    log("coinalyze", `LIQ no symbols resolved for ${asset}`);
    return [];
  }

  // 1 call per symbol for this endpoint (no per-symbol multiplier — it's a
  // single endpoint, not the 3-endpoint batch above).
  const affordable = Math.min(pairs.length, budgetRemaining());
  if (affordable < 1) {
    // Thrown, not returned empty — same reasoning as fetchFromApi: swr must
    // see a rejection to know to keep serving the last good value, or an
    // exhausted budget would cache a blank and erase good data.
    throw new Error(`Coinalyze liquidation budget exhausted (${budgetRemaining()} calls left)`);
  }

  const batch = pairs.slice(0, affordable);
  spendBudget(batch.length);
  log(
    "coinalyze",
    `LIQ spending ${batch.length} calls for ${asset} (of ${pairs.length} candidates), ` +
      `${budgetRemaining()} remain`
  );

  const symbols = batch.map(([, m]) => m.symbol).join(",");
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - LIQUIDATION_WINDOW_HOURS * 3600;

  const rows = await call<LiquidationHistoryRow[]>("/liquidation-history", {
    symbols,
    interval: "1hour",
    from: String(fromSec),
    to: String(nowSec),
    convert_to_usd: "true",
  });

  const bySymbol = new Map(rows.map((r) => [r.symbol, r.history]));

  const result: VenueLiquidations[] = [];
  for (const [venueId, market] of batch) {
    const history = bySymbol.get(market.symbol);
    if (!history || history.length === 0) continue;
    result.push({
      venueId,
      points: history.map((h) => ({
        t: h.t * 1000,
        longUsd: h.l ?? 0,
        shortUsd: h.s ?? 0,
      })),
    });
  }

  log(
    "coinalyze",
    `LIQ result ${result.length} venues with data for ${asset} (requested ${batch.length})`
  );
  return result;
}

/**
 * Step-by-step report of what this provider actually does for one asset.
 *
 * Written because the failure modes are invisible from the aggregate payload
 * and from the HTTP status alone. A valid key returning no venues could mean
 * the markets list is empty, no perpetual matched the asset, every venue name
 * failed to map to a registry id, the budget was exhausted, or the rows came
 * back without the fields we require. Each of those needs a different fix and
 * they all look identical from outside.
 *
 * Reports counts and unmapped venue NAMES only. No key material.
 */
export async function coinalyzeDiagnostics(asset: AssetSymbol): Promise<Record<string, unknown>> {
  if (!apiKey()) return { configured: false };

  try {
    const { markets, exchanges } = await getMarkets();

    const candidates = markets.filter(
      (m) =>
        m.base_asset.toUpperCase() === asset &&
        ["USDT", "USD", "USDC"].includes(m.quote_asset.toUpperCase())
    );

    // Which venue labels map to a registry id, and which don't.
    const mapped: string[] = [];
    const unmapped: string[] = [];
    for (const m of candidates) {
      const name = exchanges.get(m.exchange) ?? m.exchange;
      const id = normalizeExchangeName(name);
      if (id) mapped.push(id);
      else unmapped.push(name);
    }

    const snapshots = await coinalyzeProvider.fetch(asset);

    return {
      configured: true,
      perpetualMarkets: markets.length,
      exchangesInDirectory: exchanges.size,
      candidatesForAsset: candidates.length,
      mappedVenues: Array.from(new Set(mapped)),
      unmappedVenueNames: Array.from(new Set(unmapped)),
      budgetRemaining: budgetRemaining(),
      snapshotsReturned: snapshots.length,
      snapshotsWithLongShort: snapshots.filter((x) => x.longShortRatio !== null).length,
      sample: snapshots.slice(0, 3).map((x) => ({
        venue: x.exchangeId,
        oiUsd: Math.round(x.openInterestUsd),
        fundingPct: x.fundingRatePct,
        longShortRatio: x.longShortRatio,
      })),
    };
  } catch (err) {
    return { configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}
