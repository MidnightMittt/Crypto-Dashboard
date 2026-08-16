import { spreadBp } from "@/lib/history/spreadHistory";

/**
 * VENUE STATUS — can this actually be traded, right now, and at what book.
 *
 * The pre-trade payload's `tradability` block was null with reason
 * "no_venue_status_feed" from the day it was designed. This is that feed:
 * Tradier's market clock for the session state, and Tradier's quote endpoint
 * for the top of book on each symbol. Two requests total, regardless of how
 * many symbols are asked for.
 *
 * ── What this feed does NOT carry, stated plainly ─────────────────────
 *
 * Tradier's quote payload has no halt flag. None. So this module never emits
 * one, and never infers one: a symbol with a one-sided book at 03:00 is not
 * "halted", it is a book nobody is quoting overnight, and the two are
 * indistinguishable from here. What is reported instead is what was actually
 * observed — whether a two-sided book exists, how wide it is, and how old it
 * is — leaving the inference to a consumer who knows what else is true.
 *
 * Likewise `status` is the MARKET session, not the symbol's. "open" means the
 * venue is open; it is not a claim that this particular name is trading.
 *
 * ── Age is the field that stops the book from lying ───────────────────
 *
 * Measured against the live sandbox on a Sunday, APLD came back 31.19 / 31.20
 * — a one-tick book, and 45 hours old. Nothing in the quote says so. Without
 * an age beside it, Friday's closing book reads exactly like a live one, and
 * an agent sizing against a 0.3bp spread would be pricing a market that has
 * not existed since the close. So every book here carries the age of its
 * STALER side, and its as_of is the instant that side was true.
 *
 * ── Sandbox versus production is in the source string ─────────────────
 *
 * Sandbox quotes are 15-minute delayed; production quotes are not. That is a
 * difference of an entire execution window, so the delay regime rides in the
 * `source` a consumer sees rather than living in a deployment setting nobody
 * downstream can read.
 */

export type TradierEnv = "sandbox" | "production";

export function tradierEnv(): TradierEnv {
  return (process.env.TRADIER_ENV || "sandbox").trim().toLowerCase() === "production"
    ? "production"
    : "sandbox";
}

function baseUrl(env: TradierEnv): string {
  return env === "production" ? "https://api.tradier.com" : "https://sandbox.tradier.com";
}

/** The venue clock, as Tradier reports it. */
export interface RawClock {
  date: string;
  state: string;
  description: string;
  timestamp: number;
  next_change: string;
  next_state: string;
}

export interface VenueClock {
  /** open | closed | premarket | postmarket, passed through verbatim. */
  state: string;
  nextState: string;
  /** Tradier's own wall-clock ET string, e.g. "16:00". */
  nextChangeEt: string;
  /** ISO instant of the next change, or null when it is not on the clock's date. */
  nextChangeIso: string | null;
  /** Why the instant could not be resolved, when it could not. */
  nextChangeReason: string | null;
  /** ISO instant the clock itself was read. */
  asOf: string;
}

export interface VenueBook {
  bid: number;
  ask: number;
  /**
   * Depth at the touch. NULL, not 0, when the venue does not report it —
   * a closed book returns empty, and storing that as zero manufactures a
   * "thin book" signal on every holiday.
   */
  bid_size: number | null;
  ask_size: number | null;
  spread_bp: number;
  /**
   * Seconds since the staler side of this book was last updated.
   *
   * Carried INSIDE the book rather than beside it so the two cannot be
   * separated. A spread quoted without its age is the specific way this feed
   * misleads: on a weekend it serves Friday's one-tick book with nothing at
   * all marking it stale.
   */
  age_seconds: number;
}

export interface VenueQuote {
  symbol: string;
  book: VenueBook;
  /** ISO instant of the STALER side of the book — when it was last all true. */
  bookAsOf: string;
}

export type QuoteResult = { ok: true; quote: VenueQuote } | { ok: false; reason: string };

export type VenueStatus =
  | {
      ok: true;
      env: TradierEnv;
      clock: VenueClock;
      /** One entry per symbol ASKED FOR, so "not quoted" is an answer. */
      quotes: Map<string, QuoteResult>;
    }
  | { ok: false; reason: string; configured: boolean };

/**
 * The UTC instant of an ET wall-clock time on an ET calendar date, or null.
 *
 * ET is UTC−4 or UTC−5 and which one is a function of the date, so both
 * candidates are constructed and each is rendered BACK into Eastern; the one
 * that reads the requested date and minute wins. No DST calendar is encoded,
 * so nothing here rots at the next transition. Returns null in the spring-
 * forward gap, where the requested wall-clock time genuinely does not exist.
 */
export function etInstantOnDate(dateEt: string, hhmm: string): number | null {
  const [y, m, d] = dateEt.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, hh + offset, mm);
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hour = Number(p.hour) % 24;
    if (
      `${p.year}-${p.month}-${p.day}` === dateEt &&
      hour === hh &&
      Number(p.minute) === mm
    ) {
      return t;
    }
  }
  return null;
}

/**
 * Resolve `next_change` to an instant, or refuse.
 *
 * Tradier reports the next state change as a bare ET wall-clock time with no
 * date — "07:00". During a session that unambiguously means later today, and
 * the instant is exact. Outside one it does not: read live on Sunday
 * 2026-08-16, the clock said `state: closed, next_change: "07:00"`, meaning
 * MONDAY's premarket. Naively pairing that time with the clock's own date
 * yields an instant thirteen hours in the past.
 *
 * Walking forward to the next weekday would usually fix it and would be wrong
 * on a holiday, which is the failure that matters: naming a precise instant
 * the market will not honour is worse than naming none. So the instant is
 * served only when it lands after the clock's own timestamp, and otherwise the
 * raw ET time is handed over with a reason. The case an agent actually needs —
 * "the session is open, when does it close" — is always the resolvable one.
 */
export function resolveNextChange(clock: RawClock): {
  iso: string | null;
  reason: string | null;
} {
  const t = etInstantOnDate(clock.date, clock.next_change);
  if (t === null) return { iso: null, reason: "next_change_time_unresolvable" };
  if (t <= clock.timestamp * 1000) return { iso: null, reason: "next_change_not_on_clock_date" };
  return { iso: new Date(t).toISOString(), reason: null };
}

/** Tradier wraps a single result as an object and several as an array. */
function asArray<T>(v: T | T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

interface RawQuote {
  symbol?: string;
  bid?: number | null;
  ask?: number | null;
  bidsize?: number | null;
  asksize?: number | null;
  bid_date?: number | null;
  ask_date?: number | null;
}

/**
 * One quote row to a book, or a reason it is not one.
 *
 * The refusal rules match spreadHistory.observe deliberately: a crossed book
 * is a stale or malformed quote rather than a negative cost, and a one-sided
 * book cannot be crossed at any price. A snapshot admitted here that the
 * recorder would have refused would put the live spread and the measured
 * median on different samples.
 */
export function toVenueQuote(raw: RawQuote, nowMs: number): QuoteResult {
  const symbol = String(raw.symbol ?? "");
  const { bid, ask } = raw;
  if (typeof bid !== "number" || typeof ask !== "number") return { ok: false, reason: "no_quote_sides" };
  if (!(bid > 0) || !(ask > 0)) return { ok: false, reason: "one_sided_book" };
  if (ask < bid) return { ok: false, reason: "crossed_book" };

  /*
   * The OLDER side dates the book. A bid refreshed a second ago against an ask
   * last touched ten minutes back is a ten-minute-old book: crossing it means
   * lifting the ask, and that side is what is stale. Taking the newer of the
   * two would flatter every quote by exactly the amount that matters.
   */
  const stamps = [raw.bid_date, raw.ask_date].filter(
    (x): x is number => typeof x === "number" && x > 0
  );
  if (stamps.length === 0) return { ok: false, reason: "quote_undated" };
  const bookMs = Math.min(...stamps);

  return {
    ok: true,
    quote: {
      symbol,
      book: {
        bid,
        ask,
        bid_size: typeof raw.bidsize === "number" && raw.bidsize > 0 ? raw.bidsize : null,
        ask_size: typeof raw.asksize === "number" && raw.asksize > 0 ? raw.asksize : null,
        spread_bp: spreadBp(bid, ask),
        // Clamped: a few hundred ms of clock skew against the venue is not a
        // negative age, it is noise, and a negative number would read as one.
        age_seconds: Math.max(0, Math.round((nowMs - bookMs) / 1000)),
      },
      bookAsOf: new Date(bookMs).toISOString(),
    },
  };
}

/**
 * Live venue status for a set of symbols: one clock call, one quotes call.
 *
 * Symbols the venue does not quote come back in `unmatched_symbols` and are
 * recorded as such rather than silently dropped — "this venue does not trade
 * it" and "we never asked" are different answers to whether it is tradable.
 */
export async function fetchVenueStatus(symbols: string[], now = Date.now()): Promise<VenueStatus> {
  const apiKey = process.env.TRADIER_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "tradier_not_configured", configured: false };
  if (symbols.length === 0) return { ok: false, reason: "no_symbols_requested", configured: true };

  const env = tradierEnv();
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const get = async (pathname: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(`${baseUrl(env)}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Never cached. The entire value of a session state and a book age is that
    // they describe this moment; a stale one is worse than none.
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  try {
    const [clockJson, quoteJson] = await Promise.all([
      get("/v1/markets/clock", {}),
      get("/v1/markets/quotes", { symbols: symbols.join(","), greeks: "false" }),
    ]);

    const raw = (clockJson as { clock?: RawClock }).clock;
    if (!raw?.state || !raw.date) return { ok: false, reason: "clock_malformed", configured: true };
    const next = resolveNextChange(raw);

    const rows = asArray(
      (quoteJson as { quotes?: { quote?: RawQuote | RawQuote[] } }).quotes?.quote
    );
    const bySymbol = new Map<string, RawQuote>();
    for (const r of rows) if (r.symbol) bySymbol.set(String(r.symbol).toUpperCase(), r);

    const quotes = new Map<string, QuoteResult>();
    for (const s of symbols) {
      const row = bySymbol.get(s.toUpperCase());
      quotes.set(s, row ? toVenueQuote(row, now) : { ok: false, reason: "not_quoted_by_venue" });
    }

    return {
      ok: true,
      env,
      clock: {
        state: raw.state,
        nextState: raw.next_state,
        nextChangeEt: raw.next_change,
        nextChangeIso: next.iso,
        nextChangeReason: next.reason,
        asOf: new Date(raw.timestamp * 1000).toISOString(),
      },
      quotes,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      reason: `tradier_${err instanceof Error ? err.message.replace(/\s+/g, "_").toLowerCase() : "threw"}`,
    };
  }
}
