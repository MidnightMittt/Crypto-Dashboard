/**
 * GeckoTerminal client — volume windows, reserve, and TOKEN-RATIO sigma.
 *
 * ~10 requests/minute; every caller backs off on 429 rather than hammering.
 * The one rule that matters here: OHLCV is fetched with `currency=token`, so
 * sigma is measured on the token RATIO. Measured on a USD leg of a stable-base
 * pair it reads the stablecoin's volatility instead, which once printed a
 * coverage of 766x. The parameter is not an option, it is the point.
 *
 * Everything returned carries `source: "geckoterminal"` — these are API
 * figures, not chain-verified ones, and consumers label them as such.
 */

const BASE = "https://api.geckoterminal.com/api/v2";
const UA = "leverage-terminal/1.0";

async function gt(path: string, attempt = 0): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 7000 * (attempt + 1)));
    return gt(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`geckoterminal ${path}: HTTP ${res.status}`);
  return res.json();
}

export interface PoolStats {
  vol6hUsd: number | null;
  vol24hUsd: number | null;
  reserveUsd: number | null;
  /** USD price of the pool's quote token (the WETH/ETH leg), for valuing amounts. */
  quoteTokenUsd: number | null;
  source: "geckoterminal";
}

export async function poolStats(network: string, pool: string): Promise<PoolStats> {
  const body = (await gt(`/networks/${network}/pools/${pool}`)) as {
    data?: { attributes?: Record<string, unknown> };
  };
  const a = body.data?.attributes ?? {};
  const vol = (a.volume_usd ?? {}) as Record<string, string>;
  const num = (x: unknown): number | null => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    vol6hUsd: num(vol.h6),
    vol24hUsd: num(vol.h24),
    reserveUsd: num(a.reserve_in_usd),
    quoteTokenUsd: num(a.quote_token_price_usd),
    source: "geckoterminal",
  };
}

export interface RatioSigma {
  sigmaDaily: number;
  windowHours: number;
  candles: number;
  source: "geckoterminal ohlcv currency=token";
}

/** Minimum hourly candles before a sigma is worth stating. */
export const MIN_CANDLES = 24;

/** Daily sigma of the pool's token ratio from hourly candles. */
export async function ratioSigma(network: string, pool: string, hours = 72): Promise<RatioSigma | null> {
  const body = (await gt(
    `/networks/${network}/pools/${pool}/ohlcv/hour?aggregate=1&limit=${hours}&currency=token`
  )) as { data?: { attributes?: { ohlcv_list?: [number, number, number, number, number, number][] } } };
  const rows = body.data?.attributes?.ohlcv_list ?? [];
  // GT returns newest first; closes oldest-first for the return series.
  const closes = rows
    .map((r) => r[4])
    .reverse()
    .filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < MIN_CANDLES) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const variance = rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1);
  return {
    sigmaDaily: Math.sqrt(variance) * Math.sqrt(24),
    windowHours: closes.length,
    candles: closes.length,
    source: "geckoterminal ohlcv currency=token",
  };
}
