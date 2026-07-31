import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * DefiLlama stablecoins — https://stablecoins.llama.fi/stablecoins
 *
 * A completely separate, still-free endpoint from providers/defillama.ts
 * (yields.llama.fi/perps, which is now paywalled and self-disabled). Do not
 * confuse the two — this one has no key requirement and no circuit breaker
 * because it hasn't needed one.
 *
 * Net stablecoin minting is a classic risk-on precursor (capital entering
 * crypto, sitting as dry powder before it buys something); net burning
 * signals capital leaving crypto entirely, a genuinely different signal
 * from any single asset's price action. This is market-wide, not
 * per-asset — it doesn't belong on any one asset's card.
 *
 * Per DefiLlama's FAQ, citing them as a source is appreciated — the UI does
 * so on the card sourced from here.
 */
const URL = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
const CACHE_MS = 10 * 60_000; // stablecoin supply moves slowly; no need to poll hard

export interface StablecoinSummary {
  totalMcapUsd: number;
  netChange24hUsd: number;
  netChange24hPct: number;
  netChange7dUsd: number;
  netChange7dPct: number;
  /** Largest few by market cap, for dominance context. */
  topIssuers: Array<{ symbol: string; name: string; mcapUsd: number; dominancePct: number }>;
  updatedAt: number;
}

interface LlamaPeggedAsset {
  symbol?: string;
  name?: string;
  pegType?: string;
  circulating?: { peggedUSD?: number };
  circulatingPrevDay?: { peggedUSD?: number };
  circulatingPrevWeek?: { peggedUSD?: number };
}

interface LlamaStablecoinsResponse {
  peggedAssets?: LlamaPeggedAsset[];
}

let cache: { summary: StablecoinSummary | null; fetchedAt: number } | null = null;

export async function fetchStablecoinSummary(): Promise<StablecoinSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.summary;

  try {
    const res = await fetch(URL, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`DefiLlama stablecoins HTTP ${res.status}`);

    const json = (await res.json()) as LlamaStablecoinsResponse;
    // USD-pegged only — non-USD pegged assets (peggedEUR etc.) are a much
    // smaller, less relevant slice for a "risk-on dry powder" reading and
    // mixing currencies into one dollar total would be wrong anyway.
    const assets = (json.peggedAssets ?? []).filter((a) => a.pegType === "peggedUSD");

    let totalMcapUsd = 0;
    let totalPrevDay = 0;
    let totalPrevWeek = 0;
    const withMcap: Array<{ symbol: string; name: string; mcapUsd: number }> = [];

    for (const a of assets) {
      const mcap = a.circulating?.peggedUSD;
      if (!mcap || mcap <= 0) continue;
      totalMcapUsd += mcap;
      totalPrevDay += a.circulatingPrevDay?.peggedUSD ?? mcap;
      totalPrevWeek += a.circulatingPrevWeek?.peggedUSD ?? mcap;
      withMcap.push({ symbol: a.symbol ?? "?", name: a.name ?? "?", mcapUsd: mcap });
    }

    if (totalMcapUsd <= 0) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    const topIssuers = withMcap
      .sort((a, b) => b.mcapUsd - a.mcapUsd)
      .slice(0, 5)
      .map((a) => ({ ...a, dominancePct: (a.mcapUsd / totalMcapUsd) * 100 }));

    const netChange24hUsd = totalMcapUsd - totalPrevDay;
    const netChange7dUsd = totalMcapUsd - totalPrevWeek;

    const summary: StablecoinSummary = {
      totalMcapUsd,
      netChange24hUsd,
      netChange24hPct: totalPrevDay > 0 ? (netChange24hUsd / totalPrevDay) * 100 : 0,
      netChange7dUsd,
      netChange7dPct: totalPrevWeek > 0 ? (netChange7dUsd / totalPrevWeek) * 100 : 0,
      topIssuers,
      updatedAt: Date.now(),
    };

    cache = { summary, fetchedAt: Date.now() };
    return summary;
  } catch (err) {
    console.warn("[stablecoins] fetch failed:", err);
    return null;
  }
}
