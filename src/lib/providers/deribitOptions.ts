import { fetchJson } from "../exchanges/adapters/types";
import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";

/**
 * Deribit — public, keyless options book summary.
 *
 * One call per currency returns open interest, volume, and mark IV for
 * EVERY listed option (every strike, every expiry) at once — Deribit is
 * dominant enough in BTC/ETH options that this doesn't need cross-venue
 * aggregation the way funding/OI elsewhere in this app does.
 *
 * `instrument_name` encodes strike/expiry/type, e.g. "BTC-25DEC26-20000-P"
 * (asset-expiry-strike-C|P) — parsed in sentiment/deribitOptions.ts, kept
 * out of this fetch layer so the parsing logic stays independently testable
 * with no network dependency.
 */
const BASE = "https://www.deribit.com/api/v2";
const CACHE_MS = 60_000; // options OI/IV move far slower than perp price

export interface DeribitOptionRow {
  instrumentName: string;
  openInterest: number;
  volume: number;
  markIv: number;
  underlyingPrice: number;
}

interface DeribitBookSummaryResponse {
  result?: Array<{
    instrument_name?: string;
    open_interest?: number;
    volume?: number;
    mark_iv?: number;
    underlying_price?: number;
  }>;
}

const cache = new Map<string, { rows: DeribitOptionRow[]; fetchedAt: number }>();

export async function fetchDeribitOptions(
  currency: "BTC" | "ETH"
): Promise<DeribitOptionRow[] | null> {
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.rows;

  try {
    const res = await fetchJson<DeribitBookSummaryResponse>(
      `${BASE}/public/get_book_summary_by_currency?currency=${currency}&kind=option`,
      { signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS) }
    );

    const rows: DeribitOptionRow[] = (res.result ?? [])
      .filter(
        (r) =>
          typeof r.instrument_name === "string" &&
          typeof r.open_interest === "number" &&
          typeof r.underlying_price === "number" &&
          r.underlying_price > 0
      )
      .map((r) => ({
        instrumentName: r.instrument_name!,
        openInterest: r.open_interest!,
        volume: r.volume ?? 0,
        markIv: r.mark_iv ?? 0,
        underlyingPrice: r.underlying_price!,
      }));

    cache.set(currency, { rows, fetchedAt: Date.now() });
    return rows;
  } catch (err) {
    console.warn(`[deribit-options] fetch failed for ${currency}:`, err);
    return null;
  }
}
