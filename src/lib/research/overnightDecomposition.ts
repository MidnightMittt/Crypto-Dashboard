import { Bar } from "./types";

/**
 * OVERNIGHT vs INTRADAY — splitting the day where the strategy splits it.
 *
 * A daily return is two different trades welded together:
 *
 *   overnight = open_t / close_(t-1) - 1     held through the gap, no tape
 *   intraday  = close_t / open_t - 1         held through the session
 *
 * The engine has only ever measured their sum, which is the one quantity that
 * describes neither. This module measures each leg on its own terms.
 *
 * ── Why the cost model is per-TICK and not per-basis-point ────────────
 *
 * The US minimum tick is one cent regardless of price, so an identical
 * crossing costs wildly different amounts depending on the name:
 *
 *   $2 stock   0.01 / 2.00  = 50.0bp per tick
 *   $12 stock  0.01 / 12.00 =  8.3bp per tick
 *   $30 stock  0.01 / 30.00 =  3.3bp per tick
 *
 * A flat "10bp round trip" assumption — the kind sitting in most backtests,
 * including this repository's own equity replay — therefore understates the
 * cost on cheap names by an order of magnitude and overstates it on dear
 * ones. Since the whole question is which names carry a premium NET of
 * getting in and out, a flat charge does not merely add noise: it reorders
 * the ranking. Cost is charged against each session's own prior close.
 *
 * ── This cost is a MODEL, and it is meant to be replaced ──────────────
 *
 * `tickCostBp` assumes a book some number of ticks wide. That is an
 * assumption, not an observation, and it is exactly what spreadHistory.ts is
 * being recorded to supersede. Once both execution windows have enough
 * sessions, `roundTripCostBp` returns a MEASURED cost and this estimate
 * should give way to it. Until then every net figure here is explicitly
 * `costBasis: "modelled"`, so nothing downstream can mistake the two.
 *
 * ── Independence, for once ────────────────────────────────────────────
 *
 * Overnight returns on consecutive sessions do not overlap: each uses one
 * close and the next open, and no bar contributes to two observations. So
 * unlike almost every other statistic in this codebase, n really is the
 * effective sample and no overlap correction is owed. Cross-sectional
 * correlation between symbols is a separate matter and bites the RANKING,
 * which is why the family is FDR-corrected rather than sorted by t.
 */

/** Sessions below this and a window is not reported at all. */
export const MIN_SESSIONS = 60;

/**
 * THE CENTRAL COST: one tick per round trip.
 *
 * Buy at the ask and sell at the bid with price unchanged and you are out
 * the spread exactly once — half at entry, half at exit. On a one-tick book
 * that is $0.01 total, not $0.02. This is the physically correct charge and
 * therefore the declared basis for the test.
 *
 * It was 2 until 2026-08-16, documented as "deliberately pessimistic". That
 * was a defensible choice for a sensitivity but it was the ONLY figure the
 * artefact published, so a central estimate was being reported as though it
 * were the expected cost. The same off-by-a-factor-of-two lived in
 * spreadHistory.roundTripCostBp, where it was not deliberate at all.
 */
export const ROUND_TRIP_TICKS_CENTRAL = 1;

/**
 * THE UPPER BOUND: two ticks, charging a full spread on each leg.
 *
 * What a round trip costs if every fill is at the touch on both sides with
 * no price improvement anywhere. Reported as a SENSITIVITY beside the
 * central case, and deliberately NOT entered into the FDR family — it is the
 * same hypothesis under a different cost assumption, not a second hypothesis,
 * and counting it twice would make the correction stricter for no reason.
 */
export const ROUND_TRIP_TICKS_CONSERVATIVE = 2;

/** The declared basis for every headline figure. */
export const ROUND_TRIP_TICKS = ROUND_TRIP_TICKS_CENTRAL;

/** The US minimum price increment above $1. */
export const TICK = 0.01;

/**
 * A gap longer than this between consecutive bars is not an overnight hold.
 * Weekends and holidays are fine; a fortnight is a halt, a suspension or a
 * hole in the data, and treating it as one night's return would import a
 * multi-week move into a distribution of overnight moves.
 */
export const MAX_GAP_DAYS = 5;

export interface LegStats {
  /** Mean return per observation, in basis points. */
  meanBp: number;
  /** Sample standard deviation of the per-observation return, in bp. */
  sdBp: number;
  /** mean / (sd / sqrt(n)). Not a p-value; see pValue. */
  tStat: number;
  /** Two-sided, from the t distribution approximated by the normal at these n. */
  pValue: number;
  /** Per-observation mean/sd, and the same annualised at 252 sessions. */
  sharpe: number;
  sharpeAnnualised: number;
  n: number;
}

export interface WindowResult {
  sessions: number;
  /** Observations actually used, after gap and validity filtering. */
  used: number;
  overnightGross: LegStats | null;
  overnightNet: LegStats | null;
  intradayGross: LegStats | null;
  /** Modelled round-trip cost actually charged, averaged over the window. */
  meanCostBp: number | null;
  /** Always "modelled" here. Measured costs come from spreadHistory. */
  costBasis: "modelled";
  /** Observations dropped because the calendar gap was too long. */
  droppedGaps: number;
}

const erf = (x: number): number => {
  // Abramowitz & Stegun 7.1.26, max error 1.5e-7 — ample for a p-value.
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
};

/** Two-sided normal tail. At n >= 60 the t and normal agree to well under a percent. */
function twoSidedP(t: number): number {
  return 1 - erf(Math.abs(t) / Math.SQRT2);
}

export function summariseSeries(returnsBp: number[]): LegStats | null {
  const n = returnsBp.length;
  if (n < 2) return null;
  const mean = returnsBp.reduce((s, x) => s + x, 0) / n;
  const variance = returnsBp.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  /*
   * FLOAT NOISE IS NOT DISPERSION, and testing `sd > 0` is not enough.
   *
   * A constant series does not produce sd exactly 0 — accumulated rounding
   * leaves something like 1e-14, which is positive, so the guard passes and
   * t = mean / (sd/sqrt(n)) explodes to ~1e16. A ranking sorted on t would
   * then put that symbol first on the strength of rounding error alone.
   * Caught by the test that asserts a flat series proves nothing.
   *
   * The floor is relative to the mean's own scale so it holds whether the
   * series is measured in basis points or anything else.
   */
  const noiseFloor = Math.max(1e-9, Math.abs(mean) * 1e-12);
  if (!(sd > noiseFloor)) {
    return { meanBp: mean, sdBp: 0, tStat: 0, pValue: 1, sharpe: 0, sharpeAnnualised: 0, n };
  }
  const tStat = mean / (sd / Math.sqrt(n));
  const sharpe = mean / sd;
  return {
    meanBp: mean,
    sdBp: sd,
    tStat,
    pValue: twoSidedP(tStat),
    sharpe,
    sharpeAnnualised: sharpe * Math.sqrt(252),
    n,
  };
}

/** Modelled round-trip cost in bp for a name at this price. */
export function tickCostBp(price: number, ticks = ROUND_TRIP_TICKS): number | null {
  if (!(price > 0)) return null;
  return ((ticks * TICK) / price) * 10_000;
}

/** One night's return, dated by the session whose OPEN closes the hold. */
export interface NightObservation {
  /** ISO date of the session being entered into — the exit date of the hold. */
  date: string;
  grossBp: number;
  costBp: number;
  netBp: number;
  intradayBp: number;
}

/**
 * The dated per-night series, shared by the per-symbol and basket tests.
 *
 * Extracted so the two can never disagree about which nights are in scope.
 * A basket test built on its own loop would eventually drift on the gap rule
 * or the cost anchor, and the disagreement would look like a finding.
 *
 * Cost is charged PER OBSERVATION against that night's own prior close, never
 * against today's price — using today's price understates cost for names that
 * have risen, which is exactly the set a premium ranking surfaces.
 */
export function overnightSeries(
  bars: Bar[],
  sessions: number,
  ticks = ROUND_TRIP_TICKS
): { observations: NightObservation[]; droppedGaps: number } {
  const observations: NightObservation[] = [];
  let droppedGaps = 0;
  if (bars.length < 2) return { observations, droppedGaps };

  // sessions+1 bars yield `sessions` overnight observations.
  const slice = bars.slice(Math.max(0, bars.length - (sessions + 1)));
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    if (!(prev.close > 0) || !(cur.open > 0) || !(cur.close > 0)) continue;

    const gapDays = (cur.t - prev.t) / 86_400_000;
    if (gapDays > MAX_GAP_DAYS) {
      droppedGaps++;
      continue;
    }

    const cost = tickCostBp(prev.close, ticks);
    if (cost === null) continue;

    const grossBp = (cur.open / prev.close - 1) * 10_000;
    observations.push({
      date: new Date(cur.t).toISOString().slice(0, 10),
      grossBp,
      costBp: cost,
      netBp: grossBp - cost,
      intradayBp: (cur.close / cur.open - 1) * 10_000,
    });
  }
  return { observations, droppedGaps };
}

/**
 * Decompose the trailing `sessions` bars into overnight and intraday legs.
 *
 * `bars` must already have passed the corporate-action guard — an unadjusted
 * split lands entirely in the OVERNIGHT leg, because the gap is where the
 * price level changes, and a single 2,633% "overnight return" would dominate
 * every statistic here.
 */
export function decomposeWindow(
  bars: Bar[],
  sessions: number,
  ticks = ROUND_TRIP_TICKS
): WindowResult {
  const empty: WindowResult = {
    sessions,
    used: 0,
    overnightGross: null,
    overnightNet: null,
    intradayGross: null,
    meanCostBp: null,
    costBasis: "modelled",
    droppedGaps: 0,
  };
  if (bars.length < 2) return empty;

  const { observations, droppedGaps } = overnightSeries(bars, sessions, ticks);
  const overnight = observations.map((o) => o.grossBp);
  const overnightNet = observations.map((o) => o.netBp);
  const intraday = observations.map((o) => o.intradayBp);
  const costs = observations.map((o) => o.costBp);

  /*
   * `used` always reports what was actually usable, even below the two
   * observations a standard deviation needs. Returning 0 here would say "no
   * data" when the truth is "one observation, too few to summarise" — the
   * same conflation of unknown with none that this codebase keeps having to
   * unpick elsewhere. The STATISTICS go null; the count stays honest.
   */
  if (overnight.length < 2) {
    return { ...empty, used: overnight.length, droppedGaps };
  }

  return {
    sessions,
    used: overnight.length,
    overnightGross: summariseSeries(overnight),
    overnightNet: summariseSeries(overnightNet),
    intradayGross: summariseSeries(intraday),
    meanCostBp: costs.reduce((s, x) => s + x, 0) / costs.length,
    costBasis: "modelled",
    droppedGaps,
  };
}

export interface SymbolDecomposition {
  symbol: string;
  lastClose: number | null;
  /** Modelled round-trip cost at the latest price — the legibility number. */
  costBpAtLastClose: number | null;
  windows: WindowResult[];
  /** Null when even the shortest window could not be filled. */
  reason: string | null;
}

/** The declared windows. Two, so a result has to survive a horizon change. */
export const WINDOWS = [120, 250] as const;

export function decomposeSymbol(symbol: string, bars: Bar[]): SymbolDecomposition {
  const lastClose = bars.length ? bars[bars.length - 1].close : null;
  const windows = WINDOWS.map((w) => decomposeWindow(bars, w));
  const anyUsable = windows.some((w) => w.used >= MIN_SESSIONS);
  return {
    symbol,
    lastClose,
    costBpAtLastClose: lastClose !== null ? tickCostBp(lastClose) : null,
    windows,
    reason: anyUsable ? null : `insufficient_history: ${bars.length} bars`,
  };
}
