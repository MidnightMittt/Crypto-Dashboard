import { atr } from "@/lib/technicals/indicators";
import { Bar } from "./types";

/**
 * ONE LINE, IN DOLLARS: below this, the trend is over.
 *
 * The failure this exists to prevent is not analytical, it is behavioural. An
 * exit taken nervously, mid-session, with no reference level on screen, is a
 * decision made by the tape rather than by a rule — and the cost of not having
 * the number visible is the difference between the price you took and the
 * price the rule would have taken.
 *
 * So this produces exactly one figure a trader can hold in their head:
 *
 *   trail = highest close since entry (or over the lookback) − k × ATR
 *
 * ── ATR, never a percentage ──────────────────────────────────────────
 *
 * A 5% trailing stop is a different instrument on every name. On the miners
 * and datacenter names in this universe, daily ATR runs 8-15% of price, so a
 * 5% trail sits INSIDE one ordinary session's range — it is not a stop, it is
 * a guarantee of being shaken out by noise. Expressed in ATR the same
 * multiple means the same thing everywhere: 1.5 ATR is a session and a half
 * of normal movement, whether that is 1.4% on SPY or 13% on CORZ.
 *
 * That is the same argument the stop-viability grid makes with survival rates,
 * arrived at from the other direction, and the two should agree: a name whose
 * grid shows no viable stop under 15% will show a wide dollar trail here.
 *
 * ── Trailing HIGH, and why closes ────────────────────────────────────
 *
 * The high is taken on CLOSES, not intraday highs. An intraday spike ratchets
 * the trail up to a level the position never actually held, and the next
 * ordinary session then breaches it — the trail would tighten on a wick and
 * stop out on nothing. Closes only move the line when the move was held into
 * the bell.
 */

/**
 * Sessions of normal movement given up before the trend is called over.
 *
 * 1.5 is not optimised and is not claimed to be: it is a session and a half of
 * this name's own range, which is wide enough that an ordinary day cannot
 * breach it and tight enough to matter. Stated as a constant so it can be
 * argued with rather than discovered in a formula.
 */
export const TRAIL_ATR_MULTIPLE = 1.5;

/** Wilder period, matching the ATR every other module here uses. */
const ATR_PERIOD = 14;

/** Sessions the trailing high is taken over when no entry is supplied. */
export const DEFAULT_LOOKBACK = 60;

export interface TrendState {
  symbol: string;
  /** Latest close, the number the line is compared against. */
  price: number;
  /** THE LINE. Below this, the trend is over. In dollars. */
  trailStop: number;
  /** Highest CLOSE the trail is measured down from. */
  trailingHigh: number;
  /** One session of this name's own range, in dollars. */
  atr: number;
  /** ATR as a share of price, so the reader can see why percent trails fail. */
  atrPct: number;
  /** Dollars between price and the line. Negative means already through it. */
  roomUsd: number;
  /** The same distance in ATR, which is the unit that travels between names. */
  roomAtr: number;
  intact: boolean;
  /** Sessions the trailing high was taken over. */
  lookback: number;
  /** One sentence naming the level. Never a bare percentage. */
  sentence: string;
}

/**
 * The trend line for one symbol.
 *
 * Bars must be corporate-action adjusted: an unadjusted split halves the close
 * and would place the line above the price, reporting a broken trend on a
 * name that never moved.
 *
 * `entryIndex`, when supplied, measures the trailing high from the entry
 * forward — the correct behaviour for a position already held, because a high
 * made before you owned it is not a high you had the chance to sell into.
 */
export function trendState(
  symbol: string,
  bars: readonly Bar[],
  opts: { lookback?: number; entryIndex?: number; multiple?: number } = {}
): TrendState | null {
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const k = opts.multiple ?? TRAIL_ATR_MULTIPLE;
  if (bars.length < ATR_PERIOD + 2) return null;

  const a = atr(
    bars.map((b) => ({
      t: b.t,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volumeUsd: (b.volume ?? 0) * b.close,
    })),
    ATR_PERIOD
  );
  if (a === null || !(a > 0)) return null;

  const price = bars[bars.length - 1].close;
  if (!(price > 0)) return null;

  const from =
    opts.entryIndex !== undefined
      ? Math.max(0, Math.min(opts.entryIndex, bars.length - 1))
      : Math.max(0, bars.length - lookback);
  const window = bars.slice(from);
  const trailingHigh = Math.max(...window.map((b) => b.close));

  const trailStop = trailingHigh - k * a;
  const roomUsd = price - trailStop;

  return {
    symbol,
    price,
    trailStop,
    trailingHigh,
    atr: a,
    atrPct: (a / price) * 100,
    roomUsd,
    roomAtr: roomUsd / a,
    intact: price > trailStop,
    lookback: window.length,
    sentence: describe(symbol, price, trailStop, a, roomUsd / a, k),
  };
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

function describe(
  symbol: string,
  price: number,
  stop: number,
  atrUsd: number,
  roomAtr: number,
  k: number
): string {
  const atrPct = (atrUsd / price) * 100;
  const scale =
    `One ordinary session in ${symbol} is ${money(atrUsd)} (${atrPct.toFixed(1)}% of price), ` +
    `so a percentage trail tight enough to feel safe would sit inside a single day's range.`;

  if (price <= stop) {
    return (
      `Below ${money(stop)} the trend is over — and ${symbol} is already there at ${money(price)}. ` +
      `${scale} The line is the trailing high less ${k} ATR.`
    );
  }
  return (
    `Below ${money(stop)} the trend is over. ${symbol} is at ${money(price)}, ` +
    `${roomAtr.toFixed(1)} ATR above the line. ${scale}`
  );
}
