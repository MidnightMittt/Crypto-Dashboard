import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { safeNumber } from "./types";

/**
 * Jupiter Perps — direct adapter.
 *
 * STATUS: disabled by default, and deliberately so.
 *
 * History of this file, so the next person doesn't repeat it:
 *   - It originally targeted `lite-api.jup.ag/perps/v1/markets`.
 *     That host was DEPRECATED on 31 January 2026 and now returns
 *     "route not found". The current base is `api.jup.ag`.
 *   - Jupiter's integration guidance notes that an x-api-key is required
 *     for REST endpoints "not on-chain-only flows like Perps/Lock", which
 *     suggests Perps market-wide stats may have no public REST surface at
 *     all. The documented Perps endpoints are position/wallet oriented.
 *
 * So rather than ship another guess, this adapter stays inert unless you
 * explicitly point it at a working endpoint:
 *
 *   JUPITER_PERPS_URL=https://api.jup.ag/<real-path>
 *   JUPITER_API_KEY=<key from portal.jup.ag>
 *
 * Jupiter still appears on the dashboard — DefiLlama and CoinGecko both
 * carry it as a venue, so it's covered by the provider layer. This adapter
 * only exists to upgrade that to first-hand data if a suitable endpoint
 * turns out to exist.
 *
 * NOTE: Jupiter's *Price* API is separate and does work — see
 * providers/jupiterPrice.ts, which is live and feeds the basis calculation.
 */

const CACHE_MS = 15_000;

function endpoint(): string | null {
  return process.env.JUPITER_PERPS_URL?.trim() || null;
}

export function jupiterPerpsConfigured(): boolean {
  return endpoint() !== null;
}

interface MarketLike {
  [key: string]: unknown;
}

let cache: { rows: MarketLike[]; fetchedAt: number } | null = null;

async function getMarkets(): Promise<MarketLike[]> {
  const url = endpoint();
  if (!url) return [];
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;

  const apiKey = process.env.JUPITER_API_KEY?.trim();
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    next: { revalidate: 15 },
  });
  if (!res.ok) throw new Error(`Jupiter Perps HTTP ${res.status}`);

  const json = await res.json();
  const rows: MarketLike[] = Array.isArray(json)
    ? json
    : Array.isArray(json?.dataList)
      ? json.dataList
      : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.markets)
          ? json.markets
          : [];

  if (rows.length === 0) {
    console.warn("[jupiter-perps] no rows parsed; response keys:", Object.keys(json ?? {}));
  } else {
    console.info("[jupiter-perps] sample keys:", Object.keys(rows[0]).join(", "));
  }

  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

function pick(row: MarketLike, keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
}

export async function fetchJupiter(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  // Jupiter Perps lists only SOL, ETH, and BTC against the JLP pool.
  if (!["SOL", "ETH", "BTC"].includes(asset)) return null;
  if (!jupiterPerpsConfigured()) return null;

  try {
    const rows = await getMarkets();
    const row = rows.find((r) => {
      const sym = String(
        pick(r, ["symbol", "market", "name", "baseAsset", "base_asset", "ticker"]) ?? ""
      ).toUpperCase();
      return sym.startsWith(asset) || sym.includes(`${asset}-`) || sym.includes(`${asset}_`);
    });
    if (!row) return null;

    const price = safeNumber(pick(row, ["markPrice", "mark_price", "price", "oraclePrice"]));
    const openInterestUsd = safeNumber(
      pick(row, ["openInterestUsd", "open_interest_usd", "openInterest", "open_interest"])
    );
    if (!price || !openInterestUsd) return null;

    const fundingRaw = safeNumber(
      pick(row, ["fundingRate", "funding_rate", "borrowRate", "borrow_rate", "hourlyFundingRate"])
    );

    const now = Date.now();
    return {
      exchangeId: "jupiter",
      asset,
      fundingRatePct: fundingRaw * 100,
      fundingIntervalHours: 1,
      nextFundingAt: Math.ceil(now / 3_600_000) * 3_600_000,
      openInterestUsd,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(pick(row, ["volume24h", "volume_24h", "dayVolume"])),
      longShortRatio: null,
      price,
      priceChange24hPct: safeNumber(pick(row, ["priceChange24h", "price_change_24h"])),
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[jupiter-perps] fetch failed for ${asset}:`, err);
    return null;
  }
}
