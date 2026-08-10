import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { contractValue } from "../exchanges/adapters/okx";
import { timeoutSignal } from "../net/timeout";

/**
 * OKX order book depth and taker buy/sell volume — public REST, no key.
 *
 * ── Why OKX, and why this is not tick-level CVD ────────────────────────
 *
 * Genuine tick-level cumulative volume delta needs a persistent connection
 * to a trade stream (WebSocket), reading every individual print as it
 * happens. This app is serverless (Vercel functions), which cannot hold a
 * long-lived connection between polls — there is no architecture here that
 * could deliver that honestly.
 *
 * What OKX's public REST DOES publish is real, just coarser: pre-aggregated
 * taker buy/sell volume in fixed time buckets (this uses 1-hour buckets,
 * `/rubik/stat/taker-volume-contract`). Summing (buy - sell) across buckets
 * is a genuine cumulative volume delta — it just can't see structure inside
 * an hour the way a tick feed would. Building a fake tick-level chart out of
 * this data would misrepresent its resolution; showing the real hourly
 * figure and saying so is the honest version of this feature.
 *
 * Single-venue (OKX) only. This is NOT cross-exchange aggregated the way
 * funding/OI are elsewhere in this app — OKX was chosen because it already
 * has a mapped, no-key REST surface (see adapters/okx.ts's existing rubik
 * usage), not because its flow is uniquely representative of the market.
 */
const BASE = "https://www.okx.com";
const CVD_WINDOW_HOURS = 24;
const BOOK_DEPTH_LEVELS = 20;

export interface RawCvdPoint {
  t: number;
  buyUsd: number;
  sellUsd: number;
}

/** One resting price level, already converted to USD size via contractValue() — the same conversion the bid/ask totals below use. */
export interface RawBookLevel {
  price: number;
  usd: number;
}

export interface RawBookDepth {
  bidUsd: number;
  askUsd: number;
  depthLevels: number;
  /**
   * The individual levels behind bidUsd/askUsd, sorted best-price-first —
   * i.e. bids descending, asks ascending. OKX's response already contains
   * this per-level detail (see BookLevel below); previously it was summed
   * and discarded. Kept here so wall detection (liquidityWalls.ts) can run
   * on real per-level sizes without a second request to the same endpoint.
   */
  bids: RawBookLevel[];
  asks: RawBookLevel[];
}

/**
 * Hourly taker buy/sell volume, oldest first, already USD (unit=2 avoids any
 * contract-size lookup entirely — this is why taker-volume-contract was used
 * over the ccy-wide /rubik/stat/taker-volume, which has no USD unit option).
 */
export async function fetchOkxTakerVolume(asset: AssetSymbol): Promise<RawCvdPoint[]> {
  const instId = `${asset}-USDT-SWAP`;
  try {
    const res = await fetchJson<{ data: Array<[string, string, string]> }>(
      `${BASE}/api/v5/rubik/stat/taker-volume-contract?instId=${instId}&period=1H&unit=2&limit=${CVD_WINDOW_HOURS}`,
      { signal: timeoutSignal() }
    );
    const rows = res.data ?? [];
    // Newest-first from OKX, like every other rubik endpoint this app
    // already consumes (see adapters/okx.ts) — reversed to oldest-first so
    // a running cumulative sum reads left-to-right correctly.
    return [...rows]
      .reverse()
      .map(([t, sellVol, buyVol]) => ({
        // OKX's response schema confirms [ts, sellVol, buyVol] in that
        // order — verified against their published docs, not guessed.
        // Swapping this would flip every buy/sell read in this feature.
        t: safeNumber(t),
        sellUsd: safeNumber(sellVol),
        buyUsd: safeNumber(buyVol),
      }));
  } catch (err) {
    console.warn(`[okx-orderflow] taker volume fetch failed for ${asset}:`, err);
    return [];
  }
}

/**
 * [price, sizeContracts, deprecated (always "0"), numberOfOrders] per OKX's
 * published order-book schema. Only the first two are used here.
 */
type BookLevel = [string, string, string, string];

/**
 * Top-of-book depth, summed to BOOK_DEPTH_LEVELS per side and converted to
 * USD via the same contractValue() lookup adapters/okx.ts already uses for
 * volume — each level's own price, not a single reference price, since a
 * deep book can span a real price range.
 */
export async function fetchOkxBookDepth(asset: AssetSymbol): Promise<RawBookDepth | null> {
  const instId = `${asset}-USDT-SWAP`;
  try {
    const [book, ctVal] = await Promise.all([
      fetchJson<{ data: Array<{ asks: BookLevel[]; bids: BookLevel[] }> }>(
        `${BASE}/api/v5/market/books?instId=${instId}&sz=${BOOK_DEPTH_LEVELS}`,
        { signal: timeoutSignal() }
      ),
      contractValue(instId),
    ]);

    const row = book.data?.[0];
    if (!row) return null;

    const toLevels = (levels: BookLevel[]): RawBookLevel[] =>
      levels.map(([price, sizeContracts]) => ({
        price: safeNumber(price),
        usd: safeNumber(sizeContracts) * ctVal * safeNumber(price),
      }));

    const bids = toLevels(row.bids ?? []);
    const asks = toLevels(row.asks ?? []);
    const sumUsd = (levels: RawBookLevel[]) => levels.reduce((sum, l) => sum + l.usd, 0);

    return {
      bidUsd: sumUsd(bids),
      askUsd: sumUsd(asks),
      depthLevels: BOOK_DEPTH_LEVELS,
      bids,
      asks,
    };
  } catch (err) {
    console.warn(`[okx-orderflow] book depth fetch failed for ${asset}:`, err);
    return null;
  }
}
