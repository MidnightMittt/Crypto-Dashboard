import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { MarketDataProvider, normalizeExchangeName } from "./types";
import { DropCounter, log, loggedFetch, loggedParse } from "./debug";

/**
 * DefiLlama — free, open, no API key required.
 * https://yields.llama.fi/perps returns funding rate and open interest for
 * perpetuals across both CEXs and DEXs in a single call.
 *
 * This is the zero-config path to Binance/Bybit/OKX data from regions where
 * those exchanges block direct API access.
 *
 * Per DefiLlama's FAQ, citing them as a source is appreciated — the UI does
 * so on any card sourced from here.
 */
const URL = "https://yields.llama.fi/perps";
const CACHE_MS = 30_000;

/**
 * Field names are tolerant on purpose: this endpoint's shape has shifted
 * historically and isn't formally documented, so several plausible spellings
 * are accepted rather than assuming one.
 */
interface LlamaPerp {
  marketplace?: string;
  exchange?: string;
  protocol?: string;
  market?: string;
  symbol?: string;
  baseAsset?: string;
  base?: string;
  fundingRate?: number;
  funding_rate?: number;
  openInterest?: number;
  open_interest?: number;
  openInterestUsd?: number;
  indexPrice?: number;
  index_price?: number;
  price?: number;
}

function firstNumber(...vals: Array<number | undefined>): number {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}

function firstString(...vals: Array<string | undefined>): string {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return "";
}

let cache: { rows: LlamaPerp[]; fetchedAt: number } | null = null;

async function getRows(): Promise<LlamaPerp[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) {
    log("defillama", `CACHE hit — ${cache.rows.length} rows`);
    return cache.rows;
  }

  const { res, text } = await loggedFetch("defillama", URL, {
    headers: { accept: "application/json" },
    next: { revalidate: 30 },
  } as RequestInit);

  if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);

  const json = loggedParse<unknown>("defillama", text);

  // Tolerate {status, data:[...]}, a bare array, or other wrappers.
  const obj = json as { data?: unknown; pools?: unknown } | null;
  let rows: LlamaPerp[] = [];
  let shape = "none";

  if (Array.isArray(json)) {
    rows = json as LlamaPerp[];
    shape = "bare array";
  } else if (Array.isArray(obj?.data)) {
    rows = obj!.data as LlamaPerp[];
    shape = "{ data: [...] }";
  } else if (Array.isArray(obj?.pools)) {
    rows = obj!.pools as LlamaPerp[];
    shape = "{ pools: [...] }";
  }

  log("defillama", `SHAPE detected="${shape}" rows=${rows.length}`);

  if (rows.length === 0) {
    log("defillama", "SHAPE no usable array found at any known key.");
    log(
      "defillama",
      `SHAPE top-level keys: ${json && typeof json === "object" ? Object.keys(json).join(", ") : String(json)}`
    );
  } else {
    log("defillama", `SAMPLE row keys: ${Object.keys(rows[0] ?? {}).join(", ")}`);
    log("defillama", `SAMPLE row: ${JSON.stringify(rows[0]).slice(0, 500)}`);
    const marketplaces = Array.from(
      new Set(rows.slice(0, 400).map((r) => firstString(r.marketplace, r.exchange, r.protocol)))
    ).filter(Boolean);
    log("defillama", `SAMPLE distinct venue labels (first 400 rows): ${marketplaces.slice(0, 40).join(" | ")}`);
    const assets = Array.from(
      new Set(rows.slice(0, 400).map((r) => firstString(r.baseAsset, r.base, r.symbol)))
    ).filter(Boolean);
    log("defillama", `SAMPLE distinct asset labels (first 400 rows): ${assets.slice(0, 40).join(" | ")}`);
  }

  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

/**
 * DefiLlama reports funding as a rate per its own settlement period, and
 * different venues settle at different intervals. It doesn't always tell us
 * which, so infer from the venue — the same assumption used elsewhere in the
 * app, and documented so it can be corrected per venue if needed.
 */
function intervalHoursFor(exchangeId: string): number {
  const hourly = new Set(["hyperliquid", "dydx", "kraken", "vertex", "aevo", "paradex", "lighter"]);
  return hourly.has(exchangeId) ? 1 : 8;
}

export const defillamaProvider: MarketDataProvider = {
  id: "defillama",
  name: "DefiLlama",
  isConfigured: () => true, // no key needed
  fetch: async (asset: AssetSymbol): Promise<ExchangeSnapshot[]> => {
    try {
      const rows = await getRows();
      const now = Date.now();
      const drops = new DropCounter("defillama");

      const matching = rows.filter((r) => {
        const label = firstString(r.baseAsset, r.base, r.symbol).toUpperCase();
        const hit = label.startsWith(asset);
        if (!hit) drops.drop(`asset label did not start with "${asset}"`, label || r);
        return hit;
      });

      log("defillama", `ASSET filter for ${asset}: ${matching.length} of ${rows.length} rows matched`);
      drops.report(matching.length, rows.length);

      const venueDrops = new DropCounter("defillama");
      const snapshots: ExchangeSnapshot[] = [];

      for (const r of matching) {
        const rawVenue = firstString(r.marketplace, r.exchange, r.protocol);
        const exchangeId = normalizeExchangeName(rawVenue);
        if (!exchangeId) {
          venueDrops.drop(`venue name "${rawVenue}" did not map to a known exchange id`, rawVenue);
          continue;
        }

        const price = firstNumber(r.indexPrice, r.index_price, r.price);
        const openInterest = firstNumber(r.openInterestUsd, r.openInterest, r.open_interest);
        if (!openInterest) {
          venueDrops.drop(`no open interest field found (venue ${exchangeId})`, r);
          continue;
        }
        log(
          "defillama",
          `MAP "${rawVenue}" -> ${exchangeId} | oi=${openInterest} price=${price} funding=${firstNumber(r.fundingRate, r.funding_rate)}`
        );

        const intervalHours = intervalHoursFor(exchangeId);

        // DefiLlama expresses funding as a decimal fraction (0.0001 = 0.01%).
        const fundingRatePct = firstNumber(r.fundingRate, r.funding_rate) * 100;

        snapshots.push({
          exchangeId,
          asset,
          fundingRatePct,
          fundingIntervalHours: intervalHours,
          nextFundingAt:
            Math.ceil(now / (intervalHours * 3_600_000)) * (intervalHours * 3_600_000),
          // DefiLlama's openInterest is already USD-denominated notional.
          openInterestUsd: openInterest,
          openInterestChange24hPct: null,
          volume24hUsd: 0, // not provided by this endpoint
          longShortRatio: null,
          price,
          priceChange24hPct: 0, // not provided by this endpoint
          sparkline: [],
          fundingHistory: [],
          source: "defillama",
          updatedAt: now,
        });
      }

      venueDrops.report(snapshots.length, matching.length);
      log("defillama", `RESULT ${snapshots.length} snapshots for ${asset}`);
      return snapshots;
    } catch (err) {
      console.warn("[defillama] fetch failed:", err);
      return [];
    }
  },
};
