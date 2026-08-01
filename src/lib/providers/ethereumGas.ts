import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * Ethereum gas oracle — Etherscan, reuses the same ETHERSCAN_API_KEY
 * already configured for Exchange Flow's ETH balance lookups. Works without
 * a key too (rate-limited to roughly 1 call per 5 seconds instead of the
 * standard 5/sec), so this degrades rather than going dark if the key
 * isn't set.
 *
 * Informational, not a sentiment signal — gas price isn't bullish or
 * bearish, it's network congestion.
 */
const BASE = "https://api.etherscan.io/v2/api";
const CACHE_MS = 60_000;

export interface EthereumGasSummary {
  safeGwei: number;
  proposeGwei: number;
  fastGwei: number;
  updatedAt: number;
}

interface GasOracleResponse {
  status?: string;
  result?: {
    SafeGasPrice?: string;
    ProposeGasPrice?: string;
    FastGasPrice?: string;
  };
}

let cache: { summary: EthereumGasSummary | null; fetchedAt: number } | null = null;

export async function fetchEthereumGasSummary(): Promise<EthereumGasSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.summary;

  try {
    const key = process.env.ETHERSCAN_API_KEY?.trim() ?? "";
    const res = await fetch(
      `${BASE}?chainid=1&module=gastracker&action=gasoracle&apikey=${key}`,
      {
        headers: { accept: "application/json" },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`Etherscan gastracker HTTP ${res.status}`);

    const json = (await res.json()) as GasOracleResponse;
    // Etherscan returns HTTP 200 even for API-level rejections — status
    // must be checked separately, same pattern as exchangeFlows/eth.ts.
    if (json.status !== "1" || !json.result) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    const safe = parseFloat(json.result.SafeGasPrice ?? "");
    const propose = parseFloat(json.result.ProposeGasPrice ?? "");
    const fast = parseFloat(json.result.FastGasPrice ?? "");
    if (![safe, propose, fast].every((v) => Number.isFinite(v) && v >= 0)) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    const summary: EthereumGasSummary = {
      safeGwei: safe,
      proposeGwei: propose,
      fastGwei: fast,
      updatedAt: Date.now(),
    };

    cache = { summary, fetchedAt: Date.now() };
    return summary;
  } catch (err) {
    console.warn("[ethereum-gas] fetch failed:", err);
    return null;
  }
}
