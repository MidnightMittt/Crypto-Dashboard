import { swr } from "../cache/swr";
import { timeoutSignal } from "../net/timeout";

/**
 * Macro/TradFi context — the Dashboard v2 spec's Macro browsing section.
 * Market-wide, asset-independent, same as stablecoins.ts/fearGreed.ts.
 *
 * Genuinely NOT a scoring input: per the taxonomy decision confirmed with
 * the user (see [[dashboard-v2-roadmap]] memory), this is a read-only
 * browsing section, not a second engine feeding bias.score.
 *
 * ── What's here, and why each instrument is what it is ─────────────────
 *
 * Sourced from a direct reachability/coverage spike (2026-08-06), not
 * assumed — confirmed via real requests against both providers' free
 * tiers before writing this file:
 *
 *   Dollar Index -> UUP (Invesco DB US Dollar Index Bullish Fund, Twelve
 *     Data). No direct DXY index quote exists on Twelve Data's free
 *     "basic" plan — this ETF is the closest tracking instrument found.
 *   Gold -> XAU/USD (Twelve Data). A REAL spot price, not an ETF proxy —
 *     better than gold's usual GLD-ETF substitute.
 *   Nasdaq -> QQQ (Twelve Data). Direct index tickers (IXIC/NDX) 404 on
 *     the free plan; QQQ is the standard liquid proxy.
 *   S&P 500 -> SPY (Twelve Data). Direct SPX quote returned "requires
 *     Grow/Venture plan" — paid-tier gated. SPY is the standard proxy.
 *   VIX -> VIXY (ProShares VIX Short-Term Futures ETF, Twelve Data).
 *     UNLEVERAGED short-term VIX futures, not the raw index level — VIX
 *     futures roll carries its own drift (contango/backwardation) even
 *     without added leverage. Deliberately NOT a leveraged product
 *     (UVXY/VIX2/VIXL were also checked and rejected) — leverage decay
 *     would misrepresent the level over any real time horizon. Confirmed
 *     with the user this caveat is acceptable for a directional read.
 *   10-Year Treasury Yield -> Alpha Vantage's TREASURY_YIELD function.
 *     The one AUTHORITATIVE, non-proxy instrument here — a real published
 *     rate, not an ETF approximation.
 *
 * ── Why the two providers, and why the cache windows are this long ─────
 *
 * Alpha Vantage's free tier is 25 requests/DAY, TOTAL, confirmed via a
 * live rate-limit response during the spike — not a per-minute figure.
 * Twelve Data's free "basic" plan is 800/day, 8/minute (confirmed via its
 * own /api_usage endpoint). Both are shared, Redis-backed via swr() across
 * every Vercel instance (see cache/swr.ts) — without a long cache window,
 * concurrent instances polling every 15s would exhaust either budget
 * within minutes. TREASURY_FRESH_MS is deliberately long (6h): even under
 * sustained traffic, that caps this app's own usage at 4 calls/day,
 * comfortably inside the 25/day ceiling with headroom for other future
 * Alpha Vantage use. QUOTE_FRESH_MS (20m) keeps 5 Twelve Data instruments
 * to roughly 360 calls/day, well under 800.
 */

const TWELVE_DATA_BASE = "https://api.twelvedata.com";
const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";

const QUOTE_FRESH_MS = 20 * 60_000;
const QUOTE_MAX_AGE_MS = 4 * 60 * 60_000;
const TREASURY_FRESH_MS = 6 * 60 * 60_000;
const TREASURY_MAX_AGE_MS = 24 * 60 * 60_000;

export interface MacroInstrumentQuote {
  symbol: string;
  name: string;
  price: number;
  /** Day change, percent. */
  changePct: number;
}

export interface MacroSnapshot {
  dollarIndex: MacroInstrumentQuote | null;
  gold: MacroInstrumentQuote | null;
  nasdaq: MacroInstrumentQuote | null;
  sp500: MacroInstrumentQuote | null;
  vix: MacroInstrumentQuote | null;
  treasury10yPct: number | null;
  treasury10yDate: string | null;
  updatedAt: number;
}

interface TwelveDataQuoteResponse {
  symbol?: string;
  name?: string;
  close?: string;
  percent_change?: string;
  code?: number;
  status?: string;
}

async function fetchTwelveDataQuote(symbol: string, name: string): Promise<MacroInstrumentQuote | null> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return null;

  return swr(
    `macro:td:${symbol}`,
    async () => {
      const res = await fetch(`${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`, {
        signal: timeoutSignal(),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${symbol}`);
      const json = (await res.json()) as TwelveDataQuoteResponse;
      if (json.status === "error" || json.code) {
        throw new Error(`Twelve Data error for ${symbol}: ${JSON.stringify(json)}`);
      }
      const price = Number(json.close);
      const changePct = Number(json.percent_change);
      if (!Number.isFinite(price) || !Number.isFinite(changePct)) {
        throw new Error(`Twelve Data returned non-numeric fields for ${symbol}`);
      }
      return { symbol, name, price, changePct };
    },
    { freshMs: QUOTE_FRESH_MS, maxAgeMs: QUOTE_MAX_AGE_MS }
  ).catch((err) => {
    console.warn(`[macro] Twelve Data fetch failed for ${symbol}:`, err);
    return null;
  });
}

interface TreasuryYieldResponse {
  data?: Array<{ date: string; value: string }>;
}

async function fetchTreasuryYield(): Promise<{ pct: number; date: string } | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return null;

  return swr(
    "macro:av:treasury10y",
    async () => {
      const res = await fetch(
        `${ALPHA_VANTAGE_BASE}?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${apiKey}`,
        { signal: timeoutSignal(), cache: "no-store" }
      );
      if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
      const json = (await res.json()) as TreasuryYieldResponse;
      const latest = json.data?.[0];
      const pct = Number(latest?.value);
      if (!latest || !Number.isFinite(pct)) {
        throw new Error(`Alpha Vantage TREASURY_YIELD returned no usable data: ${JSON.stringify(json)}`);
      }
      return { pct, date: latest.date };
    },
    { freshMs: TREASURY_FRESH_MS, maxAgeMs: TREASURY_MAX_AGE_MS }
  ).catch((err) => {
    console.warn("[macro] Alpha Vantage treasury yield fetch failed:", err);
    return null;
  });
}

export async function fetchMacroSnapshot(): Promise<MacroSnapshot> {
  const [dollarIndex, gold, nasdaq, sp500, vix, treasury] = await Promise.all([
    fetchTwelveDataQuote("UUP", "US Dollar Index (proxy)"),
    fetchTwelveDataQuote("XAU/USD", "Gold Spot"),
    fetchTwelveDataQuote("QQQ", "Nasdaq 100 (proxy)"),
    fetchTwelveDataQuote("SPY", "S&P 500 (proxy)"),
    fetchTwelveDataQuote("VIXY", "VIX Short-Term Futures (proxy)"),
    fetchTreasuryYield(),
  ]);

  return {
    dollarIndex,
    gold,
    nasdaq,
    sp500,
    vix,
    treasury10yPct: treasury?.pct ?? null,
    treasury10yDate: treasury?.date ?? null,
    updatedAt: Date.now(),
  };
}
