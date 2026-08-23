import calibrationJson from "@/data/touchCalibration.json";

/**
 * THE MEASURED BIAS OF CONVERTING A VOLATILITY INTO A TOUCH PROBABILITY.
 *
 * Comparing measured reach against an option's implied move requires a
 * bridge: implied vol is a terminal-distance quote, reach is a
 * path-touch probability, and you cannot subtract one from the other. The
 * bridge is the reflection principle. This module answers the question
 * that bridge raises and nobody had asked: IS THE BRIDGE BIASED?
 *
 * Measured over the declared equity panel, 32 years, on a 4x4 grid of
 * (horizon, barrier), with the statistic taken over non-overlapping date
 * blocks because names are cross-correlated within a date. See
 * scripts/research/touchCalibrationGrid.ts for the declared design.
 *
 * The answer, in one line: at the barriers and tenors this account trades
 * (>=10%, >=21 sessions) the conversion is calibrated to under ~1.6pp,
 * and given the CORRECT volatility to under 0.8pp — so a premium-implied
 * touch probability can be compared to a measured one without a
 * systematic correction. What error exists is volatility FORECAST error,
 * not a flaw in the formula: the trailing-vol and in-window columns
 * disagree in sign at short horizons, which is the signature of a stale
 * vol estimate rather than a wrong path model.
 *
 * ── Why this ships beside the reach figures ──────────────────────────
 *
 * A cross-sectional "measured minus implied" leaderboard was proposed and
 * refused: it decomposes 86% drift / 14% volatility, so it ranks which
 * name trended hardest while wearing an options-pricing costume — the
 * same momentum this endpoint already documents as refused. The honest
 * join is per-contract. This block is what makes that join auditable: it
 * states the conversion's measured bias and its own noise floor, so a
 * caller can tell a real mispricing from an artefact of the bridge.
 */

export interface CalibrationStat {
  symmetric_pp: number;
  se_pp: number;
  /** Uncharged. Kept so the size of the serial-correlation charge is visible. */
  t: number;
  /** Uncharged. Do not quote this one. */
  mde_pp: number;
  /**
   * Lag-1 autocorrelation of the block series, and the SE inflation it buys.
   *
   * The date-block design absorbs correlation BETWEEN NAMES within a date by
   * construction — that is why the panel's rho of ~0.8 never enters these
   * figures. It does not absorb correlation between one block and the next,
   * and on this grid that is not negligible: ar1 averages 0.28 and reaches
   * 0.53 at the 5-day horizon, which is real persistence in the GBM model's
   * calibration error rather than a windowing artefact (the blocks stride by
   * the horizon and never overlap).
   */
  ar1: number;
  ar1_inflation: number;
  /** MDE after the charge. Quote this one. */
  mde_pp_adjusted: number;
  /** t after the charge. Decide on this one. */
  t_adjusted: number;
  /** Blocks divided by the variance inflation — what the series is actually worth. */
  effective_blocks: number;
}

export interface CalibrationCell {
  horizon_sessions: number;
  barrier_pct: number;
  blocks: number;
  names_per_block: number;
  /** Sigma knowable AT ENTRY (trailing 60 sessions) — the analogue of an IV quote. */
  trailing: CalibrationStat;
  /** Sigma realised over the window — isolates path shape from forecast error. */
  in_window: CalibrationStat;
  /** The drift term. Grows with horizon; this is what dominates a cross-sectional screen. */
  antisymmetric_trailing_pp: number;
  /** True when the cell's own MDE can resolve the effect worth finding. */
  resolves: boolean;
}

interface CalibrationFile {
  generatedAt: number;
  method: {
    panel: string;
    names: number;
    horizons: number[];
    barriers: number[];
    effectSoughtPp: number;
    trailingVolSessions: number;
    statistic: string;
    barrierConvention: string;
    note: string;
  };
  cells: CalibrationCell[];
}

const file = calibrationJson as unknown as CalibrationFile;

export const EFFECT_SOUGHT_PP = file.method.effectSoughtPp;

/**
 * The measured cell nearest a requested (horizon, barrier), and whether it
 * is the exact one. Nearest rather than refusing outright because the grid
 * is coarse by design — but the response always says which cell answered,
 * so a reader is never told a 42-session result about a 21-session
 * question without seeing that happen.
 */
export function nearestCell(
  horizonSessions: number,
  barrierPct: number
): { cell: CalibrationCell; exact: boolean } | null {
  if (file.cells.length === 0) return null;
  const score = (c: CalibrationCell) =>
    Math.abs(Math.log(c.horizon_sessions / horizonSessions)) +
    Math.abs(Math.log(c.barrier_pct / barrierPct));
  const cell = [...file.cells].sort((a, b) => score(a) - score(b))[0];
  return {
    cell,
    exact: cell.horizon_sessions === horizonSessions && cell.barrier_pct === barrierPct,
  };
}

export interface ConversionReport {
  measured_at: { horizon_sessions: number; barrier_pct: number; exact_match: boolean };
  /** Null unless the cell resolves the effect sought AND the estimate clears its own floor. */
  bias_pp: number | null;
  /** The ADJUSTED floor — after the block series' serial correlation is charged. */
  noise_floor_pp: number;
  resolves_effect_of_pp: number;
  verdict: string;
  drift_component_pp: number;
  blocks: number;
  /** What `blocks` is worth once the series' own persistence is charged. */
  effective_blocks: number;
  method: string;
}

/**
 * What a caller needs to know before subtracting an implied touch
 * probability from a measured one at this cell.
 *
 * `bias_pp` is null — deliberately, per the same discipline that returns
 * `no_width_survives` instead of a number — in EITHER of two cases: the
 * cell cannot resolve the effect worth finding, or the bias it measured
 * does not clear its own noise floor. A figure that cannot be
 * distinguished from zero at the sample available is a refusal, not a
 * measurement, and that holds for the field as well as the sentence.
 */
export function conversionReport(horizonSessions: number, barrierPct: number): ConversionReport | null {
  const found = nearestCell(horizonSessions, barrierPct);
  if (!found) return null;
  const { cell, exact } = found;
  const t = cell.trailing;
  /*
   * Both tests run on the CHARGED figures. Deciding detectability on the raw
   * t while reporting `resolves` from the charged MDE would take whichever
   * correction flatters the cell, which is worse than never measuring the
   * autocorrelation at all. Four of this grid's sixteen cells cleared |t|>=2
   * before the charge and do not after it.
   */
  const detectable = Math.abs(t.t_adjusted) >= 2;
  const material = Math.abs(t.symmetric_pp) >= EFFECT_SOUGHT_PP;
  /*
   * ONE CONDITION GOVERNS BOTH THE FIELD AND THE PROSE.
   *
   * `bias_pp` used to be gated on `resolves` alone, which asks whether the
   * cell could see a 5pp effect — a different question from whether the
   * figure it actually measured is distinguishable from zero. At 10d/20%
   * that gap was live: the verdict read "no detectable bias ... the honest
   * answer here is a null" while the field beside it returned -0.366pp, a
   * value below its own 0.427pp floor. A caller parsing JSON rather than
   * prose would have subtracted noise as a correction.
   *
   * Since mde_pp_adjusted is 2*se*inflation and t_adjusted is
   * mean/(se*inflation), `detectable` is exactly "the estimate clears its
   * own floor" — so this is the same refusal the module already claimed to
   * make, now applied to the number as well as the sentence.
   */
  const offerBias = cell.resolves && detectable;
  /** "N blocks" overstated the sample; this is what N is worth. */
  const sample = `${cell.blocks} non-overlapping blocks worth ${t.effective_blocks} after their own serial correlation (ar1 ${t.ar1})`;

  return {
    measured_at: {
      horizon_sessions: cell.horizon_sessions,
      barrier_pct: cell.barrier_pct,
      exact_match: exact,
    },
    bias_pp: offerBias ? t.symmetric_pp : null,
    noise_floor_pp: t.mde_pp_adjusted,
    resolves_effect_of_pp: EFFECT_SOUGHT_PP,
    drift_component_pp: cell.antisymmetric_trailing_pp,
    blocks: cell.blocks,
    effective_blocks: t.effective_blocks,
    verdict: !cell.resolves
      ? `This cell cannot resolve a ${EFFECT_SOUGHT_PP}pp effect (its own floor is ${t.mde_pp_adjusted}pp), so no bias figure is offered.`
      : material
        ? `The vol-to-touch conversion is biased by ${t.symmetric_pp > 0 ? "+" : ""}${t.symmetric_pp}pp here — large enough to matter; correct for it before comparing a premium to a measured rate.`
        : detectable
          ? `The vol-to-touch conversion carries a measured bias of ${t.symmetric_pp > 0 ? "+" : ""}${t.symmetric_pp}pp (t=${t.t_adjusted} over ${sample}, floor ${t.mde_pp_adjusted}pp) — real but far below the ${EFFECT_SOUGHT_PP}pp that would be tradeable. Compare premiums to measured reach without a correction; do not read a few points of difference as an edge.`
          : `No detectable bias in the vol-to-touch conversion here (${t.symmetric_pp > 0 ? "+" : ""}${t.symmetric_pp}pp, t=${t.t_adjusted} against a ${t.mde_pp_adjusted}pp floor over ${sample}). ${
              Math.abs(t.t) >= 2
                ? `It DID clear on the uncharged t (${t.t}); the blocks are not independent enough to support that reading, and the honest answer here is a null rather than a small measured bias.`
                : `A well-powered null: the bridge between implied and measured is sound at this cell.`
            }`,
    method:
      `Symmetric (volatility) component of measured-minus-implied touch probability, ` +
      `${file.method.panel}, ${sample}. Correlation BETWEEN NAMES is absorbed by the design — the ` +
      `date is the unit, so the panel's ~0.8 cross-sectional rho never enters. Correlation between ` +
      `BLOCKS is not, so it is measured and charged to the standard error. ` +
      `The ANTISYMMETRIC component here is ${cell.antisymmetric_trailing_pp > 0 ? "+" : ""}${cell.antisymmetric_trailing_pp}pp — that is DRIFT, ` +
      `it grows with horizon, and ranking symbols by undecomposed "measured minus implied" ranks it rather than any mispricing.`,
  };
}
