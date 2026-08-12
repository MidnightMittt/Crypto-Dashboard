/**
 * PANEL BLOCK BOOTSTRAP — correcting temporal AND cross-sectional
 * dependence in one estimator.
 *
 * ── The gap this closes ─────────────────────────────────────────────────
 *
 * The moving block bootstrap in `overlap.ts` treats observations as a single
 * ordered sequence, which correctly preserves dependence ALONG time. It has
 * nothing to say about dependence ACROSS assets at the same instant. BTC and
 * ETH on the same day are two views of one market event (measured rho =
 * 0.82), yet a 1-D bootstrap counts them as two facts.
 *
 * Real research data is a panel: N units observed over T periods, with
 * dependence on both axes. Correcting only one axis overstates confidence,
 * and the overstatement grows with the universe — precisely as this project
 * expands beyond two assets.
 *
 * ── Why this estimator, and not the alternatives ────────────────────────
 *
 * The scheme here draws contiguous blocks of TIME PERIODS, each carrying
 * every observation recorded in those periods. Compared against:
 *
 *   Cluster bootstrap by date (resample whole dates independently).
 *     Preserves cross-sectional dependence, DESTROYS serial dependence.
 *     Rejected: serial dependence is not a hypothetical concern here — it
 *     reversed the conclusion of the Phase 6 weekly-regime study.
 *
 *   Two-way clustered standard errors (Cameron-Gelbach-Miller).
 *     The econometric standard for panel regressions, and correct
 *     asymptotically in BOTH N and T. Rejected because we have N = 2: the
 *     estimator's variance is unreliable, and it can return a non-positive
 *     variance in small samples. It fails exactly where this project is.
 *
 *   Equicorrelation adjustment, N_eff = N / (1 + (N-1)*rho_bar).
 *     Used for the Phase 7 power planning, and appropriate there. Rejected
 *     as an estimator because it assumes EXCHANGEABLE correlation — every
 *     pair equally correlated — which is false for a universe mixing
 *     equities, bonds, FX and crypto, and because it yields a scalar
 *     adjustment rather than a sampling distribution.
 *
 *   Panel block bootstrap (chosen).
 *     Preserves both axes in one scheme. Non-parametric: no assumed
 *     correlation matrix, no assumption that correlation is constant
 *     through time, no assumption that units are exchangeable. Scales
 *     unchanged from 2 units to hundreds — the period slice simply gets
 *     wider. Degenerates EXACTLY to the existing moving block bootstrap
 *     when there is one unit per period, which is what makes it a strict
 *     generalisation rather than a replacement.
 *
 * ── How double-discounting is avoided ───────────────────────────────────
 *
 * Two rules, both structural:
 *
 *   1. `blockPeriods` counts TIME PERIODS, never observations. Existing
 *      code compensated for two assets by doubling an observation-denominated
 *      block length; doing that here as well would discount the same
 *      dependence twice. Cross-sectional dependence is handled solely by
 *      keeping a period's observations together.
 *
 *   2. Effective N is DERIVED from the realised bootstrap variance
 *      (n_eff = p(1-p)/SE^2), never composed from separate temporal and
 *      cross-sectional factors. Composition is exactly where a double
 *      discount would hide. Because it inverts the variance the resampling
 *      actually produced, it is correct by construction: for independent
 *      data it returns n, and for k perfectly-dependent clusters it returns
 *      k, with no special-casing.
 */

import { mulberry32 } from "./random";

/** One observation in a panel. `period` is the dependence-sharing key: observations with the same period are contemporaneous. */
export interface PanelObservation {
  /**
   * Time bucket. Observations sharing a period are treated as
   * cross-sectionally dependent and always resampled together.
   *
   * The caller chooses the granularity, and that choice is a modelling
   * decision: daily bars usually key on the session date, but a study of
   * weekly effects might key on the week. Finer than the true dependence
   * horizon under-corrects; coarser over-corrects.
   */
  period: number;
  /** Which asset/instrument. Recorded for diagnostics; the estimator never branches on it. */
  unitId: string;
  /** The measured quantity. 0/1 for a proportion, any real number for a mean. */
  value: number;
}

export interface PanelSummary {
  observations: number;
  periods: number;
  /** Mean observations per period — the cross-sectional width. 1.0 means the panel is really a single series. */
  meanUnitsPerPeriod: number;
  /** True when every period holds the same number of units. Unbalanced panels are supported but worth surfacing. */
  balanced: boolean;
}

/** Groups observations into chronologically ordered period slices. The sort is what makes contiguous blocks meaningful. */
export function toPeriodSlices(observations: PanelObservation[]): PanelObservation[][] {
  const byPeriod = new Map<number, PanelObservation[]>();
  for (const o of observations) {
    const existing = byPeriod.get(o.period);
    if (existing) existing.push(o);
    else byPeriod.set(o.period, [o]);
  }
  return [...byPeriod.entries()].sort((a, b) => a[0] - b[0]).map(([, obs]) => obs);
}

export function summarizePanel(observations: PanelObservation[]): PanelSummary {
  const slices = toPeriodSlices(observations);
  const widths = slices.map((s) => s.length);
  return {
    observations: observations.length,
    periods: slices.length,
    meanUnitsPerPeriod: slices.length === 0 ? 0 : observations.length / slices.length,
    balanced: widths.length > 0 && widths.every((w) => w === widths[0]),
  };
}

const DEFAULT_ITERATIONS = 2000;

/**
 * Bootstrap distribution of the panel mean.
 *
 * Draws ceil(P / blockPeriods) contiguous runs of `blockPeriods` periods
 * from uniformly random start positions, concatenating every observation
 * inside them, then takes the mean. Whole periods move together, so
 * contemporaneous dependence survives resampling; whole runs move together,
 * so serial dependence survives too.
 *
 * Unbalanced panels are handled naturally: a resample simply contains
 * however many observations its drawn periods held. No padding, no
 * reweighting — inventing observations to balance a panel would fabricate
 * evidence.
 */
export function panelBlockBootstrap(
  observations: PanelObservation[],
  blockPeriods: number,
  iterations = DEFAULT_ITERATIONS,
  seed = 12345
): number[] {
  const slices = toPeriodSlices(observations);
  const P = slices.length;
  if (P === 0) return [];

  const block = Math.max(1, Math.min(Math.floor(blockPeriods), P));
  const maxStart = P - block;
  const runsNeeded = Math.ceil(P / block);
  const rng = mulberry32(seed);
  const distribution: number[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    let sum = 0;
    let count = 0;
    let periodsTaken = 0;
    for (let r = 0; r < runsNeeded && periodsTaken < P; r++) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let k = 0; k < block && periodsTaken < P; k++) {
        for (const obs of slices[start + k]) {
          sum += obs.value;
          count++;
        }
        periodsTaken++;
      }
    }
    if (count > 0) distribution.push(sum / count);
  }
  return distribution;
}

export interface PanelAdjustedProportion {
  /** Raw observation count — reported, but never the basis of an interval. */
  n: number;
  periods: number;
  point: number;
  blockPeriods: number;
  /**
   * Independent observations implied by the bootstrap variance:
   * n_eff = p(1-p) / SE^2.
   *
   * Derived rather than composed, so temporal and cross-sectional
   * dependence cannot be charged for twice. Capped at `n`, since a sample
   * can never carry more information than it has observations — exceeding
   * it would indicate negatively correlated units, which is real but not
   * something to credit as extra evidence.
   */
  effectiveN: number;
  bootstrapSe: number;
  /** What a naive analysis would have claimed. The ratio to `bootstrapSe` is the size of the correction. */
  naiveSe: number;
  lower: number;
  upper: number;
  pValue: number;
  nullProportion: number;
  panel: PanelSummary;
}

/** Standard normal two-sided tail (Abramowitz-Stegun 7.1.26; |error| < 1.5e-7). */
function twoSidedNormalP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.min(1, Math.max(0, 1 - y));
}

/**
 * The panel-aware replacement for `blockBootstrapProportion`.
 *
 * `values` must be 0/1. Observations may arrive in any order — unlike the
 * 1-D estimator, ordering is carried by `period` rather than by array
 * position, which removes a whole class of caller error (a shuffled array
 * silently defeating the 1-D correction).
 */
export function panelBootstrapProportion(
  observations: PanelObservation[],
  blockPeriods: number,
  nullProportion = 0.5,
  iterations = DEFAULT_ITERATIONS,
  seed = 12345
): PanelAdjustedProportion | null {
  const n = observations.length;
  if (n === 0) return null;

  const panel = summarizePanel(observations);
  const point = observations.reduce((a, o) => a + o.value, 0) / n;
  const distribution = panelBlockBootstrap(observations, blockPeriods, iterations, seed);
  if (distribution.length === 0) return null;

  const mean = distribution.reduce((a, b) => a + b, 0) / distribution.length;
  const variance =
    distribution.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, distribution.length - 1);
  const bootstrapSe = Math.sqrt(variance);
  const naiveSe = Math.sqrt((point * (1 - point)) / n);

  /*
   * Effective N from the realised variance: n_eff = p(1-p)/SE^2.
   *
   * A degenerate sample (every observation identical) has zero spread and
   * zero bootstrap variance, so there is nothing to invert. Falling back to
   * `n` there would be the worst possible answer — claiming MAXIMUM
   * information from a sample that exhibits none — so the fallback is the
   * structural count of independent time blocks instead. That is the honest
   * floor: however uniform the outcomes, the data still only spans this many
   * non-overlapping windows.
   */
  const block = Math.max(1, Math.min(Math.floor(blockPeriods), panel.periods));
  const structuralN = Math.max(1, panel.periods / block);
  const spread = point * (1 - point);
  const effectiveN =
    bootstrapSe > 0 && spread > 0 ? Math.min(n, spread / (bootstrapSe * bootstrapSe)) : Math.min(n, structuralN);

  const sorted = [...distribution].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

  return {
    n,
    periods: panel.periods,
    point,
    blockPeriods: block,
    effectiveN,
    bootstrapSe,
    naiveSe,
    lower: pick(0.025),
    upper: pick(0.975),
    // A degenerate sample (zero spread) carries no evidence of a difference
    // rather than infinite confidence.
    pValue: bootstrapSe > 0 ? twoSidedNormalP((point - nullProportion) / bootstrapSe) : 1,
    nullProportion,
    panel,
  };
}

export interface PanelDifference {
  difference: number;
  se: number;
  pValue: number;
  lower: number;
  upper: number;
}

/**
 * Difference between two panel-corrected proportions measured on DISJOINT
 * samples. Variances add because the samples share no observations; each
 * input SE already carries both dependence corrections.
 */
export function panelDifference(a: PanelAdjustedProportion, b: PanelAdjustedProportion): PanelDifference {
  const difference = a.point - b.point;
  const se = Math.sqrt(a.bootstrapSe ** 2 + b.bootstrapSe ** 2);
  return {
    difference,
    se,
    pValue: se > 0 ? twoSidedNormalP(difference / se) : 1,
    lower: difference - 1.96 * se,
    upper: difference + 1.96 * se,
  };
}
