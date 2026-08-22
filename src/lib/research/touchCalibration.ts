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
  t: number;
  mde_pp: number;
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
  bias_pp: number | null;
  noise_floor_pp: number;
  resolves_effect_of_pp: number;
  verdict: string;
  drift_component_pp: number;
  blocks: number;
  method: string;
}

/**
 * What a caller needs to know before subtracting an implied touch
 * probability from a measured one at this cell.
 *
 * `bias_pp` is null — deliberately, per the same discipline that returns
 * `no_width_survives` instead of a number — when the cell cannot resolve
 * the effect worth finding. A figure that cannot be distinguished from
 * zero at the sample available is a refusal, not a measurement.
 */
export function conversionReport(horizonSessions: number, barrierPct: number): ConversionReport | null {
  const found = nearestCell(horizonSessions, barrierPct);
  if (!found) return null;
  const { cell, exact } = found;
  const t = cell.trailing;
  const detectable = Math.abs(t.t) >= 2;
  const material = Math.abs(t.symmetric_pp) >= EFFECT_SOUGHT_PP;

  return {
    measured_at: {
      horizon_sessions: cell.horizon_sessions,
      barrier_pct: cell.barrier_pct,
      exact_match: exact,
    },
    bias_pp: cell.resolves ? t.symmetric_pp : null,
    noise_floor_pp: t.mde_pp,
    resolves_effect_of_pp: EFFECT_SOUGHT_PP,
    drift_component_pp: cell.antisymmetric_trailing_pp,
    blocks: cell.blocks,
    verdict: !cell.resolves
      ? `This cell cannot resolve a ${EFFECT_SOUGHT_PP}pp effect (its own floor is ${t.mde_pp}pp), so no bias figure is offered.`
      : material
        ? `The vol-to-touch conversion is biased by ${t.symmetric_pp > 0 ? "+" : ""}${t.symmetric_pp}pp here — large enough to matter; correct for it before comparing a premium to a measured rate.`
        : detectable
          ? `The vol-to-touch conversion carries a measured bias of ${t.symmetric_pp > 0 ? "+" : ""}${t.symmetric_pp}pp (detectable at ${cell.blocks} independent periods, floor ${t.mde_pp}pp) — real but far below the ${EFFECT_SOUGHT_PP}pp that would be tradeable. Compare premiums to measured reach without a correction; do not read a few points of difference as an edge.`
          : `No detectable bias in the vol-to-touch conversion here (${t.symmetric_pp > 0 ? "+" : ""}${t.symmetric_pp}pp against a ${t.mde_pp}pp floor over ${cell.blocks} independent periods). A well-powered null: the bridge between implied and measured is sound at this cell.`,
    method:
      `Symmetric (volatility) component of measured-minus-implied touch probability, ` +
      `${file.method.panel}, ${cell.blocks} non-overlapping date blocks. ` +
      `The ANTISYMMETRIC component here is ${cell.antisymmetric_trailing_pp > 0 ? "+" : ""}${cell.antisymmetric_trailing_pp}pp — that is DRIFT, ` +
      `it grows with horizon, and ranking symbols by undecomposed "measured minus implied" ranks it rather than any mispricing.`,
  };
}
