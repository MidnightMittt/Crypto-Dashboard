/**
 * IS THERE ANY ALPHA AFTER BETA?
 *
 * The control basket forced this question. Over 250 sessions, date-clustered
 * and tick-net, four index ETFs produced +7.0bp at t=1.80 against the scanned
 * cohort's +32.2bp at t=1.88 — four and a half times the magnitude at the
 * same significance, which is the same Sharpe. An outside recompute got a
 * stronger version of the same result, with the ETFs beating the cohort on
 * BOTH t and Sharpe.
 *
 * Equal Sharpe means the cohort may be nothing but a levered version of the
 * index's own overnight drift. This module answers it directly:
 *
 *     overnight_i,t = alpha_i + beta_i * overnight_market,t + e_i,t
 *
 * If the alphas are indistinguishable from zero, the strategy is a leveraged
 * index overnight trade wearing twelve tickers — and the same exposure is
 * available through QQQ at well under a basis point of round trip instead of
 * six to eighteen. If some alphas survive clustering and multiple-testing
 * correction, name selection is doing real work and it is worth knowing
 * exactly which names carry it.
 *
 * Either answer is worth having. Nothing here prefers one.
 *
 * ── Guards, because this test is easy to get wrong ────────────────────
 *
 * Beta is estimated on the SAME nights as alpha — never on a separate window,
 * which would let a beta fitted in one regime absorb a different regime's
 * return into alpha. Only dates present in BOTH series are used, so a night
 * the market did not trade cannot contribute a one-sided observation.
 *
 * Both sides are NET of their own tick cost at their own prior close. Alpha
 * is then the excess over an index trade that also had to be executed, which
 * is the comparison a trader actually faces. Charging cost to one side only
 * would manufacture alpha exactly the size of the cost difference — and the
 * cost difference is the entire point at issue.
 *
 * Every row reports the minimum alpha it could have detected at t=3. These
 * are the same underpowered samples as before, and a null alpha is not proof
 * of no alpha.
 */

export interface Regression {
  /** Intercept: return not explained by the market, in bp per night. */
  alphaBp: number;
  alphaSeBp: number;
  alphaT: number;
  alphaP: number;
  /** Slope: how much of the market's overnight move this name carries. */
  beta: number;
  betaSeBp: number;
  betaT: number;
  /** Share of variance the market explains. */
  rSquared: number;
  /** Matched nights. Both series must have the date. */
  n: number;
  /**
   * The smallest |alpha| this regression could have called significant at
   * t=3, given its own residual dispersion. A null alpha from a test whose
   * detectable alpha exceeds the effect in question says nothing.
   */
  detectableAlphaAtT3Bp: number;
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

const twoSidedP = (t: number): number => 1 - erf(Math.abs(t) / Math.SQRT2);

/**
 * Ordinary least squares of y on x.
 *
 * Returns null rather than a fitted line when the market series has no
 * dispersion: with Sxx at zero the slope is undefined, and reporting beta 0
 * with the whole mean as alpha would credit the name with an alpha that is
 * really an unidentifiable regression.
 */
export function regress(y: number[], x: number[]): Regression | null {
  const n = Math.min(y.length, x.length);
  if (n < 3) return null;

  const xbar = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const ybar = y.slice(0, n).reduce((s, v) => s + v, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - xbar) ** 2;
    sxy += (x[i] - xbar) * (y[i] - ybar);
  }
  if (!(sxx > 0)) return null;

  const beta = sxy / sxx;
  const alpha = ybar - beta * xbar;

  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    sse += (y[i] - alpha - beta * x[i]) ** 2;
    sst += (y[i] - ybar) ** 2;
  }
  // n-2: two parameters estimated.
  const s2 = sse / (n - 2);
  const betaSe = Math.sqrt(s2 / sxx);
  const alphaSe = Math.sqrt(s2 * (1 / n + xbar ** 2 / sxx));

  /*
   * A perfectly fitted line has zero residual variance and therefore an
   * infinite t. That happens with contrived data, never with returns, but an
   * Infinity sorted to the top of a ranking would be the loudest possible
   * false positive.
   */
  if (!(alphaSe > 0) || !(betaSe > 0)) return null;

  const alphaT = alpha / alphaSe;
  return {
    alphaBp: alpha,
    alphaSeBp: alphaSe,
    alphaT,
    alphaP: twoSidedP(alphaT),
    beta,
    betaSeBp: betaSe,
    betaT: beta / betaSe,
    rSquared: sst > 0 ? 1 - sse / sst : 0,
    n,
    detectableAlphaAtT3Bp: 3 * alphaSe,
  };
}

/** A dated observation, so two series can be matched night by night. */
export interface DatedReturn {
  date: string;
  netBp: number;
}

/**
 * Align two dated series on the dates they share.
 *
 * An inner join, deliberately. A night the market proxy did not price cannot
 * contribute to a regression against the market, and filling it with a zero
 * would assert the market was flat when the truth is that it is unknown.
 */
export function alignOnDate(
  subject: DatedReturn[],
  market: DatedReturn[]
): { y: number[]; x: number[]; dates: string[] } {
  const byDate = new Map(market.map((m) => [m.date, m.netBp]));
  const y: number[] = [];
  const x: number[] = [];
  const dates: string[] = [];
  for (const s of [...subject].sort((a, b) => a.date.localeCompare(b.date))) {
    const m = byDate.get(s.date);
    if (m === undefined) continue;
    y.push(s.netBp);
    x.push(m);
    dates.push(s.date);
  }
  return { y, x, dates };
}

/** Regress a dated subject series on a dated market series. */
export function regressOnMarket(
  subject: DatedReturn[],
  market: DatedReturn[]
): Regression | null {
  const { y, x } = alignOnDate(subject, market);
  return regress(y, x);
}
