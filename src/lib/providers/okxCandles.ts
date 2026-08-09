import { AssetSymbol } from "@/types/market";
import { fetchJson, safeNumber } from "../exchanges/adapters/types";
import { timeoutSignal } from "../net/timeout";
import { swr } from "../cache/swr";
import { Candle } from "../technicals/indicators";

/**
 * OHLCV candles from OKX's public market endpoint — no key, and not
 * geo-blocked from this app's deployment region (unlike Binance's live API,
 * which this codebase already routes around elsewhere).
 *
 * OKX caps this endpoint at 300 candles per request with no pagination,
 * REGARDLESS of bar size — that's ~10 months for daily bars (comfortably
 * more than the 200 needed for the longest moving average this app
 * computes) but only ~50 days for 4H bars. The 4H series is thin enough
 * that its EMA200 barely warms up (only ~100 "settled" bars past the
 * point EMA200 first has a value, versus daily's much deeper history) —
 * a real quality caveat, not a blocker: `buildTechnicalRead`'s
 * `MIN_CANDLES` gate still clears easily, and every field is honestly
 * null when there isn't enough series to compute it, same as always.
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

// 4H bars close 6x/day — polled less aggressively than daily's 15-minute
// cadence, since a value can't meaningfully change more than once an hour.
const FRESH_MS_4H = 60 * 60 * 1000;
const MAX_AGE_MS_4H = 6 * 60 * 60 * 1000;

async function fetchFromApi(asset: AssetSymbol, bar: "1D" | "4H"): Promise<Candle[]> {
  const instId = `${asset}-USDT-SWAP`;
  try {
    const res = await fetchJson<{ data: Array<string[]> }>(
      `${BASE}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${CANDLE_LIMIT}`,
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
    return await swr(`okx-candles:${asset}`, () => fetchFromApi(asset, "1D"), {
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

/**
 * 4-hour candles — the higher-timeframe series for multi-timeframe
 * confirmation (see sentiment/technicals.ts's `technicalAgreement`, reused
 * unchanged against this series). Live-only: ~50 days of history is nowhere
 * near enough for the backtest's multi-year replay window, and OKX's
 * 300-bar cap can't be paged around — see this file's header.
 */
export async function fetchOkx4hCandles(asset: AssetSymbol): Promise<Candle[]> {
  try {
    return await swr(`okx-candles-4h:${asset}`, () => fetchFromApi(asset, "4H"), {
      freshMs: FRESH_MS_4H,
      maxAgeMs: MAX_AGE_MS_4H,
      shouldShare: (next, previous) => next.length > 0 || !previous,
    });
  } catch {
    return [];
  }
}
