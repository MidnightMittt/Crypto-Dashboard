import { ParsedContract } from "./cboeOptions";

/**
 * OPTIONS — TRADIER, the second venue.
 *
 * CBOE is the primary options source; this is the corroborator. Tradier
 * serves a full chain with greeks and implied vol computed by ORATS — a
 * different vendor running a different solver on a different quote snapshot
 * than CBOE's exchange-published greeks. That independence is the whole
 * point: a gamma sign or an implied-vol level that BOTH venues report is far
 * harder to dismiss as one vendor's modelling artefact than the same number
 * from CBOE alone.
 *
 * ── Keyed, and absent by default ──────────────────────────────────────
 *
 * Unlike every other provider on the research page, this one needs a key
 * (TRADIER_API_KEY). With no key it returns a plain "not configured" — the
 * options section then stands on CBOE alone, exactly as it did before, with
 * no cross-venue line. That is the graceful-degradation contract: a second
 * venue deepens the read where it is available and is silently absent where
 * it is not.
 *
 * ── Two fetched expirations, not twenty ───────────────────────────────
 *
 * The chain endpoint is per-expiration, and walking all 20-odd listed
 * expiries would cost 20 round trips for questions nobody asked. Two are
 * fetched, each answering something different: the FRONT expiry, where gamma
 * and flow concentrate and where the cross-venue check compares like for
 * like; and the first expiry at least three weeks out, the conventional
 * horizon an expected move is quoted over. Sandbox data is 15-minute
 * delayed — the same delay CBOE publishes, so the two venues' snapshots are
 * contemporaneous and comparable.
 */

interface TradierGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  mid_iv?: number;
  smv_vol?: number;
}

interface TradierOption {
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  average_volume?: number | null;
  strike?: number;
  option_type?: "call" | "put";
  expiration_date?: string;
  open_interest?: number;
  volume?: number;
  greeks?: TradierGreeks;
}

/**
 * A chain for ONE expiration, plus the calendar around it.
 *
 * Options intelligence needs more than the front week: expected move is a
 * monthly question, max pain and gamma walls concentrate at monthly
 * expirations, and skew is only comparable within a single expiry. So the
 * fetch below returns several, and the pure module decides which question
 * each one answers.
 */
export interface TradierExpiryChain {
  expiry: string;
  contracts: ParsedContract[];
  /** Raw rows, kept because intelligence needs bid/ask and average volume. */
  rows: TradierOptionRow[];
}

export interface TradierOptionRow {
  strike: number;
  kind: "call" | "put";
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number;
  averageVolume: number;
  openInterest: number;
  iv: number | null;
  gamma: number | null;
  delta: number | null;
}

export type TradierChainsResult =
  | { ok: true; spot: number; expirations: string[]; chains: TradierExpiryChain[] }
  /*
   * `configured` separates two failures the page must not conflate: no key at
   * all (a sourcing gap that will never fix itself on a reload) versus a
   * configured venue that hiccuped this request (likely back next load). The
   * dossier maps them to different blockedBy values, so a reader can tell
   * whether to wait or whether the data was never wired.
   */
  | { ok: false; reason: string; configured: boolean };

function baseUrl(): string {
  const env = (process.env.TRADIER_ENV || "sandbox").trim().toLowerCase();
  return env === "production" ? "https://api.tradier.com" : "https://sandbox.tradier.com";
}

async function tradierGet(pathname: string, params: Record<string, string>, apiKey: string): Promise<unknown> {
  const url = new URL(`${baseUrl()}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    // Sandbox data is 15-minute delayed; match CBOE's own revalidation window.
    next: { revalidate: 900 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Tradier wraps single results as an object and multiples as an array. */
function asArray<T>(v: T | T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

/** Map one Tradier row to the shared ParsedContract, or null if unusable. */
export function toParsedContract(o: TradierOption): ParsedContract | null {
  if (
    typeof o.strike !== "number" ||
    (o.option_type !== "call" && o.option_type !== "put") ||
    !o.expiration_date
  ) {
    return null;
  }
  return {
    expiry: o.expiration_date,
    kind: o.option_type,
    strike: o.strike,
    // ORATS mid IV, already a decimal (0.67); summariseParsed normalises to percent.
    iv: o.greeks?.mid_iv ?? 0,
    gamma: o.greeks?.gamma ?? 0,
    openInterest: o.open_interest ?? 0,
    volume: o.volume ?? 0,
  };
}

/** Map a raw Tradier row onto the richer shape intelligence needs. */
function toRow(o: TradierOption): TradierOptionRow | null {
  if (typeof o.strike !== "number" || (o.option_type !== "call" && o.option_type !== "put") || !o.expiration_date) {
    return null;
  }
  return {
    strike: o.strike,
    kind: o.option_type,
    expiry: o.expiration_date,
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    last: o.last ?? null,
    volume: o.volume ?? 0,
    averageVolume: o.average_volume ?? 0,
    openInterest: o.open_interest ?? 0,
    iv: o.greeks?.mid_iv ?? null,
    gamma: o.greeks?.gamma ?? null,
    delta: o.greeks?.delta ?? null,
  };
}

/**
 * Several expirations in one call set.
 *
 * `wanted` expirations are picked by the caller's rule rather than "the
 * first N": a front week and a ~monthly are different instruments answering
 * different questions, and grabbing whatever happened to be listed first
 * would make the monthly figures depend on the day of the week.
 */
export async function fetchTradierChains(symbol: string, maxExpiries = 3): Promise<TradierChainsResult> {
  const apiKey = process.env.TRADIER_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      reason: "Tradier is not configured (no TRADIER_API_KEY), so no options intelligence can be computed.",
    };
  }
  try {
    const [quoteJson, expJson] = await Promise.all([
      tradierGet("/v1/markets/quotes", { symbols: symbol }, apiKey),
      tradierGet("/v1/markets/options/expirations", { symbol, includeAllRoots: "true" }, apiKey),
    ]);
    const quote = asArray(
      (quoteJson as { quotes?: { quote?: unknown } })?.quotes?.quote as { last?: number } | { last?: number }[]
    )[0] as { last?: number } | undefined;
    const spot = quote?.last;
    if (typeof spot !== "number" || spot <= 0) return { ok: false, configured: true, reason: `Tradier returned no quote for ${symbol}.` };

    const expirations = asArray(
      (expJson as { expirations?: { date?: string | string[] } })?.expirations?.date
    ).sort();
    if (expirations.length === 0) return { ok: false, configured: true, reason: `Tradier lists no option expirations for ${symbol}.` };

    /*
     * THREE EXPIRIES, each answering a different question:
     *
     *  [0]  the true nearest — needed so the cross-venue check compares
     *       like for like against CBOE's nearest, even when that is 0DTE.
     *  ≥2d  the near-dated book people actually hold. Distinct from [0]
     *       because on expiry day the front chain is same-session churn,
     *       not positioning — see MIN_DAYS_TO_EXPIRY in the intelligence
     *       module, which excludes it from every aggregate.
     *  ≥21d the conventional monthly horizon an expected move is quoted
     *       over, so the figure does not depend on the day of the week.
     *
     * Each falls back to the furthest listed, which keeps short-dated-only
     * names working; the Set collapses the duplicates that produces.
     */
    const now = Date.now();
    const daysOut = (d: string) => (Date.parse(`${d}T00:00:00Z`) - now) / 86_400_000;
    const last = expirations[expirations.length - 1];
    const nearTerm = expirations.find((d) => daysOut(d) >= 2) ?? last;
    const monthly = expirations.find((d) => daysOut(d) >= 21) ?? last;
    const wanted = [...new Set([expirations[0], nearTerm, monthly])].slice(0, maxExpiries);

    const chains: TradierExpiryChain[] = [];
    for (const expiry of wanted) {
      const chainJson = await tradierGet(
        "/v1/markets/options/chains",
        { symbol, expiration: expiry, greeks: "true" },
        apiKey
      );
      const raw = asArray((chainJson as { options?: { option?: TradierOption | TradierOption[] } })?.options?.option);
      const rows = raw.map(toRow).filter((r): r is TradierOptionRow => r !== null);
      const contracts = raw.map(toParsedContract).filter((c): c is ParsedContract => c !== null);
      if (rows.length > 0) chains.push({ expiry, contracts, rows });
    }
    if (chains.length === 0) return { ok: false, configured: true, reason: `Tradier returned no usable contracts for ${symbol}.` };

    return { ok: true, spot, expirations, chains };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      reason: `Tradier could not be reached (${err instanceof Error ? err.message : "unknown"}).`,
    };
  }
}
