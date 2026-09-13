/**
 * IMPLIED VOL AGAINST REALIZED VOL — the ratio, and the thing it predicts.
 *
 * The observation this exists to systematise: CLSK's implied vol at 83
 * against realized 105, a ratio of 0.79, found by hand once. The question is
 * whether that ratio carries information in this universe, or whether one
 * profitable trade is being mistaken for a method.
 *
 * ── The ratio is a SIGNAL. It is not the outcome ──────────────────────
 *
 * IV is forward-looking: `ivConstantMaturityPct` is interpolated to a 21
 * CALENDAR day tenor, so it is the market's estimate of the next three weeks
 * — fifteen sessions. Trailing realized vol is backward-looking. Their ratio
 * is therefore not a mispricing — it is a comparison of a forecast against a
 * different period's outcome, and a low reading is equally consistent with
 * "options are cheap" and with "realized vol just spiked and is about to
 * mean-revert". Those are opposite trades.
 *
 * What settles it is IV against the realized vol that FOLLOWS, over the same
 * stretch of time the implied number describes. That is the variance risk
 * premium actually realising, and it is the mechanism any option trade here
 * would be harvesting.
 *
 * So every observation carries both:
 *
 *   ratio         = IV / trailing RV     known at the time, the screen
 *   forwardRatio  = IV / forward RV      known 15 sessions later, the truth
 *
 * ── Why this is measured from bars rather than option P&L ─────────────
 *
 * Option returns are a noisy, path-dependent, cost-laden proxy for the same
 * quantity: they mix the vol premium with delta, with the strike ladder, with
 * the spread paid, and with when the position happened to be closed. The
 * premium itself is a property of the underlying's path and needs only
 * closes. Measuring it directly is a far more powerful test of the same
 * hypothesis, it resolves on a fixed schedule, and it needs no option data
 * beyond the implied number already recorded.
 *
 * ── The resolution schedule is uniform, deliberately ──────────────────
 *
 * Forward RV resolves at exactly `IV_TENOR_SESSIONS` for every observation.
 * No barrier, no early close, no "resolved when it hit a target". A design
 * where some outcomes resolve faster than others is how a forward record
 * publishes a win rate computed on the winners — the fast-resolving arm
 * enters the sample first and the slow one never arrives. A fixed horizon
 * cannot do that, and this file will not grow a barrier.
 */

/**
 * Sessions the implied number describes — CONVERTED from the tenor, not copied
 * from it.
 *
 * ── The unit error this replaces ──────────────────────────────────────
 *
 * This was `21`, pinned to `CONSTANT_MATURITY_DAYS = 21` by a test asserting
 * the two are equal. They are equal as integers and they are not the same
 * quantity. `ivAtDte` measures its target in CALENDAR days to expiry — it
 * divides by 365 — while everything here counts trading SESSIONS. So implied
 * vol describing 21 calendar days was scored against realized vol over 21
 * sessions, which is 30 calendar days: nine days of realisation, 30% of the
 * measured window, that the implied number never priced.
 *
 * The test passed because both sides were the numeral 21. A pin that compares
 * two magnitudes without comparing their units is not a pin, and the version
 * below asserts the CONVERSION instead.
 *
 * ── Why 15 and not 14.5 ───────────────────────────────────────────────
 *
 * 21 calendar days is exactly three calendar weeks, which is exactly fifteen
 * trading sessions when no holiday falls inside. The ratio 21 * 252/365 gives
 * 14.50 and has to be rounded; the calendar gives 15 outright, so 15 is the
 * answer and the ratio is the sanity check rather than the derivation.
 *
 * Where the two disagree — a holiday week — the leg runs one session LONG
 * against the tenor rather than one short, and that is the side to err on.
 * A realized window longer than the implied tenor adds unpriced realisation,
 * which is noise roughly uncorrelated with the screen and attenuates the
 * measured correlation. A window SHORTER than the tenor does the opposite: the
 * missing days are priced by IV and absent from RV, so a name with an event in
 * the gap gets a high screen and a low premium at once — which is a negative
 * contribution, and negative is the sign this screen predicted in advance.
 * Erring short would manufacture the result. Erring long can only hide it.
 *
 * @see scripts/audit/ivRvHorizonAgreement.ts — the measurement behind this
 */
export const IV_TENOR_SESSIONS = 15;

/**
 * Sessions in one calendar week of trading, used only to state the conversion
 * above as arithmetic a test can check rather than as a claim in a comment.
 */
export const SESSIONS_PER_CALENDAR_WEEK = 5;
export const CALENDAR_DAYS_PER_WEEK = 7;

/**
 * Trailing windows, plural, because which one belongs in the denominator IS
 * the open question rather than an implementation detail. 15 matches the IV
 * tenor and is the honest like-for-like; 10 reacts faster and is closer to
 * what a screen "feels"; 63 is the quarter a mean-reversion story would use.
 * Storing all three costs one pass and keeps the choice out of the collector,
 * where it would harden into an assumption before there was any evidence.
 *
 * 21 is gone from this list rather than kept alongside. It was here only
 * because it was believed to be the matched window; retaining it as a fourth
 * sensitivity would be keeping a specification for no reason except that it
 * used to be the default, which is how an argmax gets one more draw.
 */
export const TRAILING_WINDOWS = [10, 15, 63] as const;

/** Sessions per year, for annualising a per-session standard deviation. */
export const ANNUALISATION_SESSIONS = 252;

/**
 * Minimum returns in a window. Below this the standard deviation is dominated
 * by its own sampling error: at n=5 the 95% interval on a vol estimate spans
 * roughly ±45% of the estimate, which is wider than the effect being hunted.
 */
export const MIN_RETURNS = 8;

export interface TrailingLeg {
  windowSessions: number;
  /** Annualised, in percent, to match the units IV is recorded in. */
  rvPct: number | null;
  /** IV / trailing RV. Below 1 means implied sits under what recently happened. */
  ratio: number | null;
}

export interface IvRvPoint {
  date: string;
  symbol: string;
  ivPct: number;
  ivTenorSessions: number;
  trailing: TrailingLeg[];
  /**
   * Realized vol over the `IV_TENOR_SESSIONS` sessions AFTER `date` — the
   * stretch the implied number was quoted over, in sessions. Null until that
   * many have elapsed, which is the point, and why this field is the only one
   * worth judging the ratio against.
   */
  forwardRvPct: number | null;
  /**
   * IV / forward RV. Below 1 means the option was cheap against what the
   * underlying went on to do; above 1 means implied was rich and selling it
   * was the trade.
   */
  forwardRatio: number | null;
  /** ISO date the forward leg resolved on, or null while it is still open. */
  forwardResolvedOn: string | null;
}

/**
 * Log returns from a close series, with a null wherever either end is
 * missing. Length matches the input so index i means "the return INTO session
 * i" and callers can slice by session index without an off-by-one.
 */
export function logReturnsAligned(closes: readonly (number | null)[]): (number | null)[] {
  return closes.map((c, i) => {
    if (i === 0) return null;
    const prev = closes[i - 1];
    if (prev === null || prev <= 0 || c === null || c <= 0) return null;
    return Math.log(c / prev);
  });
}

/**
 * Annualised standard deviation of a return slice, in percent.
 *
 * Zero-mean, not sample-mean. Over 21 sessions the mean is estimated far too
 * imprecisely to be worth removing, and subtracting it biases the estimate
 * downward by exactly the drift that a vol seller is being paid to carry.
 * This is the convention the implied number is quoted under, so it is the one
 * that makes the ratio a comparison rather than a units mismatch.
 */
function annualisedVolPct(returns: readonly number[]): number | null {
  if (returns.length < MIN_RETURNS) return null;
  const sumSq = returns.reduce((a, r) => a + r * r, 0);
  const perSession = Math.sqrt(sumSq / returns.length);
  return perSession * Math.sqrt(ANNUALISATION_SESSIONS) * 100;
}

/**
 * Realized vol over the `window` sessions ending at `endIndex`, inclusive.
 *
 * NO LOOK-AHEAD BY CONSTRUCTION: every return used is indexed at or before
 * `endIndex`, and a return at index i is built from closes at i-1 and i. The
 * earliest close touched is `endIndex - window`, the latest is `endIndex`.
 *
 * Returns null rather than a partial estimate when the window contains a gap.
 * A vol computed across a hole understates — the missing session's move is
 * scored as no move — and it understates most for exactly the illiquid names
 * where the gaps are.
 */
export function trailingRvPct(
  returns: readonly (number | null)[],
  endIndex: number,
  window: number
): number | null {
  if (endIndex < 0 || endIndex >= returns.length) return null;
  const start = endIndex - window + 1;
  if (start < 1) return null;
  const slice = returns.slice(start, endIndex + 1);
  if (slice.some((r) => r === null)) return null;
  return annualisedVolPct(slice as number[]);
}

/**
 * Realized vol over the `window` sessions AFTER `fromIndex`.
 *
 * The first return used is the one INTO `fromIndex + 1`, so the observation
 * session's own move is excluded — it is already inside the trailing leg, and
 * counting it on both sides would correlate the signal with its own outcome.
 */
export function forwardRvPct(
  returns: readonly (number | null)[],
  fromIndex: number,
  window: number
): number | null {
  const end = fromIndex + window;
  if (fromIndex < 0 || end >= returns.length) return null;
  const slice = returns.slice(fromIndex + 1, end + 1);
  if (slice.some((r) => r === null)) return null;
  return annualisedVolPct(slice as number[]);
}

const ratioOf = (ivPct: number, rvPct: number | null): number | null =>
  rvPct === null || rvPct <= 0 ? null : ivPct / rvPct;

/**
 * One symbol-session, joined and resolved as far as the bars allow.
 *
 * `sessionIndex` is the observation's position in the panel calendar. The
 * caller resolves it, because only the caller knows whether the IV row's date
 * is a session the panel actually has — an IV reading stamped on a date the
 * bars do not contain cannot be joined, and guessing the nearest session
 * would silently pair an implied number with the wrong day's realized move.
 */
export function buildIvRvPoint(input: {
  date: string;
  symbol: string;
  ivPct: number;
  ivTenorSessions: number;
  returns: readonly (number | null)[];
  sessionIndex: number;
  sessions: readonly string[];
}): IvRvPoint {
  const { date, symbol, ivPct, ivTenorSessions, returns, sessionIndex, sessions } = input;

  const trailing: TrailingLeg[] = TRAILING_WINDOWS.map((windowSessions) => {
    const rvPct = trailingRvPct(returns, sessionIndex, windowSessions);
    return { windowSessions, rvPct, ratio: ratioOf(ivPct, rvPct) };
  });

  const fwd = forwardRvPct(returns, sessionIndex, IV_TENOR_SESSIONS);
  const resolvedIndex = sessionIndex + IV_TENOR_SESSIONS;

  return {
    date,
    symbol,
    ivPct,
    ivTenorSessions,
    trailing,
    forwardRvPct: fwd,
    forwardRatio: ratioOf(ivPct, fwd),
    forwardResolvedOn: fwd === null ? null : (sessions[resolvedIndex] ?? null),
  };
}

/** The trailing leg at the window that matches the IV tenor, or null. */
export function matchedLeg(point: IvRvPoint): TrailingLeg | null {
  return point.trailing.find((t) => t.windowSessions === IV_TENOR_SESSIONS) ?? null;
}
