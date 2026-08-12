import { mulberry32 } from "./random";
import { PanelObservation, PanelSummary, summarizePanel, toPeriodSlices } from "./panelBootstrap";

/**
 * CONTINUOUS-OUTCOME PANEL INFERENCE.
 *
 * The panel bootstrap previously supported proportions only, so a study of
 * expectancy, R multiple or drawdown had no statistically correct path. This
 * closes that, and does so by GENERALISING the existing estimator rather than
 * adding a second one.
 *
 * ── One engine, not two ─────────────────────────────────────────────────
 *
 * The resampling scheme is unchanged: contiguous blocks of time periods,
 * each carrying every contemporaneous observation. What changes is only the
 * function evaluated on each resample. A proportion is the mean of a 0/1
 * series; expectancy is the mean of a return series; profit factor is a
 * ratio of sums. All three are statistics of the same resampled panel, so
 * all three inherit the same serial and cross-sectional dependence handling
 * automatically. There is no separate code path that could drift.
 *
 * ── Effective sample size, generalised ──────────────────────────────────
 *
 * For proportions the framework used n_eff = p(1-p)/SE^2. That does not
 * generalise: for a median or a profit factor there is no p(1-p).
 *
 * The general definition used here is a VARIANCE RATIO against an IID
 * bootstrap of the same statistic on the same data:
 *
 *     n_eff = n * (SE_iid / SE_panel)^2
 *
 * Read plainly: this dependent sample carries as much information as
 * n*(ratio^2) independent observations would. It is defined for any
 * statistic, needs no closed form, and requires no distributional
 * assumption.
 *
 * Crucially it is not a new convention. For the mean of a 0/1 series,
 * SE_iid^2 = p(1-p)/n, so n*(SE_iid/SE_panel)^2 = p(1-p)/SE_panel^2 —
 * algebraically identical to the existing proportion definition. The
 * unification therefore changes no number the framework already produced,
 * which is the property that makes it a generalisation rather than a
 * replacement. `panelStatistics.test.ts` pins that equivalence numerically.
 *
 * ── Confidence intervals: BCa, not percentile ───────────────────────────
 *
 * Financial outcome distributions are skewed (bounded loss, unbounded gain)
 * and heavy-tailed. A plain percentile interval is biased under skew, and a
 * normal-approximation interval is worse. BCa (bias-corrected and
 * accelerated) adjusts for both median bias and skewness, is
 * transformation-respecting, and is second-order accurate — the standard
 * robust choice, and the one the brief's "do not assume normality" calls for.
 *
 * The acceleration term needs a jackknife. For a panel the correct analogue
 * is a BLOCK jackknife — leave out one whole period at a time, never one
 * observation — because leaving out a single observation from a dependent
 * cluster understates its influence.
 */

// ── Normal distribution helpers ─────────────────────────────────────────

/** Standard normal CDF via Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Inverse standard normal CDF (probit), Acklam's rational approximation.
 * Relative error < 1.15e-9 across the open interval, which is far tighter
 * than anything BCa needs.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── Statistic library ───────────────────────────────────────────────────

/**
 * A statistic over a flat array of observation values.
 *
 * Order-sensitive statistics (drawdown) receive values in the RESAMPLED
 * order, which for a block bootstrap preserves local sequencing inside each
 * block. That is the correct treatment: drawdown is a path property, and a
 * scheme that shuffled individual observations would destroy the very thing
 * being measured.
 */
export type PanelStatistic = (values: number[]) => number;

const mean: PanelStatistic = (v) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

const median: PanelStatistic = (v) => {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Gross gains divided by gross losses. Returns Infinity when there are no
 * losses, which is mathematically right but degenerate — callers should
 * treat a non-finite point estimate as uninformative rather than excellent.
 */
const profitFactor: PanelStatistic = (v) => {
  let gains = 0;
  let losses = 0;
  for (const x of v) {
    if (x > 0) gains += x;
    else losses -= x;
  }
  return losses > 0 ? gains / losses : gains > 0 ? Infinity : 0;
};

/** Mean win divided by absolute mean loss. */
const payoffRatio: PanelStatistic = (v) => {
  const wins = v.filter((x) => x > 0);
  const losses = v.filter((x) => x < 0);
  if (wins.length === 0 || losses.length === 0) return 0;
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  return avgLoss > 0 ? avgWin / avgLoss : 0;
};

/**
 * Maximum peak-to-trough decline of the cumulative sum, in the units of the
 * input. Path-dependent by nature, hence sensitive to resample ordering —
 * see the note on `PanelStatistic`.
 */
const maxDrawdown: PanelStatistic = (v) => {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const x of v) {
    cumulative += x;
    peak = Math.max(peak, cumulative);
    worst = Math.max(worst, peak - cumulative);
  }
  return worst;
};

const winRate: PanelStatistic = (v) => (v.length === 0 ? 0 : v.filter((x) => x > 0).length / v.length);

/**
 * Named statistics. A study names one; it never supplies a function, so the
 * set of things that can be measured is auditable and every study measuring
 * "expectancy" measures the same thing.
 */
export const PANEL_STATISTICS = {
  /** Arithmetic mean. Serves mean return, expectancy, R multiple, MAE, MFE and holding time — all of which are means of their respective series. */
  mean,
  median,
  profitFactor,
  payoffRatio,
  maxDrawdown,
  /** Fraction of strictly positive values. The proportion case, expressed in the same library. */
  winRate,
} as const;

export type PanelStatisticName = keyof typeof PANEL_STATISTICS;

// ── Metric-kind inference ───────────────────────────────────────────────

export type MetricKind = "binary" | "continuous";

/**
 * Classifies an outcome series so the framework, not the study author,
 * chooses the estimator.
 *
 * Binary means literally every value is 0 or 1. Anything else is continuous.
 * Deliberately strict: a series of {0, 1, 2} is NOT binary, and silently
 * treating it as one would apply a proportion interval to a count.
 */
export function inferMetricKind(values: number[]): MetricKind {
  return values.every((v) => v === 0 || v === 1) ? "binary" : "continuous";
}

// ── The generalised bootstrap ───────────────────────────────────────────

const DEFAULT_ITERATIONS = 2000;

/** Resampled index plan for one bootstrap iteration, as flat values. */
function drawPanelResample(
  slices: PanelObservation[][],
  block: number,
  rng: () => number
): number[] {
  const P = slices.length;
  const maxStart = P - block;
  const runsNeeded = Math.ceil(P / block);
  const out: number[] = [];
  let periodsTaken = 0;
  for (let r = 0; r < runsNeeded && periodsTaken < P; r++) {
    const start = Math.floor(rng() * (maxStart + 1));
    for (let k = 0; k < block && periodsTaken < P; k++) {
      for (const obs of slices[start + k]) out.push(obs.value);
      periodsTaken++;
    }
  }
  return out;
}

/**
 * Bootstrap distribution of an arbitrary statistic over a panel.
 *
 * Identical resampling to `panelBlockBootstrap`; only the evaluated function
 * differs. Exported so the equivalence can be tested directly rather than
 * asserted.
 */
export function panelBootstrapDistribution(
  observations: PanelObservation[],
  statistic: PanelStatistic,
  blockPeriods: number,
  iterations = DEFAULT_ITERATIONS,
  seed = 12345
): number[] {
  const slices = toPeriodSlices(observations);
  if (slices.length === 0) return [];
  const block = Math.max(1, Math.min(Math.floor(blockPeriods), slices.length));
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const values = drawPanelResample(slices, block, rng);
    if (values.length > 0) out.push(statistic(values));
  }
  return out;
}

/**
 * IID reference bootstrap: resamples individual OBSERVATIONS with
 * replacement, destroying both dependence structures.
 *
 * Its only purpose is to supply the denominator-free reference SE for the
 * effective-N variance ratio. It is never used for inference — an IID
 * interval on dependent data is exactly the overstatement this framework
 * exists to prevent.
 */
function iidBootstrapDistribution(
  values: number[],
  statistic: PanelStatistic,
  iterations: number,
  seed: number
): number[] {
  const n = values.length;
  if (n === 0) return [];
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: number[] = new Array(n);
    for (let j = 0; j < n; j++) sample[j] = values[Math.floor(rng() * n)];
    out.push(statistic(sample));
  }
  return out;
}

/**
 * Block jackknife for the BCa acceleration term: leave out one whole PERIOD
 * at a time.
 *
 * Leaving out a single observation would understate the influence of a
 * dependent cluster, since its contemporaneous siblings remain. Dropping the
 * period is the analogue that respects the panel structure.
 */
function blockJackknife(slices: PanelObservation[][], statistic: PanelStatistic): number[] {
  const out: number[] = [];
  for (let skip = 0; skip < slices.length; skip++) {
    const values: number[] = [];
    for (let i = 0; i < slices.length; i++) {
      if (i === skip) continue;
      for (const o of slices[i]) values.push(o.value);
    }
    if (values.length > 0) out.push(statistic(values));
  }
  return out;
}

export interface PanelEstimate {
  statisticName: string;
  metricKind: MetricKind;
  /** Raw observation count. Reported, never the basis of an interval. */
  n: number;
  periods: number;
  blockPeriods: number;
  /** The statistic evaluated on the real data. */
  point: number;
  /** Standard error from the panel bootstrap — carries both dependence corrections. */
  standardError: number;
  /** SE from an IID bootstrap of the same statistic. The ratio to `standardError` is the size of the dependence correction. */
  iidStandardError: number;
  /** n * (SE_iid/SE_panel)^2. Reduces exactly to p(1-p)/SE^2 for a proportion. */
  effectiveN: number;
  /** BCa interval. Falls back to percentile when the acceleration term is undefined (constant jackknife). */
  lower: number;
  upper: number;
  intervalMethod: "bca" | "percentile";
  /** Two-sided p-value against `nullValue`, from the bootstrap distribution's own tail mass — no normality assumed. */
  pValue: number;
  nullValue: number;
  /** The full distribution, for callers that need to plot or re-summarise it. */
  distribution: number[];
  panel: PanelSummary;
}

/**
 * The core estimator. Returns a complete, dependence-corrected summary for
 * any statistic over any panel.
 */
export function estimatePanelStatistic(opts: {
  observations: PanelObservation[];
  statistic: PanelStatistic;
  statisticName: string;
  blockPeriods: number;
  nullValue: number;
  iterations?: number;
  seed?: number;
}): PanelEstimate | null {
  const { observations, statistic, statisticName, blockPeriods, nullValue } = opts;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const seed = opts.seed ?? 12345;

  const n = observations.length;
  if (n === 0) return null;

  const slices = toPeriodSlices(observations);
  const panel = summarizePanel(observations);
  const flat = observations.map((o) => o.value);
  const block = Math.max(1, Math.min(Math.floor(blockPeriods), slices.length));

  const point = statistic(flat);
  const distribution = panelBootstrapDistribution(observations, statistic, block, iterations, seed);
  if (distribution.length === 0) return null;

  const finite = distribution.filter((x) => Number.isFinite(x));
  const dMean = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
  const variance =
    finite.length > 1 ? finite.reduce((a, b) => a + (b - dMean) ** 2, 0) / (finite.length - 1) : 0;
  const standardError = Math.sqrt(variance);

  // Reference SE under independence, for the effective-N ratio. Uses a
  // different seed stream so the two bootstraps are not coupled.
  const iidDist = iidBootstrapDistribution(flat, statistic, iterations, seed + 1).filter((x) =>
    Number.isFinite(x)
  );
  const iidMean = iidDist.length > 0 ? iidDist.reduce((a, b) => a + b, 0) / iidDist.length : 0;
  const iidVariance =
    iidDist.length > 1 ? iidDist.reduce((a, b) => a + (b - iidMean) ** 2, 0) / (iidDist.length - 1) : 0;
  const iidStandardError = Math.sqrt(iidVariance);

  /*
   * n_eff = n * (SE_iid / SE_panel)^2, capped at n.
   *
   * The cap exists because a dependent sample cannot carry MORE information
   * than the same number of independent observations would; a ratio above 1
   * indicates negative dependence, which is real but is not extra evidence.
   * When either SE is zero the ratio is undefined and the honest fallback is
   * the structural block count.
   */
  const structuralN = Math.max(1, slices.length / block);
  const effectiveN =
    standardError > 0 && iidStandardError > 0
      ? Math.min(n, n * (iidStandardError / standardError) ** 2)
      : Math.min(n, structuralN);

  // ── BCa interval ──────────────────────────────────────────────────────
  const sorted = [...finite].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

  let lower = pick(0.025);
  let upper = pick(0.975);
  let intervalMethod: "bca" | "percentile" = "percentile";

  const belowCount = finite.filter((x) => x < point).length;
  const proportionBelow = belowCount / finite.length;
  if (proportionBelow > 0 && proportionBelow < 1) {
    const z0 = normalQuantile(proportionBelow);
    const jack = blockJackknife(slices, statistic).filter((x) => Number.isFinite(x));
    if (jack.length > 2) {
      const jMean = jack.reduce((a, b) => a + b, 0) / jack.length;
      let num = 0;
      let den = 0;
      for (const j of jack) {
        const d = jMean - j;
        num += d ** 3;
        den += d ** 2;
      }
      const acceleration = den > 0 ? num / (6 * Math.pow(den, 1.5)) : 0;
      if (Number.isFinite(acceleration)) {
        const adjust = (alpha: number) => {
          const zA = normalQuantile(alpha);
          const denom = 1 - acceleration * (z0 + zA);
          if (denom === 0) return alpha;
          return normalCdf(z0 + (z0 + zA) / denom);
        };
        const a1 = adjust(0.025);
        const a2 = adjust(0.975);
        if (Number.isFinite(a1) && Number.isFinite(a2) && a1 < a2) {
          lower = pick(a1);
          upper = pick(a2);
          intervalMethod = "bca";
        }
      }
    }
  }

  /*
   * p-value from the bootstrap distribution's own tail mass around the null,
   * doubled for two sides. No normal approximation — the distribution is
   * used as-is, which is the point of bootstrapping a skewed statistic.
   *
   * Two guards, both learned from failures rather than anticipated:
   *
   *  - A ZERO-VARIANCE sample reports no evidence (p = 1), not overwhelming
   *    evidence. Every resample of a constant series lands on the same value
   *    and therefore entirely on one side of the null, which the tail-mass
   *    formula would read as p = 0 — maximum confidence from data exhibiting
   *    no variability at all. It is also what `panelBootstrapProportion`
   *    already does, and the two engines must not disagree on the same input.
   *
   *  - The p-value is FLOORED at 1/iterations. A bootstrap with B draws
   *    cannot resolve a tail smaller than 1/B, so reporting exactly 0 claims
   *    a precision the method does not have.
   */
  const resolutionFloor = 1 / finite.length;
  const tail =
    Math.min(
      finite.filter((x) => x <= nullValue).length,
      finite.filter((x) => x >= nullValue).length
    ) / finite.length;
  const pValue = standardError > 0 ? Math.min(1, Math.max(resolutionFloor, 2 * tail)) : 1;

  return {
    statisticName,
    metricKind: inferMetricKind(flat),
    n,
    periods: panel.periods,
    blockPeriods: block,
    point,
    standardError,
    iidStandardError,
    effectiveN,
    lower,
    upper,
    intervalMethod,
    pValue,
    nullValue,
    distribution,
    panel,
  };
}

// ── Unified entry point ─────────────────────────────────────────────────

export interface MetricSpec {
  /** Named statistic. A study never supplies a raw function. */
  statistic: PanelStatisticName;
  /** Value under the null. 0.5 for a win rate, 0 for a return or expectancy, 1 for a ratio. */
  nullValue: number;
}

/**
 * Default null for each statistic, so a study that names a metric does not
 * also have to reason about what "no effect" means for it. Overridable, but
 * the default is the defensible one in every case.
 */
export const DEFAULT_NULL_VALUE: Record<PanelStatisticName, number> = {
  mean: 0,
  median: 0,
  profitFactor: 1,
  payoffRatio: 1,
  maxDrawdown: 0,
  winRate: 0.5,
};

/**
 * THE single analysis entry point.
 *
 * A study names a metric; the framework selects the estimator, infers
 * whether the endpoint is binary or continuous, and applies the same
 * dependence corrections either way. No study calls a bootstrap.
 */
export function analyzePanel(
  observations: PanelObservation[],
  spec: MetricSpec,
  blockPeriods: number,
  iterations = DEFAULT_ITERATIONS,
  seed = 12345
): PanelEstimate | null {
  return estimatePanelStatistic({
    observations,
    statistic: PANEL_STATISTICS[spec.statistic],
    statisticName: spec.statistic,
    blockPeriods,
    nullValue: spec.nullValue,
    iterations,
    seed,
  });
}

export interface PanelEstimateDifference {
  difference: number;
  standardError: number;
  lower: number;
  upper: number;
  pValue: number;
}

/**
 * Difference between two estimates on DISJOINT samples. Variances add
 * because the samples share no observations, and each input SE already
 * carries both dependence corrections.
 *
 * The interval is normal-approximate on the DIFFERENCE even though each
 * component interval is BCa. That is a deliberate, disclosed compromise: a
 * fully non-parametric interval for a difference of two independent
 * bootstraps requires a joint resampling scheme the two samples do not
 * share. The approximation is reasonable because a difference of two
 * independent statistics is far closer to normal than either component
 * (Lyapunov), but it is an assumption and is recorded as one in the audit.
 */
export function differenceOfEstimates(a: PanelEstimate, b: PanelEstimate): PanelEstimateDifference {
  const difference = a.point - b.point;
  const standardError = Math.sqrt(a.standardError ** 2 + b.standardError ** 2);
  if (standardError <= 0) {
    return { difference, standardError: 0, lower: difference, upper: difference, pValue: 1 };
  }
  const z = difference / standardError;
  return {
    difference,
    standardError,
    lower: difference - 1.96 * standardError,
    upper: difference + 1.96 * standardError,
    pValue: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))),
  };
}

/** Smallest difference detectable at 80% power given an achieved SE. Statistic-agnostic: works for a win rate, an expectancy or a drawdown alike. */
export function detectableDifference(standardError: number): number {
  return 2.802 * standardError;
}
