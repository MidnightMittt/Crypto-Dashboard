import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { timeoutSignal } from "../net/timeout";
import { RawCvdPoint } from "./okxOrderFlow";

/**
 * OKX SPOT taker buy/sell volume — distinct from okxOrderFlow.ts's PERP
 * (SWAP) taker volume. Same hourly-bucket coarseness and single-venue
 * caveat as that file's own doc comment explains at length; not repeated
 * here.
 *
 * ── Why a second provider file, not a parameter on the existing one ────
 *
 * The two OKX taker-volume endpoints differ enough to make a shared
 * function more confusing than two small ones: the perp endpoint
 * (`/rubik/stat/taker-volume-contract`) is queried by instrument and
 * returns USD directly via `unit=2`; the spot endpoint
 * (`/rubik/stat/taker-volume`) is queried by CURRENCY (ccy=BTC, aggregating
 * every BTC-quoted spot pair on OKX) and has no USD unit option at all —
 * this fetch converts to USD itself using the current spot price, a single
 * reference price applied across the window (the same simplification this
 * app's other coarse hourly aggregates already make).
 *
 * Field order ([ts, sellVol, buyVol]) is assumed to match the perp
 * endpoint's already-doc-verified order, since both live under OKX's same
 * "taker volume" API family — checked empirically (not just assumed) via a
 * magnitude cross-check against the public 24h ticker volume (ratio ~1.04,
 * confirming these values are real BTC-denominated spot taker volume) —
 * but the buy/sell COLUMN order specifically could not be independently
 * re-confirmed via OKX's docs (JS-rendered, not fetchable). If live
 * buyerSharePct reads look systematically inverted against known market
 * direction, flip sellVol/buyVol here first.
 *
 * OKX's retention for this endpoint is genuinely limited (nowhere near the
 * years-deep history other metrics have) — this metric is LIVE-ONLY,
 * matching orderFlow's own existing `hasHistoricalSource: false` status,
 * not a backtestable one.
 */
const BASE = "https://www.okx.com";
const CVD_WINDOW_HOURS = 24;

export async function fetchOkxSpotTakerVolume(asset: AssetSymbol): Promise<RawCvdPoint[]> {
  try {
    const [volRes, priceRes] = await Promise.all([
      fetchJson<{ data: Array<[string, string, string]> }>(
        `${BASE}/api/v5/rubik/stat/taker-volume?ccy=${asset}&instType=SPOT&period=1H`,
        { signal: timeoutSignal() }
      ),
      fetchJson<{ data: Array<{ last: string }> }>(`${BASE}/api/v5/market/ticker?instId=${asset}-USDT`, {
        signal: timeoutSignal(),
      }),
    ]);

    const price = safeNumber(priceRes.data?.[0]?.last);
    if (price <= 0) return [];

    const rows = volRes.data ?? [];
    // OKX returns more than the trailing window for this endpoint
    // regardless of any limit param passed — sliced to the same
    // CVD_WINDOW_HOURS convention okxOrderFlow.ts uses, ourselves.
    return [...rows]
      .slice(0, CVD_WINDOW_HOURS)
      .reverse()
      .map(([t, sellVol, buyVol]) => ({
        t: safeNumber(t),
        sellUsd: safeNumber(sellVol) * price,
        buyUsd: safeNumber(buyVol) * price,
      }));
  } catch (err) {
    console.warn(`[okx-spotflow] taker volume fetch failed for ${asset}:`, err);
    return [];
  }
}
