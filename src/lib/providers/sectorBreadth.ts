import { swr } from "../cache/swr";
import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * CoinGecko sector/category breadth — is a rally broad-based (most major
 * sectors participating) or narrow (concentrated in one or two)? Feeds
 * `evaluateSectorBreadth` in signals/evaluators.ts, which surfaces
 * automatically in AiMarketSummary's narrative — no new card, per the
 * user's explicit "strengthen existing sections, don't create new ones"
 * brief.
 *
 * A curated basket of 8 categories, not all ~750 CoinGecko tracks — this
 * app's existing "quality over quantity" signal philosophy (CLAUDE.md):
 * a fixed, meaningful basket avoids both noise from thin/illiquid
 * micro-categories (hundreds of near-empty "X Meme" categories exist) and
 * a number that silently shifts meaning as CoinGecko's taxonomy grows.
 *
 * `market_cap_change_24h` on this endpoint is ALREADY a percentage (not an
 * absolute USD delta) — confirmed via a direct request before writing
 * this file (a Smart Contract Platform category with a ~$1.86T market cap
 * reported market_cap_change_24h: 0.946, which is only sane as a %).
 *
 * Historical category data (`/global/market_cap_chart`) is PAID-TIER
 * GATED on CoinGecko's demo API — confirmed via a live request that
 * returned error_code 10005. No backtest source exists for this signal;
 * see hypothesis.ts's `hasHistoricalSource: false` for it, disclosed
 * honestly, same pattern as orderFlow/exchangeFlow.
 */
const CATEGORIES_URL = "https://api.coingecko.com/api/v3/coins/categories";
const CACHE_MS = 15 * 60_000; // sector composition shifts slowly; no value polling hard
const MAX_AGE_MS = 60 * 60_000;

/** CoinGecko's exact category names for the tracked basket. */
const TRACKED_CATEGORY_NAMES = [
  "Layer 1 (L1)",
  "Smart Contract Platform",
  "Decentralized Finance (DeFi)",
  "Artificial Intelligence (AI)",
  "Meme",
  "Layer 2 (L2)",
  "Gaming (GameFi)",
  "Real World Assets (RWA)",
];

export interface SectorReading {
  name: string;
  mcapChange24hPct: number;
}

export interface SectorBreadthSummary {
  sectors: SectorReading[];
  /** % of tracked sectors with positive 24h market-cap change, 0-100. */
  breadthPct: number;
  updatedAt: number;
}

function demoKeyHeader(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

interface GeckoCategoryRow {
  name?: string;
  market_cap_change_24h?: number | null;
}

/** % of sectors with a positive 24h market-cap change, 0-100. Pure — hand-verified in sectorBreadth.test.ts. Empty input has nothing to report, not a fabricated 0 or 50. */
export function computeBreadthPct(sectors: SectorReading[]): number | null {
  if (sectors.length === 0) return null;
  const positive = sectors.filter((s) => s.mcapChange24hPct > 0).length;
  return (positive / sectors.length) * 100;
}

async function fetchFromApi(): Promise<SectorBreadthSummary | null> {
  const res = await fetch(CATEGORIES_URL, {
    headers: { accept: "application/json", ...demoKeyHeader() },
    signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`CoinGecko /coins/categories HTTP ${res.status}`);

  const rows = (await res.json()) as GeckoCategoryRow[];
  const byName = new Map(rows.filter((r) => r.name).map((r) => [r.name as string, r]));

  const sectors: SectorReading[] = [];
  for (const name of TRACKED_CATEGORY_NAMES) {
    const row = byName.get(name);
    if (!row || typeof row.market_cap_change_24h !== "number") continue;
    sectors.push({ name, mcapChange24hPct: row.market_cap_change_24h });
  }

  const breadthPct = computeBreadthPct(sectors);
  if (breadthPct === null) return null;

  return { sectors, breadthPct, updatedAt: Date.now() };
}

export async function fetchSectorBreadth(): Promise<SectorBreadthSummary | null> {
  try {
    return await swr("sector-breadth", fetchFromApi, { freshMs: CACHE_MS, maxAgeMs: MAX_AGE_MS });
  } catch (err) {
    console.warn("[sector-breadth] fetch failed:", err);
    return null;
  }
}
