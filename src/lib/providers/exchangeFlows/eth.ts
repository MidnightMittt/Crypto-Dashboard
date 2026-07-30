import { fetchJson, safeNumber } from "../../exchanges/adapters/types";
import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../../net/timeout";
import { ETH_ADDRESSES } from "./addresses";

/**
 * Summed ETH balance across ETH_ADDRESSES, via Etherscan API V2.
 *
 * Requires ETHERSCAN_API_KEY (free — https://etherscan.io/apidashboard).
 * Etherscan's old keyless V1 endpoint was retired; V2 requires a key even
 * for a single balance lookup. Same "optional, feature just doesn't
 * populate without it" pattern as COINALYZE_API_KEY elsewhere in this app —
 * never a hard failure, just no exchangeFlow data for ETH.
 */
const BASE = "https://api.etherscan.io/v2/api";
const ETH_CHAIN_ID = 1;

interface EtherscanBalanceResponse {
  status?: string;
  message?: string;
  result?: string;
}

function apiKey(): string | null {
  const key = process.env.ETHERSCAN_API_KEY?.trim();
  return key || null;
}

export function etherscanConfigured(): boolean {
  return apiKey() !== null;
}

async function fetchOneBalanceWei(address: string, key: string): Promise<number | null> {
  try {
    const url = `${BASE}?chainid=${ETH_CHAIN_ID}&module=account&action=balance&address=${address}&tag=latest&apikey=${key}`;
    const res = await fetchJson<EtherscanBalanceResponse>(url, {
      signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
    });
    // Etherscan returns HTTP 200 even for API-level errors — status must be
    // checked separately from the HTTP status fetchJson already validated.
    if (res.status !== "1") return null;
    return safeNumber(res.result);
  } catch {
    return null;
  }
}

export interface EthBalanceResult {
  balanceEth: number;
  trackedAddressCount: number;
}

export async function fetchEthExchangeBalance(): Promise<EthBalanceResult | null> {
  const key = apiKey();
  if (!key) return null;

  const results = await Promise.all(
    ETH_ADDRESSES.map((a) => fetchOneBalanceWei(a.address, key))
  );
  const wei = results.filter((v): v is number => v !== null);
  if (wei.length === 0) return null;

  return {
    balanceEth: wei.reduce((s, v) => s + v, 0) / 1e18,
    trackedAddressCount: wei.length,
  };
}
