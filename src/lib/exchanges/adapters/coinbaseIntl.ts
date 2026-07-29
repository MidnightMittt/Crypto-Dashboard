import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Coinbase International Exchange — direct adapter.
 *
 * Docs: https://docs.cdp.coinbase.com/intx/docs/welcome
 *
 * No API key required. Coinbase's *private* endpoints (orders, positions)
 * need CDP credentials, but market data is fully public — which is why this
 * adapter takes no key even though one exists for the trading API.
 *
 * WHY THIS VENUE IS CHEAP TO POLL: `/instruments` returns every listed perp
 * — 260+ of them — with open interest, funding interval, 24h notional, and
 * a live `quote` object inlined on each row. One HTTP request therefore
 * covers all ten of our assets. Most venues need a call per symbol, so
 * Coinbase is close to free in latency terms; the result is cached
 * module-wide and shared across every asset in a polling cycle.
 *
 * NOT to be confused with Coinbase Advanced Trade (spot, US-facing) or the
 * old Coinbase Pro API. This is the offshore derivatives venue, and it's
 * the only Coinbase entity that lists perpetual futures.
 */
const BASE = "https://api.international.coinbase.com/api/v1";

/** Shorter than the poll interval so a cycle never serves the prior cycle's data. */
const CACHE_MS = 10_000;

interface IntxQuote {
  best_bid_price?: string;
  best_ask_price?: string;
  trade_price?: string;
  index_price?: string;
  mark_price?: string;
  /** Previous daily settlement — our only 24h price reference. */
  settlement_price?: string;
  predicted_funding?: string;
  timestamp?: string;
}

interface IntxInstrument {
  symbol: string;
  type: string;
  base_asset_name: string;
  quote_asset_name: string;
  trading_state: string;
  /** In BASE units, not USD — must be multiplied by mark price. */
  open_interest?: string;
  /** Nanoseconds between funding payments. 3600000000000 = 1 hour. */
  funding_interval?: string;
  notional_24hr?: string;
  quote?: IntxQuote;
}

let cache: { rows: IntxInstrument[]; fetchedAt: number } | null = null;
let inflight: Promise<IntxInstrument[]> | null = null;

/**
 * One request serves every asset in a polling cycle. Concurrent callers
 * share the in-flight promise rather than each firing their own request —
 * without this, ten assets would mean ten identical fetches.
 */
async function getInstruments(): Promise<IntxInstrument[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;
  if (inflight) return inflight;

  inflight = fetchJson<IntxInstrument[]>(`${BASE}/instruments`)
    .then((rows) => {
      const perps = rows.filter((r) => r.type === "PERP");
      cache = { rows: perps, fetchedAt: Date.now() };
      return perps;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Coinbase reports `funding_interval` in nanoseconds. Everything downstream
 * expects hours, and cross-venue funding comparisons are wrong if this is
 * misread — an hourly rate looks 8x smaller than an 8-hourly one for
 * identical economics.
 */
function intervalHours(raw: string | undefined): number {
  const ns = safeNumber(raw);
  if (!ns) return 1; // Coinbase perps fund hourly; safe default if absent.
  const hours = ns / 1e9 / 3600;
  return Number.isFinite(hours) && hours > 0 ? hours : 1;
}

export async function fetchCoinbaseIntl(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const rows = await getInstruments();
    const row = rows.find(
      (r) => r.base_asset_name?.toUpperCase() === asset && r.symbol?.endsWith("-PERP")
    );
    if (!row) return null;

    // Halted or delisted markets publish stale quotes — treat as unavailable
    // rather than reporting a price that isn't tradeable.
    if (row.trading_state && row.trading_state !== "TRADING") return null;

    const q = row.quote ?? {};
    const price = safeNumber(q.mark_price) || safeNumber(q.trade_price);
    if (!price) return null;

    // open_interest is denominated in the base asset (e.g. 2141.29 BTC).
    const openInterestBase = safeNumber(row.open_interest);
    const openInterestUsd = openInterestBase * price;

    // `predicted_funding` is a decimal fraction (0.000004 = 0.0004%), the
    // same convention as most exchange APIs and unlike Coinalyze, which
    // returns a percentage already. Getting this wrong inflates the venue
    // 100x — see the outlier check in aggregator.ts.
    const fundingRatePct = safeNumber(q.predicted_funding) * 100;

    // Coinbase publishes no 24h price-change field. `settlement_price` is
    // the previous daily settlement, which is the closest genuine reference
    // available — a real published number, not a reconstruction.
    const settlement = safeNumber(q.settlement_price);
    const priceChange24hPct = settlement > 0 ? ((price - settlement) / settlement) * 100 : 0;

    const hours = intervalHours(row.funding_interval);
    const now = Date.now();

    return {
      exchangeId: "coinbase-intl",
      asset,
      fundingRatePct,
      fundingIntervalHours: hours,
      nextFundingAt: Math.ceil(now / (hours * 3_600_000)) * (hours * 3_600_000),
      openInterestUsd,
      // No OI history endpoint on this venue — the local recorder in
      // history/venueStore.ts backfills this once it has enough samples.
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(row.notional_24hr),
      // Coinbase publishes no positioning data.
      longShortRatio: null,
      price,
      priceChange24hPct,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[coinbase-intl] fetch failed for ${asset}:`, err);
    return null;
  }
}
