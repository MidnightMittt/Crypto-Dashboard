import { Bar } from "@/lib/research/types";

/**
 * DAILY BARS FOR AN ARBITRARY SYMBOL, AT REQUEST TIME.
 *
 * The ingest pipeline fetches a fixed universe on a schedule and validates it
 * hard. This is the other case: something the user typed thirty seconds ago,
 * which may not exist. It shares the ingest's provider and its parsing rules
 * — same endpoint, same null-row handling — but not its refusal behaviour,
 * because a search must answer rather than exit.
 *
 * WHAT IT REFUSES TO DO is return a partial series silently. Yahoo emits null
 * OHLC entries for halted sessions; those rows are dropped, and the caller is
 * told how many bars survived so a thin series can be refused downstream
 * rather than scored.
 */

interface YahooChartResponse {
  chart: {
    result: Array<{
      meta?: { longName?: string; shortName?: string; regularMarketPrice?: number };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }> | null;
    error: { code?: string; description?: string } | null;
  };
}

export interface QuoteHistory {
  bars: Bar[];
  /** The provider's own name for the instrument, so the page can title itself honestly. */
  name: string;
  /** Rows the provider returned but which carried no usable price. */
  droppedRows: number;
}

export type QuoteHistoryResult =
  | { ok: true; history: QuoteHistory }
  | { ok: false; reason: string };

/** Five years of daily bars: comfortably past the 500-session percentile window. */
const LOOKBACK_SECONDS = 5 * 365 * 24 * 3600;

export async function fetchQuoteHistory(providerSymbol: string): Promise<QuoteHistoryResult> {
  const now = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}` +
    `?period1=${now - LOOKBACK_SECONDS}&period2=${now}&interval=1d`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      // Daily bars change once a day; a short cache absorbs repeat searches
      // for the same name without serving genuinely stale prices.
      next: { revalidate: 900 },
    });
  } catch {
    return { ok: false, reason: "The price data provider could not be reached. This is an outage on our side, not a problem with the ticker." };
  }

  if (res.status === 404) {
    return { ok: false, reason: `No instrument is listed under “${providerSymbol}”. Check the spelling — search takes the ticker symbol, not the company name.` };
  }
  if (!res.ok) {
    return { ok: false, reason: `The price data provider returned an error (HTTP ${res.status}) for “${providerSymbol}”.` };
  }

  let json: YahooChartResponse;
  try {
    json = (await res.json()) as YahooChartResponse;
  } catch {
    return { ok: false, reason: "The price data provider returned something unreadable." };
  }

  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp || result.timestamp.length === 0) {
    return { ok: false, reason: `No price history exists for “${providerSymbol}”. It may be delisted, or it may never have been listed.` };
  }

  const q = result.indicators.quote[0];
  const bars: Bar[] = [];
  let droppedRows = 0;

  for (let i = 0; i < result.timestamp.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];

    // A halted or untraded session comes back as nulls. Dropping it is
    // correct; interpolating one would invent a price that never traded.
    if (open == null || high == null || low == null || close == null) {
      droppedRows++;
      continue;
    }
    bars.push({ t: result.timestamp[i] * 1000, open, high, low, close, volume: q.volume?.[i] ?? null });
  }

  const name = result.meta?.longName || result.meta?.shortName || providerSymbol;
  return { ok: true, history: { bars, name, droppedRows } };
}
