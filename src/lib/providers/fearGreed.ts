/**
 * Crypto Fear & Greed Index — alternative.me, free, no API key.
 * https://api.alternative.me/fng/
 *
 * This is a MARKET-WIDE sentiment reading built mostly from spot-market
 * inputs: volatility, volume, social, dominance, trends. It is deliberately
 * kept separate from this dashboard's own composite index, which measures
 * something different — leverage and positioning in perpetual futures.
 *
 * Showing both side by side is the useful part. When they diverge — say,
 * broad sentiment is fearful while leverage positioning is crowded long —
 * that gap is itself informative.
 */
const URL = "https://api.alternative.me/fng/?limit=1";
const CACHE_MS = 10 * 60 * 1000; // updates once daily; no need to poll hard

export interface FearGreedReading {
  value: number; // 0-100
  classification: string; // e.g. "Fear", "Greed"
  updatedAt: number;
}

interface FngResponse {
  data?: Array<{
    value?: string;
    value_classification?: string;
    timestamp?: string;
  }>;
}

let cache: { reading: FearGreedReading | null; fetchedAt: number } | null = null;

export async function fetchFearGreed(): Promise<FearGreedReading | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.reading;

  try {
    const res = await fetch(URL, {
      headers: { accept: "application/json" },
      next: { revalidate: 600 },
    });
    if (!res.ok) throw new Error(`Fear & Greed HTTP ${res.status}`);

    const json = (await res.json()) as FngResponse;
    const row = json.data?.[0];
    if (!row?.value) {
      cache = { reading: null, fetchedAt: Date.now() };
      return null;
    }

    const value = parseInt(row.value, 10);
    const reading: FearGreedReading = {
      value: Number.isFinite(value) ? value : 50,
      classification: row.value_classification ?? "Unknown",
      updatedAt: row.timestamp ? parseInt(row.timestamp, 10) * 1000 : Date.now(),
    };

    cache = { reading, fetchedAt: Date.now() };
    return reading;
  } catch (err) {
    console.warn("[fear-greed] fetch failed:", err);
    cache = { reading: null, fetchedAt: Date.now() };
    return null;
  }
}
