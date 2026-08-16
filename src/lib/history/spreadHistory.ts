/**
 * EXECUTION-WINDOW SPREADS — the one thing here that cannot be backfilled by
 * anybody, at any price.
 *
 * OHLCV bars carry no quote data at any interval, so the bid-ask cost of
 * actually getting into and out of these names at the minutes that matter is
 * simply absent from history. The usual escape is the Corwin-Schultz high-low
 * estimator, and on these names it is not merely imprecise — it is wrong by
 * more than an order of magnitude, returning 114-177bp where the observed book
 * is one tick. Measured 2026-08-16 against live quotes:
 *
 *   APLD  31.19 / 31.20   1 tick    3.21bp
 *   IREN  44.16 / 44.17   1 tick    2.26bp
 *   CLSK  12.07 / 12.08   1 tick    8.28bp
 *   RIOT  19.02 / 19.08   6 ticks  31.50bp
 *
 * Three of those four figures were recorded a factor of ten low until
 * 2026-08-16: the fraction was carried into the table as though a percent
 * were a basis point, so APLD's 0.0321% was written as 0.32bp rather than
 * 3.21bp. RIOT alone was converted correctly, which is precisely why the
 * error survived — one plausible outlier beside three numbers that were all
 * wrong the same way looks like a spread of spreads. The conclusion does not
 * move: 114-177bp modelled against a 2-8bp book is still an order of
 * magnitude and then some. But the numbers a reader checks against are now
 * the ones spreadBp() actually returns, and a test pins them.
 *
 * Corwin-Schultz is biased upward under high volatility, and these are among
 * the most volatile names in the panel, so the estimator fails hardest
 * exactly where it would be used. A modelled spread presented as a measured
 * one would turn a real edge into a fictional one in either direction, which
 * is why `net_edge` is null until this store has data rather than falling
 * back to an estimate.
 *
 * A session not captured is a session lost forever. That is the whole
 * argument for recording it server-side on a schedule.
 */

/** The two windows that decide an overnight trade's cost. */
export type ExecutionWindow = "entry" | "exit";

/**
 * Target capture minutes, in US/Eastern wall clock. Chosen to bracket the
 * close and the opening auction's settling rather than to sample evenly:
 * the entry window is the last liquid minutes before the close, the exit
 * window is after the opening auction has stopped printing crossed books.
 */
export const CAPTURE_MINUTES: Record<ExecutionWindow, string[]> = {
  entry: ["15:50", "15:54", "15:58"],
  exit: ["09:35", "09:40", "09:45", "09:50"],
};

export interface SpreadObservation {
  /** ISO instant of the capture, UTC. */
  t: string;
  /** ISO date of the US trading session, in Eastern terms. */
  session: string;
  symbol: string;
  window: ExecutionWindow;
  /** The ET wall-clock minute this capture was aiming at, e.g. "15:50". */
  targetMinute: string;
  bid: number;
  ask: number;
  mid: number;
  /** (ask - bid) / mid, in basis points. */
  spreadBp: number;
  last: number | null;
}

export interface SpreadHistory {
  version: 1;
  generatedAt: number;
  observations: SpreadObservation[];
}

export const EMPTY_SPREAD_HISTORY: SpreadHistory = {
  version: 1,
  generatedAt: 0,
  observations: [],
};

/** One US cent, the minimum tick for every name in scope above $1. */
export const TICK = 0.01;

/**
 * (ask − bid) / mid, in basis points. ONE definition.
 *
 * Exported rather than inlined because the live pre-trade book quotes a
 * spread from the same venue this store records, and two spellings of the
 * same formula — one over the mid, one over the last — would put the snapshot
 * and the recorded median on different scales while both were labelled "bp".
 */
export function spreadBp(bid: number, ask: number): number {
  return ((ask - bid) / ((bid + ask) / 2)) * 10_000;
}

/**
 * Build one observation, or refuse.
 *
 * Refuses rather than records when the book is crossed, zero-width, or
 * missing a side. A crossed book is a stale or malformed quote, not a
 * negative spread, and averaging one into a median would quietly pull the
 * measured cost below what anybody can actually trade.
 */
export function observe(input: {
  t: Date;
  session: string;
  symbol: string;
  window: ExecutionWindow;
  targetMinute: string;
  bid: number | null | undefined;
  ask: number | null | undefined;
  last: number | null | undefined;
}): SpreadObservation | null {
  const { bid, ask } = input;
  if (typeof bid !== "number" || typeof ask !== "number") return null;
  if (!(bid > 0) || !(ask > 0)) return null;
  if (ask < bid) return null; // crossed: stale or malformed, never a real negative cost
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return {
    t: input.t.toISOString(),
    session: input.session,
    symbol: input.symbol,
    window: input.window,
    targetMinute: input.targetMinute,
    bid,
    ask,
    mid,
    spreadBp: spreadBp(bid, ask),
    last: typeof input.last === "number" && input.last > 0 ? input.last : null,
  };
}

const keyOf = (o: SpreadObservation): string =>
  `${o.symbol}|${o.session}|${o.window}|${o.targetMinute}`;

/**
 * Append, replacing any capture already held for the same symbol, session,
 * window and target minute. Idempotent so a retried job cannot double-weight
 * one minute in the median.
 */
export function appendObservations(
  existing: SpreadObservation[],
  fresh: SpreadObservation[]
): SpreadObservation[] {
  const byKey = new Map(existing.map((o) => [keyOf(o), o]));
  for (const o of fresh) byKey.set(keyOf(o), o);
  return [...byKey.values()].sort((a, b) => a.t.localeCompare(b.t) || a.symbol.localeCompare(b.symbol));
}

export interface WindowSummary {
  window: ExecutionWindow;
  /** Distinct trading sessions observed — the honest sample size. */
  sessions: number;
  /** Individual captures. Several per session, so never the sample size. */
  observations: number;
  medianBp: number | null;
  p90Bp: number | null;
  /**
   * Share of SESSIONS whose typical book was one tick wide. Computed per
   * session and then averaged across sessions, not across raw captures — a
   * session with four captures must not outvote one with three.
   */
  oneTickSessionShare: number | null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const median = (xs: number[]): number => quantile([...xs].sort((a, b) => a - b), 0.5);

/**
 * Summarise one symbol's captures in one window.
 *
 * The per-session grouping is load-bearing. Captures within a session are
 * highly correlated — the same book, minutes apart — so treating each as an
 * independent observation would overstate the sample by the number of
 * capture minutes and make a week of data look like a month of it.
 */
export function summariseWindow(
  observations: SpreadObservation[],
  symbol: string,
  window: ExecutionWindow
): WindowSummary {
  const mine = observations.filter((o) => o.symbol === symbol && o.window === window);
  if (mine.length === 0) {
    return { window, sessions: 0, observations: 0, medianBp: null, p90Bp: null, oneTickSessionShare: null };
  }

  const bySession = new Map<string, SpreadObservation[]>();
  for (const o of mine) bySession.set(o.session, [...(bySession.get(o.session) ?? []), o]);

  /** One number per session: that session's typical book in the window. */
  const perSessionBp: number[] = [];
  let oneTickSessions = 0;
  for (const [, rows] of bySession) {
    perSessionBp.push(median(rows.map((r) => r.spreadBp)));
    // A half-tick of tolerance absorbs float noise in (ask - bid).
    if (median(rows.map((r) => r.ask - r.bid)) <= TICK * 1.5) oneTickSessions++;
  }

  const sorted = [...perSessionBp].sort((a, b) => a - b);
  return {
    window,
    sessions: bySession.size,
    observations: mine.length,
    medianBp: quantile(sorted, 0.5),
    p90Bp: quantile(sorted, 0.9),
    oneTickSessionShare: (oneTickSessions / bySession.size) * 100,
  };
}

/**
 * Below this many SESSIONS a window's cost is not quotable. Round-trip cost
 * decides whether an edge survives, so quoting it from three days of quotes
 * would be worse than admitting it is not measured yet.
 */
export const MIN_SPREAD_SESSIONS = 20;

export interface RoundTripCost {
  /** Entry half plus exit half, in basis points. */
  bp: number | null;
  reason: string | null;
  entry: WindowSummary;
  exit: WindowSummary;
}

/**
 * The measured round trip: crossing the spread at entry and again at exit.
 *
 * Half the spread per leg is the mid-to-touch cost of a marketable order, so
 * a full round trip is one entry spread plus one exit spread in total. Null
 * with a reason until BOTH windows clear the session minimum — a round trip
 * measured on one leg is not a round trip.
 */
export function roundTripCostBp(
  observations: SpreadObservation[],
  symbol: string
): RoundTripCost {
  const entry = summariseWindow(observations, symbol, "entry");
  const exit = summariseWindow(observations, symbol, "exit");

  if (entry.sessions < MIN_SPREAD_SESSIONS || exit.sessions < MIN_SPREAD_SESSIONS) {
    return {
      bp: null,
      reason: "no_spread_history",
      entry,
      exit,
    };
  }
  return { bp: (entry.medianBp ?? 0) + (exit.medianBp ?? 0), reason: null, entry, exit };
}

/** Keep the artefact bounded; captures are small but daily and forever. */
export const MAX_OBSERVATIONS_PER_SYMBOL = 5_000;

export function pruneObservations(
  observations: SpreadObservation[],
  cap = MAX_OBSERVATIONS_PER_SYMBOL
): SpreadObservation[] {
  const bySymbol = new Map<string, SpreadObservation[]>();
  for (const o of observations) bySymbol.set(o.symbol, [...(bySymbol.get(o.symbol) ?? []), o]);
  const kept: SpreadObservation[] = [];
  for (const [, rows] of bySymbol) {
    const sorted = [...rows].sort((a, b) => a.t.localeCompare(b.t));
    kept.push(...sorted.slice(Math.max(0, sorted.length - cap)));
  }
  return kept.sort((a, b) => a.t.localeCompare(b.t) || a.symbol.localeCompare(b.symbol));
}
