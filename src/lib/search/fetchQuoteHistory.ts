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

/**
 * INTRADAY BARS — the second timeframe, from the same keyless endpoint.
 *
 * Yahoo serves hourly candles for equities on the identical chart URL the
 * daily fetch already uses; only `interval` changes. That is the whole
 * reason this page does not need a brokerage login to read more than one
 * timeframe — the data was always a query parameter away.
 *
 * Sixty days is the window chosen: enough hourly bars (~420 on a US
 * session) for every indicator the technical read computes, and short
 * enough that the request stays fast. Yahoo caps hourly history at roughly
 * two years regardless, so this is well inside what it will serve.
 *
 * A failure here is never fatal. The intraday read is confirmation, not
 * foundation: without it the page says so in as many words rather than
 * implying a second timeframe agreed.
 */
const INTRADAY_RANGE = "60d";
const INTRADAY_INTERVAL = "1h";

export async function fetchIntradayHistory(providerSymbol: string): Promise<Bar[] | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}` +
      `?range=${INTRADAY_RANGE}&interval=${INTRADAY_INTERVAL}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      // Hourly bars close hourly; half that is a sensible refresh.
      next: { revalidate: 1800 },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } }> };
    };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp;
    const q = r?.indicators?.quote?.[0];
    if (!ts || !q) return null;

    const bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i];
      // Yahoo pads gaps with nulls; a synthesised bar would be a fabricated candle.
      if (open == null || high == null || low == null || close == null) continue;
      bars.push({ t: ts[i] * 1000, open, high, low, close, volume: q.volume?.[i] ?? null });
    }
    return bars.length > 0 ? bars : null;
  } catch {
    return null;
  }
}
