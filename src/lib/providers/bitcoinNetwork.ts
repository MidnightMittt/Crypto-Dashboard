import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * Bitcoin network health — mempool.space, free, keyless.
 *
 * Same host already used as the fallback in providers/exchangeFlows/btc.ts,
 * but these three endpoints (fees/mining/mempool) are mempool.space's own
 * extensions beyond the base Esplora API that blockstream.info mirrors, so
 * there's no equivalent fallback host for these specific calls the way
 * btc.ts has one for plain address balances.
 *
 * This is informational, not a sentiment signal — no lean/gauge, unlike
 * most of the rest of this dashboard. A busy mempool or high hash rate
 * isn't bullish or bearish, it's just network state.
 */
const BASE = "https://mempool.space/api";
const CACHE_MS = 5 * 60_000;

export interface BitcoinNetworkSummary {
  hashrateEhs: number;
  difficulty: number;
  /** sat/vB for next-block confirmation. */
  fastestFeeSatVb: number;
  /** Pending (unconfirmed) transaction count. */
  mempoolCount: number;
  updatedAt: number;
}

interface HashrateResponse {
  currentHashrate?: number;
  currentDifficulty?: number;
}

interface FeesResponse {
  fastestFee?: number;
}

interface MempoolResponse {
  count?: number;
}

let cache: { summary: BitcoinNetworkSummary | null; fetchedAt: number } | null = null;

export async function fetchBitcoinNetworkSummary(): Promise<BitcoinNetworkSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.summary;

  try {
    const [hashrateRes, feesRes, mempoolRes] = await Promise.all([
      fetch(`${BASE}/v1/mining/hashrate/3d`, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }),
      fetch(`${BASE}/v1/fees/recommended`, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }),
      fetch(`${BASE}/mempool`, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      }),
    ]);

    if (!hashrateRes.ok || !feesRes.ok || !mempoolRes.ok) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    const hashrate = (await hashrateRes.json()) as HashrateResponse;
    const fees = (await feesRes.json()) as FeesResponse;
    const mempool = (await mempoolRes.json()) as MempoolResponse;

    if (!hashrate.currentHashrate || !fees.fastestFee || mempool.count === undefined) {
      cache = { summary: null, fetchedAt: Date.now() };
      return null;
    }

    const summary: BitcoinNetworkSummary = {
      // currentHashrate is in H/s; EH/s (exahash) is the readable unit
      // every hash rate chart actually shows.
      hashrateEhs: hashrate.currentHashrate / 1e18,
      difficulty: hashrate.currentDifficulty ?? 0,
      fastestFeeSatVb: fees.fastestFee,
      mempoolCount: mempool.count,
      updatedAt: Date.now(),
    };

    cache = { summary, fetchedAt: Date.now() };
    return summary;
  } catch (err) {
    console.warn("[bitcoin-network] fetch failed:", err);
    return null;
  }
}
