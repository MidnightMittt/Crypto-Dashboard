import { IvPoint } from "./ivTermStructure";

/**
 * THE ATM TERM STRUCTURE, from a chain already in hand.
 *
 * CBOE's delayed endpoint returns EVERY listed expiry in one response, and
 * the recorder already fetches it — `fetchOptionsSummary` hands back the
 * parsed contracts alongside its nearest-expiry summary. So a full curve
 * costs no additional request, no additional rate limit and no additional
 * latency. It was always there; only the nearest expiry was being read.
 *
 * Provider-agnostic on purpose: it takes the three fields any chain has, so
 * Tradier's rows feed it as readily as CBOE's, and `ivTermStructure` below it
 * stays pure arithmetic that has never heard of a vendor.
 */

/** The minimum any chain row must supply. Both providers already do. */
export interface ChainRow {
  /** YYYY-MM-DD. */
  expiry: string;
  strike: number;
  /** Implied vol as a DECIMAL (0.85 = 85%), the convention both providers emit. */
  iv: number;
}

/**
 * Strikes within this fraction of spot count as at-the-money.
 *
 * 5%, matching ATM_BAND_PCT in the CBOE provider. Deliberately the same
 * number: two definitions of "at the money" on one site would make the
 * recorded series and the rendered figure disagree for reasons no reader
 * could see.
 */
export const ATM_BAND_PCT = 0.05;

/**
 * Expiries at or inside this many days are dropped.
 *
 * Same 0DTE exclusion both provider paths already apply. Expiry-day vol is
 * pinning and gamma, not a view on the future, and letting it anchor the
 * near end of the curve would drag every interpolation with it.
 */
const MIN_DTE = 1;

/** Calendar days from `now` to an expiry date, at UTC midnight. */
function daysTo(expiry: string, now: number): number {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - now) / 86_400_000);
}

/**
 * One ATM implied-vol point per listed expiry, oldest first.
 *
 * Each point averages the nonzero IVs of every strike inside the band, which
 * smooths the call/put asymmetry at a single strike without reaching for a
 * skew model. An expiry with no usable quote inside the band is omitted
 * rather than filled — a missing rung is a gap in the curve, and
 * `ivAtDte` refuses to interpolate across a range it cannot see.
 */
export function atmCurve(rows: readonly ChainRow[], spot: number, now = Date.now()): IvPoint[] {
  if (!Number.isFinite(spot) || spot <= 0) return [];

  const byExpiry = new Map<string, number[]>();
  for (const r of rows) {
    if (!Number.isFinite(r.iv) || r.iv <= 0) continue;
    if (!Number.isFinite(r.strike) || r.strike <= 0) continue;
    if (Math.abs(r.strike - spot) / spot > ATM_BAND_PCT) continue;
    const dte = daysTo(r.expiry, now);
    if (!Number.isFinite(dte) || dte < MIN_DTE) continue;

    const bucket = byExpiry.get(r.expiry);
    if (bucket) bucket.push(r.iv);
    else byExpiry.set(r.expiry, [r.iv]);
  }

  return [...byExpiry.entries()]
    .map(([expiry, ivs]) => ({
      dte: daysTo(expiry, now),
      // Decimal in, percent out — the unit `ivTermStructure` declares. Not
      // inferred from magnitude: guessing whether a figure was already scaled
      // reported 3% for a stock implying 335%.
      ivPct: (ivs.reduce((s, v) => s + v, 0) / ivs.length) * 100,
    }))
    .sort((a, b) => a.dte - b.dte);
}
