import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { timeoutSignal } from "../net/timeout";
import { swr } from "../cache/swr";

/**
 * 24h SPOT volume from OKX, so it can be compared against the perpetual
 * volume this app already aggregates.
 *
 * The comparison is the signal, not either number alone. When perp volume
 * dwarfs spot, a move is being driven by leverage rather than by anyone
 * actually buying the asset — which is precisely the condition the rest of
 * this dashboard treats as fragile (see leverageHeat and squeezeRisk).
 * When spot keeps pace, the move has real balance-sheet demand behind it.
 *
 * Single-venue, same caveat as okxCandles.ts and okxOrderFlow.ts: OKX is
 * used because it already has a mapped, keyless REST surface here.
 *
 * THE PERP LEG MUST COME FROM OKX TOO. The caller pairs this with OKX's own
 * perpetual volume, never the all-venue aggregate — see buildSpotPerpVolume
 * in exchanges/aggregator.ts for what went wrong when it didn't.
 *
 * `volCcy24h` on a SPOT pair is quote-denominated, i.e. already USD.
 * Verified against the venue's own figures: 2,143.97 BTC x $63,548.9 =
 * $136.2M, matching the reported $135.7M. Note this does NOT hold for
 * SWAP instruments, where the same field is base-denominated — which is why
 * the perp side is taken from the adapters rather than from this endpoint.
 */

const BASE = "https://www.okx.com";
const FRESH_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;

async function fetchFromApi(asset: AssetSymbol): Promise<number | null> {
  try {
    const res = await fetchJson<{ data: Array<{ volCcy24h: string }> }>(
      `${BASE}/api/v5/market/ticker?instId=${asset}-USDT`,
      { signal: timeoutSignal() }
    );
    // volCcy24h on a spot pair is already quote-denominated (USDT), so this
    // is USD volume directly — no price multiplication needed.
    const raw = res.data?.[0]?.volCcy24h;
    const volume = safeNumber(raw);
    return volume > 0 ? volume : null;
  } catch (err) {
    console.warn(`[spot-volume] fetch failed for ${asset}:`, err);
    return null;
  }
}

export async function fetchSpotVolumeUsd(asset: AssetSymbol): Promise<number | null> {
  try {
    return await swr(`spot-volume:${asset}`, () => fetchFromApi(asset), {
      freshMs: FRESH_MS,
      maxAgeMs: MAX_AGE_MS,
      shouldShare: (next, previous) => next !== null || !previous,
    });
  } catch {
    return null;
  }
}
