import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { timeoutSignal } from "../net/timeout";
import { swr } from "../cache/swr";
import { Candle } from "../technicals/indicators";

/**
 * DEEP daily history from OKX — years, not months.
 *
 * ── WHY THIS EXISTS ALONGSIDE okxCandles.ts, NOT INSTEAD OF IT ──────────
 *
 * `okxCandles.ts` is correct and stays exactly as it is. It serves the live
 * technical read, where 300 recent bars at a 15-minute refresh is the right
 * trade, and its header's claim — "OKX caps this endpoint at 300 candles per
 * request with no pagination" — is TRUE of the endpoint it calls:
 *
 *     /api/v5/market/candles          300 max, no pagination
 *
 * What was missing is that OKX exposes a SECOND endpoint:
 *
 *     /api/v5/market/history-candles  300 max per call, but PAGINATES
 *
 * Measured 2026-11-28 on the instIds this app actually uses:
 *
 *     BTC-USDT-SWAP  1D    candles: 300    history-candles: 2,558  (7.0y)
 *     ETH-USDT-SWAP  1D    candles: 300    history-candles: 2,556  (7.0y)
 *     SOL-USDT-SWAP  1D    candles: 300    history-candles: 2,137  (5.8y)
 *
 * So the 300-bar ceiling behind `STRUCTURE_WINDOW_BARS` was never an API
 * limit — it was a property of which endpoint was being called. 2,558 daily
 * bars is ~365 weekly and ~84 monthly candles, which is what weekly and
 * monthly market structure needs.
 *
 * ── COVERAGE IS NOT UNIFORM ─────────────────────────────────────────────
 *
 * SOL's perpetual listed later than BTC's, so it has ~2 fewer years. Callers
 * must not assume equal depth across assets: a monthly zone engine that
 * silently has 84 months of BTC and 58 of SOL will present them as equally
 * well-founded. `fetchDeepDailyCandles` therefore returns what exists and the
 * caller is expected to gate on length.
 *
 * ── PAGINATION, AND THE ONE TRAP ────────────────────────────────────────
 *
 * history-candles returns NEWEST FIRST and pages BACKWARD via `after`, which
 * reads like the opposite of what it does. Getting it backwards silently
 * returns the same page forever, so the loop asserts the oldest timestamp
 * strictly decreases and stops if it does not.
 */

const BASE = "https://www.okx.com";
const PAGE_LIMIT = 300;
/** Hard ceiling on requests per asset. 2,558 daily bars is ~9 pages; 40 is slack for growth, not a target. */
const MAX_PAGES = 40;
/** Politeness delay between pages. OKX allows ~20 req/2s on this endpoint. */
const PAGE_GAP_MS = 120;

/*
 * Deep history is nearly all immutable — a bar from 2019 will never change —
 * so this is cached far longer than the live 15-minute series. The only thing
 * that moves is the newest bar, and weekly/monthly STRUCTURE does not turn on
 * today's close. Refetching 2,500 bars every quarter hour would be pure waste.
 */
const FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(instId: string, bar: string, after: number | null): Promise<string[][]> {
  const url =
    `${BASE}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${PAGE_LIMIT}` +
    (after !== null ? `&after=${after}` : "");
  const res = await fetchJson<{ data: Array<string[]> }>(url, { signal: timeoutSignal() });
  return res.data ?? [];
}

async function fetchFromApi(asset: AssetSymbol, bar: "1D" | "4H"): Promise<Candle[]> {
  const instId = `${asset}-USDT-SWAP`;
  const byT = new Map<number, Candle>();
  let after: number | null = null;
  let previousOldest = Number.POSITIVE_INFINITY;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchPage(instId, bar, after);
      if (!rows.length) break;

      for (const r of rows) {
        /*
         * Row shape and conventions are IDENTICAL to okxCandles.ts and are
         * deliberately kept in lockstep with it:
         *   [ts, open, high, low, close, volContracts, volCcy, volCcyQuote, confirm]
         * - index 7 (volCcyQuote) is USD volume. Index 5 is a contract count,
         *   which is not comparable across assets.
         * - confirm !== "1" is a still-forming bar and is dropped. On this
         *   endpoint that is normally only the newest row, but dropping it
         *   unconditionally keeps the two providers' definitions the same —
         *   and a mismatch there would make daily and weekly structure
         *   disagree about what "the last closed bar" is.
         */
        if (r[8] !== "1") continue;
        const c: Candle = {
          t: safeNumber(r[0]),
          open: safeNumber(r[1]),
          high: safeNumber(r[2]),
          low: safeNumber(r[3]),
          close: safeNumber(r[4]),
          volumeUsd: safeNumber(r[7]),
        };
        if (c.close > 0 && c.high > 0 && c.low > 0) byT.set(c.t, c);
      }

      const oldest = Math.min(...rows.map((r) => safeNumber(r[0])));
      // PAGINATION ASSERT — see the header. A stall would otherwise loop
      // MAX_PAGES times re-storing the same bars and look like success.
      if (!Number.isFinite(oldest) || oldest >= previousOldest) break;
      previousOldest = oldest;
      after = oldest;

      if (page < MAX_PAGES - 1) await sleep(PAGE_GAP_MS);
    }
  } catch (err) {
    console.warn(`[okx-deep-history] fetch failed for ${asset} ${bar}:`, err);
    // Return whatever paged in successfully rather than nothing — a partial
    // deep series is still far better than the 300-bar live one.
  }

  return [...byT.values()].sort((a, b) => a.t - b.t); // oldest-first, as indicators.ts requires
}

/**
 * Multi-year daily candles for `asset`, oldest first, closed bars only.
 * Returns `[]` on total failure; may return a partial series on partial
 * failure. Callers must gate on `.length` before deriving monthly structure.
 */
export async function fetchDeepDailyCandles(asset: AssetSymbol): Promise<Candle[]> {
  try {
    return await swr(`okx-deep-daily:${asset}`, () => fetchFromApi(asset, "1D"), {
      freshMs: FRESH_MS,
      maxAgeMs: MAX_AGE_MS,
      // Same guard as okxCandles.ts: never let a failed poll blank a good series.
      shouldShare: (next, previous) => next.length > 0 || !previous,
    });
  } catch {
    return [];
  }
}
