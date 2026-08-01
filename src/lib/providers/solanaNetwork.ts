import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";
import { driftRpcUrl } from "../exchanges/adapters/driftOnchain";

/**
 * Solana network health — read directly from chain state via RPC, reusing
 * the exact same driftRpcUrl() this app already resolves for Drift's
 * on-chain adapter (HELIUS_API_KEY or SOLANA_RPC_URL). No new key, no
 * third-party explorer API — a direct RPC read beats any of them since
 * there's no middleman to rate-limit or go stale.
 *
 * Deliberately skips getVoteAccounts (validator count): that call returns
 * full details for thousands of validators, a large payload for one field
 * this card doesn't need. TPS and epoch progress come from two lightweight
 * calls instead.
 *
 * Informational, not a sentiment signal — no lean/gauge.
 */
const CACHE_MS = 60_000;

export interface SolanaNetworkSummary {
  tps: number;
  epoch: number;
  epochProgressPct: number;
  updatedAt: number;
}

interface RpcResponse<T> {
  result?: T;
}

interface EpochInfoResult {
  epoch?: number;
  slotIndex?: number;
  slotsInEpoch?: number;
}

interface PerformanceSample {
  numTransactions?: number;
  samplePeriodSecs?: number;
}

let cache: { summary: SolanaNetworkSummary | null; fetchedAt: number } | null = null;

async function rpcCall<T>(url: string, method: string, params: unknown[] = []): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as RpcResponse<T>;
    return json.result ?? null;
  } catch {
    return null;
  }
}

export async function fetchSolanaNetworkSummary(): Promise<SolanaNetworkSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.summary;

  const url = driftRpcUrl();
  if (!url) return null;

  const [epochInfo, samples] = await Promise.all([
    rpcCall<EpochInfoResult>(url, "getEpochInfo"),
    rpcCall<PerformanceSample[]>(url, "getRecentPerformanceSamples", [1]),
  ]);

  if (!epochInfo?.slotsInEpoch || epochInfo.epoch === undefined) {
    cache = { summary: null, fetchedAt: Date.now() };
    return null;
  }

  const sample = samples?.[0];
  const tps =
    sample?.numTransactions && sample.samplePeriodSecs
      ? sample.numTransactions / sample.samplePeriodSecs
      : 0;

  const summary: SolanaNetworkSummary = {
    tps,
    epoch: epochInfo.epoch,
    epochProgressPct: ((epochInfo.slotIndex ?? 0) / epochInfo.slotsInEpoch) * 100,
    updatedAt: Date.now(),
  };

  cache = { summary, fetchedAt: Date.now() };
  return summary;
}
