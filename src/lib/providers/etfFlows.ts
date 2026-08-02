import { AssetSymbol, EtfFlowSummary } from "@/types/market";
import { timeoutSignal } from "../net/timeout";
import { swr } from "../cache/swr";

/**
 * US spot ETF net flows, from SoSoValue's open API.
 *
 * Keyless and free — verified by direct request, not documentation. Returns
 * 300 daily points back to 2025-05-21 for both the BTC and ETH spot
 * complexes, which is enough depth to judge whether a day's flow is large
 * relative to its own recent history rather than against a made-up
 * threshold.
 *
 * WHY THIS MATTERS relative to everything else on the dashboard: every other
 * flow signal here measures crypto-native positioning. ETF flows are the one
 * read on money arriving from traditional finance, and it settles daily on a
 * business-day calendar — so a "zero flow" weekend is a market being closed,
 * not an absence of demand. `isStale` below exists so the UI can say that
 * instead of misreading it.
 */

const BASE = "https://api.sosovalue.xyz/openapi/v2/etf";
const FRESH_MS = 30 * 60 * 1000; // settles once a day; no value in polling hard
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TREND_DAYS = 5;
/** Business days after which the latest print is stale rather than merely weekend-old. */
const STALE_AFTER_DAYS = 4;

interface InflowRow {
  date: string;
  totalNetInflow: number;
  totalNetAssets: number;
}

function typeFor(asset: AssetSymbol): string | null {
  if (asset === "BTC") return "us-btc-spot";
  if (asset === "ETH") return "us-eth-spot";
  return null; // no US spot ETF complex exists for the other assets
}

async function fetchFromApi(asset: AssetSymbol): Promise<EtfFlowSummary | null> {
  const type = typeFor(asset);
  if (!type) return null;

  try {
    const res = await fetch(`${BASE}/historicalInflowChart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
      signal: timeoutSignal(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`SoSoValue HTTP ${res.status}`);

    const json = (await res.json()) as { code: number; data: InflowRow[] | null };
    const rows = json.data;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    // Newest-first from the API; sorted defensively rather than assumed.
    const sorted = [...rows]
      .filter((r) => r && typeof r.totalNetInflow === "number" && r.date)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (sorted.length === 0) return null;

    const latest = sorted[0];
    const window = sorted.slice(0, TREND_DAYS);
    const netFlow5dUsd = window.reduce((s, r) => s + r.totalNetInflow, 0);

    /*
     * Magnitude is judged against this series' OWN recent history, not a
     * fixed dollar threshold — $200M is a routine day for the BTC complex
     * and an enormous one for ETH, so a shared constant would misread one
     * of them permanently.
     */
    const recent = sorted.slice(0, 60).map((r) => Math.abs(r.totalNetInflow));
    const typicalAbsFlow = recent.length
      ? recent.reduce((s, v) => s + v, 0) / recent.length
      : 0;

    const ageDays = Math.floor((Date.now() - Date.parse(`${latest.date}T00:00:00Z`)) / 86_400_000);

    return {
      asset,
      latestDate: latest.date,
      netFlowUsd: latest.totalNetInflow,
      netFlow5dUsd,
      totalNetAssetsUsd: latest.totalNetAssets,
      typicalAbsFlowUsd: typicalAbsFlow,
      isStale: ageDays > STALE_AFTER_DAYS,
      ageDays,
    };
  } catch (err) {
    console.warn(`[etf-flows] fetch failed for ${asset}:`, err);
    return null;
  }
}

export async function fetchEtfFlows(asset: AssetSymbol): Promise<EtfFlowSummary | null> {
  if (!typeFor(asset)) return null;
  try {
    return await swr(`etf-flows:${asset}`, () => fetchFromApi(asset), {
      freshMs: FRESH_MS,
      maxAgeMs: MAX_AGE_MS,
      shouldShare: (next, previous) => next !== null || !previous,
    });
  } catch {
    return null;
  }
}
