import { fetchJson } from "../../exchanges/adapters/types";
import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../../net/timeout";
import { BTC_ADDRESSES } from "./addresses";

/**
 * Summed BTC balance across BTC_ADDRESSES, via the Esplora API — free, no
 * key. Two hosts run the identical Esplora schema (mempool.space forks
 * blockstream.info's), so a fallback exists for the one address this app
 * currently tracks without needing a second provider integration.
 */
const HOSTS = ["https://blockstream.info/api", "https://mempool.space/api"];

interface EsploraAddress {
  chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
}

/** Confirmed balance only — mempool_stats (unconfirmed) is deliberately excluded to avoid flicker. */
async function fetchOneBalanceSats(address: string): Promise<number | null> {
  for (const host of HOSTS) {
    try {
      const res = await fetchJson<EsploraAddress>(`${host}/address/${address}`, {
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
      });
      const funded = res.chain_stats?.funded_txo_sum ?? 0;
      const spent = res.chain_stats?.spent_txo_sum ?? 0;
      return funded - spent;
    } catch {
      continue; // Try the next host before giving up on this address.
    }
  }
  return null;
}

export interface BtcBalanceResult {
  balanceBtc: number;
  trackedAddressCount: number;
}

/**
 * Sums balances across every tracked address. Partial failures are dropped
 * rather than failing the whole result — with more than one address, a
 * single unreachable one shouldn't blank the signal (today there's only one
 * address, so in practice this is all-or-nothing, but the shape is ready for
 * the list to grow).
 */
export async function fetchBtcExchangeBalance(): Promise<BtcBalanceResult | null> {
  const results = await Promise.all(
    BTC_ADDRESSES.map((a) => fetchOneBalanceSats(a.address))
  );
  const sats = results.filter((v): v is number => v !== null);
  if (sats.length === 0) return null;

  return {
    balanceBtc: sats.reduce((s, v) => s + v, 0) / 1e8,
    trackedAddressCount: sats.length,
  };
}
