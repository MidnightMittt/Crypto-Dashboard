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
 * ── One fetched expiration ────────────────────────────────────────────
 *
 * The chain endpoint is per-expiration, so this fetches only the NEAREST
 * listed expiry rather than walking all 20-odd of them. That is deliberate:
 * the cross-venue check compares like-for-like on a single shared
 * expiration, and the front expiry is where gamma and flow concentrate.
 * Sandbox data is 15-minute delayed — the same delay CBOE publishes, so the
 * two snapshots are contemporaneous.
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
  strike?: number;
  option_type?: "call" | "put";
  expiration_date?: string;
  open_interest?: number;
  volume?: number;
  greeks?: TradierGreeks;
}

export type TradierChainResult =
  | { ok: true; spot: number; expiry: string; contracts: ParsedContract[] }
  | { ok: false; reason: string };

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

export async function fetchTradierChain(symbol: string): Promise<TradierChainResult> {
  const apiKey = process.env.TRADIER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, reason: "Tradier is not configured (no TRADIER_API_KEY), so the chain has one venue rather than two." };
  }

  try {
    // Spot and the nearest expiration, in parallel.
    const [quoteJson, expJson] = await Promise.all([
      tradierGet("/v1/markets/quotes", { symbols: symbol }, apiKey),
      tradierGet("/v1/markets/options/expirations", { symbol, includeAllRoots: "true" }, apiKey),
    ]);

    const quote = asArray(
      (quoteJson as { quotes?: { quote?: unknown } })?.quotes?.quote as { last?: number } | { last?: number }[]
    )[0] as { last?: number } | undefined;
    const spot = quote?.last;
    if (typeof spot !== "number" || spot <= 0) {
      return { ok: false, reason: `Tradier returned no quote for ${symbol}.` };
    }

    const expirations = asArray(
      (expJson as { expirations?: { date?: string | string[] } })?.expirations?.date
    );
    const nearest = [...expirations].sort()[0];
    if (!nearest) {
      return { ok: false, reason: `Tradier lists no option expirations for ${symbol}.` };
    }

    const chainJson = await tradierGet(
      "/v1/markets/options/chains",
      { symbol, expiration: nearest, greeks: "true" },
      apiKey
    );
    const rows = asArray((chainJson as { options?: { option?: TradierOption | TradierOption[] } })?.options?.option);
    const contracts = rows.map(toParsedContract).filter((c): c is ParsedContract => c !== null);
    if (contracts.length === 0) {
      return { ok: false, reason: `Tradier returned no usable contracts for ${symbol} at ${nearest}.` };
    }

    return { ok: true, spot, expiry: nearest, contracts };
  } catch (err) {
    return { ok: false, reason: `Tradier could not be reached (${err instanceof Error ? err.message : "unknown"}).` };
  }
}
