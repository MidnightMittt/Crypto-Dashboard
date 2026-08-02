import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { timeoutSignal } from "../net/timeout";
import { swr } from "../cache/swr";
import { Candle } from "../technicals/indicators";

/**
 * Daily OHLCV candles from OKX's public market endpoint — no key, and not
 * geo-blocked from this app's deployment region (unlike Binance's live API,
 * which this codebase already routes around elsewhere).
 *
 * OKX caps this endpoint at 300 candles per request with no pagination.
 * That's ~10 months of daily bars, comfortably more than the 200 needed for
 * the longest moving average this app computes, so no paging is attempted.
 *
 * Single-venue by design, same caveat as okxOrderFlow.ts: OKX was chosen
 * because it already has a mapped, working REST surface here, not because
 * its price series is uniquely authoritative. For technical structure on a
 * major pair this distinction barely matters — venues track within a few
 * basis points — but it is the reason this is used for TREND CONTEXT and not
 * as the app's headline price, which stays OI-weighted across all venues.
 */

const BASE = "https://www.okx.com";
const CANDLE_LIMIT = 300;

// Daily bars only change meaningfully once a day; the intraday drift within
// the forming bar isn't worth re-fetching on every poll.
const FRESH_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function fetchFromApi(asset: AssetSymbol): Promise<Candle[]> {
  const instId = `${asset}-USDT-SWAP`;
  try {
    const res = await fetchJson<{ data: Array<string[]> }>(
      `${BASE}/api/v5/market/candles?instId=${instId}&bar=1D&limit=${CANDLE_LIMIT}`,
      { signal: timeoutSignal() }
    );

    const rows = res.data ?? [];
    /*
     * Row shape: [ts, open, high, low, close, volContracts, volCcy,
     * volCcyQuote, confirm]. Index 7 (volCcyQuote) is the USD-denominated
     * volume — index 5 is a raw contract count, which is NOT comparable
     * across assets and would make the volume ratio meaningless.
     *
     * DROPPING THE UNCONFIRMED BAR (confirm === "0") IS NOT OPTIONAL.
     * OKX returns the still-forming current day as the newest row, and its
     * volume is only however much has traded so far today — measured live,
     * 374M against ~3.3B for completed days. Left in, the volume ratio reads
     * ~0.1x every morning and the card would permanently claim the move
     * "is not backed by conviction", recovering only late in the UTC day.
     * Indicators are conventionally computed on closed bars for exactly this
     * reason.
     *
     * Reversed to oldest-first: every function in technicals/indicators.ts
     * assumes index 0 is the oldest bar, and OKX returns newest-first.
     */
    return [...rows]
      .reverse()
      .filter((r) => r[8] === "1")
      .map((r) => ({
        t: safeNumber(r[0]),
        open: safeNumber(r[1]),
        high: safeNumber(r[2]),
        low: safeNumber(r[3]),
        close: safeNumber(r[4]),
        volumeUsd: safeNumber(r[7]),
      }))
      .filter((c) => c.close > 0 && c.high > 0 && c.low > 0);
  } catch (err) {
    console.warn(`[okx-candles] fetch failed for ${asset}:`, err);
    return [];
  }
}

export async function fetchOkxDailyCandles(asset: AssetSymbol): Promise<Candle[]> {
  try {
    return await swr(`okx-candles:${asset}`, () => fetchFromApi(asset), {
      freshMs: FRESH_MS,
      maxAgeMs: MAX_AGE_MS,
      // Never let an empty result overwrite a good cached series — a single
      // failed poll shouldn't blank out every technical read downstream.
      shouldShare: (next, previous) => next.length > 0 || !previous,
    });
  } catch {
    return [];
  }
}
