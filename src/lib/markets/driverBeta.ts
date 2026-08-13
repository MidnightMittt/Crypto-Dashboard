import { Bar } from "@/lib/research/types";

/**
 * WHAT AN INDUSTRY IS ACTUALLY LONG.
 *
 * Every other measure on the industry board is relative strength versus the
 * S&P: true, and for most industries sufficient, because software is moved by
 * software. Two industries here are not like that. Gold Miners are a
 * leveraged expression of the gold price, and the bitcoin-miner /
 * AI-datacenter names are a leveraged expression of bitcoin. For those, "+18pp
 * versus the market over a month" is a real number that answers the wrong
 * question — a reader can be right about the industry's strength and still
 * completely misunderstand the position they are taking.
 *
 * This module answers the missing question with two statistics, both plain
 * OLS over daily returns against a declared driver series:
 *
 *   RHO  — how RELIABLY the industry tracks the driver. 0.8 means the driver
 *          explains most day-to-day movement; 0.2 means the label is folklore
 *          and this industry has decoupled.
 *   BETA — how MUCH it amplifies. 2.0 means a 1% driver move has historically
 *          come with a 2% industry move. This is the sizing-relevant number
 *          and the one a correlation alone hides.
 *
 * The same pair is computed against the industry's own SECTOR, so the two can
 * be compared directly and the comparison can embarrass the taxonomy. If the
 * datacenter names ever track XLK more tightly than BTC, this read says so.
 *
 * ── The alignment trap this module exists to avoid ────────────────────
 *
 * Bitcoin trades weekends; an equity ETF does not. Joining the two on shared
 * calendar dates looks correct and silently discards every weekend move —
 * which for crypto is roughly two sevenths of all information, and precisely
 * the part that produces Monday's gap in the miners. So driver returns are
 * NOT taken from the driver's own consecutive bars. They are spanned across
 * the EQUITY session dates: Monday's driver return runs from Friday's close
 * to Monday's close, capturing the weekend, and is compared against the
 * equity's own Friday→Monday return. Same span, same clock, both sides.
 *
 * For a session-based driver like GLD this reduces exactly to the ordinary
 * date-aligned correlation, so one code path serves both without a branch.
 *
 * ── What these numbers are not ────────────────────────────────────────
 *
 * Descriptive statistics over a fixed trailing window, not predictions and
 * not a hedge ratio to trade on. A relationship measured over six months can
 * break in a week — which is why the window and the observation count travel
 * with the numbers everywhere they are displayed.
 */

/**
 * Trailing window, in EQUITY SESSIONS, matching `ROTATION_LONG_SESSIONS` in
 * rotation.ts (~six months). Deliberately the same horizon the industry's
 * long-horizon relative strength uses, so a reader comparing the two is
 * comparing measurements of the same stretch of history rather than two
 * different periods that happen to appear on one page.
 */
export const DRIVER_WINDOW_SESSIONS = 126;

/**
 * Below this many paired observations the fit is noise wearing a decimal
 * point. Returned as null rather than a low-confidence number, because a
 * printed 0.6 is believed regardless of the sample behind it.
 */
export const MIN_DRIVER_OBSERVATIONS = 40;

export interface DriverFit {
  /** Pearson correlation of daily returns, -1..1. How reliably it tracks. */
  rho: number;
  /** OLS slope: driver moves 1%, this has historically moved beta%. */
  beta: number;
  /** Paired observations behind the fit. */
  n: number;
}

export interface DriverRead {
  /** Display symbol of the driver, e.g. "BTC". */
  symbol: string;
  /** Human label, e.g. "Bitcoin". */
  label: string;
  /** Fit against the declared external driver. Null when data is too thin. */
  driver: DriverFit | null;
  /** The SAME fit against the parent sector ETF, so the two are comparable. */
  sector: DriverFit | null;
  /** The parent sector's ETF symbol, for labelling the comparison. */
  sectorSymbol: string;
  /** Equity sessions requested. The realised count is `n` on each fit. */
  windowSessions: number;
}

/** UTC calendar date of a bar, the join key for two different trading calendars. */
function dateKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Daily returns for `base`, paired with returns of `other` measured over the
 * SAME spans — see the alignment note above. Returns are simple (not log),
 * matching every other percentage on the board.
 *
 * A span is dropped entirely when either side is missing an endpoint, so a
 * driver holiday costs one observation rather than fabricating a flat day.
 */
function pairedReturns(base: Bar[], other: Bar[], windowSessions: number): Array<[number, number]> {
  const otherClose = new Map<string, number>();
  for (const b of other) otherClose.set(dateKey(b.t), b.close);

  // windowSessions RETURNS need windowSessions + 1 closes.
  const recent = base.slice(-(windowSessions + 1));
  const pairs: Array<[number, number]> = [];

  for (let i = 1; i < recent.length; i++) {
    const prevClose = recent[i - 1].close;
    const currClose = recent[i].close;
    if (prevClose <= 0 || currClose <= 0) continue;

    const dPrev = otherClose.get(dateKey(recent[i - 1].t));
    const dCurr = otherClose.get(dateKey(recent[i].t));
    if (dPrev === undefined || dCurr === undefined || dPrev <= 0 || dCurr <= 0) continue;

    pairs.push([currClose / prevClose - 1, dCurr / dPrev - 1]);
  }
  return pairs;
}

/**
 * Correlation and slope of `base` on `other`. Null when the sample is too
 * small or either side has no variance — a flat series is neither correlated
 * nor uncorrelated with anything; the question does not apply.
 */
export function fitDriver(
  base: Bar[],
  other: Bar[],
  windowSessions: number = DRIVER_WINDOW_SESSIONS
): DriverFit | null {
  const pairs = pairedReturns(base, other, windowSessions);
  const n = pairs.length;
  if (n < MIN_DRIVER_OBSERVATIONS) return null;

  const meanY = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanX = pairs.reduce((s, p) => s + p[1], 0) / n;

  let cov = 0;
  let varY = 0;
  let varX = 0;
  for (const [y, x] of pairs) {
    const dy = y - meanY;
    const dx = x - meanX;
    cov += dy * dx;
    varY += dy * dy;
    varX += dx * dx;
  }
  if (varX === 0 || varY === 0) return null;

  return {
    rho: cov / Math.sqrt(varY * varX),
    // Slope of base ON other: cov / var(other). Regressing the industry on
    // the driver, never the reverse — the driver is the explanatory series.
    beta: cov / varX,
    n,
  };
}

export interface DriverInputs {
  industryBars: Bar[];
  driverBars: Bar[] | null;
  sectorBars: Bar[] | null;
  driver: { symbol: string; label: string };
  sectorSymbol: string;
  windowSessions?: number;
}

/**
 * The full read for one industry. Null only when the industry itself has no
 * bars; a missing driver or sector series yields a null FIT rather than
 * suppressing the whole read, so a partial answer stays visible and honest.
 */
export function buildDriverRead(inputs: DriverInputs): DriverRead | null {
  const { industryBars, driverBars, sectorBars, driver, sectorSymbol } = inputs;
  const windowSessions = inputs.windowSessions ?? DRIVER_WINDOW_SESSIONS;
  if (industryBars.length === 0) return null;

  return {
    symbol: driver.symbol,
    label: driver.label,
    driver: driverBars ? fitDriver(industryBars, driverBars, windowSessions) : null,
    sector: sectorBars ? fitDriver(industryBars, sectorBars, windowSessions) : null,
    sectorSymbol,
    windowSessions,
  };
}

/** |rho| at or above which a relationship is described as dominant rather than partial. */
const STRONG_RHO = 0.6;
/** |rho| below which the declared driver is described as having decoupled. */
const WEAK_RHO = 0.3;

/**
 * The read as a sentence, in the house style: what this industry is actually
 * long, what that means for position size, and — when the data says so — that
 * the declared driver has stopped explaining it.
 *
 * Every branch is decided by the MEASURED numbers. None of them assumes the
 * driver wins, because the whole point of measuring is that it might not.
 */
export function describeDriver(read: DriverRead, industryName: string): string {
  const { driver, sector, label, sectorSymbol } = read;

  if (!driver) {
    return `Not enough overlapping history to measure ${industryName} against ${label} over the last ${read.windowSessions} sessions. No relationship is asserted without one.`;
  }

  const rho = driver.rho;
  const beta = driver.beta;
  const amplifies = beta >= 1.15;
  const damps = beta <= 0.85 && beta > 0;

  const magnitude = amplifies
    ? `and AMPLIFIES it: a 1% ${label} move has come with a ${beta.toFixed(1)}% move here`
    : damps
      ? `but damps it: a 1% ${label} move has come with only ${beta.toFixed(1)}% here`
      : `roughly one-for-one (beta ${beta.toFixed(2)})`;

  const strength =
    Math.abs(rho) >= STRONG_RHO
      ? `${industryName} tracks ${label} closely (correlation ${rho.toFixed(2)}) ${magnitude}.`
      : Math.abs(rho) >= WEAK_RHO
        ? `${industryName} tracks ${label} only partially (correlation ${rho.toFixed(2)}) ${magnitude}.`
        : `${industryName} has DECOUPLED from ${label} over this window (correlation ${rho.toFixed(2)}) — the usual explanation for this group is not currently explaining it.`;

  if (!sector) return `${strength} Measured over ${driver.n} sessions.`;

  /*
   * The comparison that makes the number actionable: a group can be highly
   * correlated to both its driver and its sector in a market where everything
   * moves together, so what matters is WHICH explains it better.
   */
  const gap = Math.abs(rho) - Math.abs(sector.rho);
  const verdict =
    gap > 0.15
      ? `That is a stronger relationship than it has with its own sector ${sectorSymbol} (${sector.rho.toFixed(2)}), so a position here is closer to a leveraged ${label} position than to a ${sectorSymbol} position — size it accordingly.`
      : gap < -0.15
        ? `Its own sector ${sectorSymbol} explains it better right now (${sector.rho.toFixed(2)} against ${rho.toFixed(2)}), which is the opposite of this group's usual behaviour and worth knowing before treating it as a ${label} proxy.`
        : `It tracks its sector ${sectorSymbol} about equally well (${sector.rho.toFixed(2)}), so neither story fully owns the move over this window.`;

  return `${strength} ${verdict} Measured over ${driver.n} sessions.`;
}
