import { ConversionReport, conversionReport } from "./touchCalibration";
import { pTouchDown, pTouchUp, trailingSigmaAnnualized, TRAILING_VOL_SESSIONS } from "./gbmTouch";
import { tradingSessionsBetween } from "./marketCalendar";
import { EquityExecutionSnapshot, reachRateFor } from "../dossier/equityExpectations";
import { REACH_HORIZON_SESSIONS } from "./forwardReach";
import { atrPctSeries } from "../technicals/indicators";
import type { Bar } from "./types";

/**
 * OPTION-AWARE EXIT DESIGN — rungs a caller can actually place, composed
 * from evidence that has already resolved. Nothing here required a new
 * forward record; everything here refuses where its inputs refuse.
 *
 * ── The rung levels use NO Greeks, and that is the design ─────────────
 *
 * The obvious construction — "delta says a $1 move earns $0.45, so the
 * premium doubles at spot + premium/delta" — is wrong at exactly the
 * distances that matter: delta is a local derivative and the move that
 * doubles a premium is not local. Bounding the extrapolation error would
 * itself need a model.
 *
 * Instead each rung is placed where the multiple is guaranteed by
 * ARITHMETIC. A call touching L = strike + m x premium is worth at least
 * m x premium by intrinsic value alone, at any moment before expiry —
 * time value can only add to that. So "P(touch L within the tenor)" is a
 * LOWER bound on "P(the contract is ever worth m x entry)". The bound is
 * conservative in the caller's favour: the premium usually reaches the
 * multiple before the stock reaches L, because time value and vol get
 * there first. What the bound costs is stated per rung rather than
 * modelled away.
 *
 * ── The clock is the contract's, structurally ─────────────────────────
 *
 * The register carries a defect titled "clock mismatch": targets computed
 * from 21-session reach statistics on positions held 1.42 hours. Here the
 * horizon is derived from the expiry via the holiday-aware calendar and
 * used everywhere; there is no default to leave in place. The one
 * forward-validated reach table this site has runs on a 10-session clock,
 * so it is served as a cross-check ONLY when the tenor is within
 * CROSSCHECK_TOLERANCE_SESSIONS of that clock, and refused with the
 * defect named when it is not.
 *
 * ── What the probability is, and what it is not ───────────────────────
 *
 * GBM touch probability at the contract's tenor, at the name's own
 * trailing 60-session sigma, corrected by the measured bias from the
 * touch-calibration grid AT THE NAME'S SIGMA BAND — the same
 * `conversionReport` gate the reach screen serves, inheriting its
 * refusals: a mid-band name gets the uncorrected figure with the known
 * direction of its error and no number for the correction, exactly as
 * gbm_conversion itself answers. Every figure carries the blocks behind
 * its correction, because a probability without its n reads as more
 * settled than it is.
 */

/** Premium multiples a rung is quoted at. Declared, not tuned. */
export const DEFAULT_PREMIUM_MULTIPLES = [1.5, 2, 3] as const;

/** How far the tenor may sit from the validated 10-session clock before the cross-check refuses. */
export const CROSSCHECK_TOLERANCE_SESSIONS = 2;

export interface OptionExitInput {
  right: "call" | "put";
  strike: number;
  expiry: string;
  /** Per-share premium actually paid (0.86, not 86). */
  premium: number;
  /** ISO date the tenor is counted from — the request's own day. */
  today: string;
  /** Spot and its provenance, from the caller's panel. */
  spot: number;
  bars: readonly Bar[];
  multiples?: readonly number[];
  /** Optional underlying stop level, expressed like the equity path's. */
  stopPct?: number | null;
  /** The pooled zone table, for the 10-session cross-check. */
  snapshot?: EquityExecutionSnapshot | null;
}

export interface RungTouch {
  /** GBM at trailing sigma over the contract's tenor, uncorrected. */
  gbm_pct: number;
  /** After the measured bias. Null wherever the calibration refuses a figure. */
  corrected_pct: number | null;
  bias_pp: number | null;
  noise_floor_pp: number | null;
  /** Blocks behind the correction — the independent n of the figure. */
  blocks: number | null;
  effective_blocks: number | null;
  sigma_band: string | null;
  measured_at: { horizon_sessions: number; barrier_pct: number; exact_match: boolean } | null;
  /** The calibration's own verdict for this cell, verbatim. */
  calibration_note: string;
}

export interface OptionRung {
  multiple: number;
  /** Underlying level at which the multiple is guaranteed by intrinsic value. */
  underlying_level: number;
  move_pct: number;
  move_atr: number | null;
  already_met: boolean;
  touch: RungTouch | null;
  /** The 10-session validated table, when the clock is close enough to speak. */
  forward_validated_crosscheck:
    | { reach_pct: number; attempts: number; clock_sessions: number; note: string }
    | { refused: string };
  guarantee:
    | "intrinsic — touching the level makes the contract worth at least this multiple, before time value"
    | "already intrinsic at the last close";
}

export interface OptionExitDesign {
  right: "call" | "put";
  strike: number;
  expiry: string;
  premium: number;
  tenor_sessions: number;
  tenor_note: string;
  trailing_sigma: number | null;
  sigma_note: string;
  rungs: OptionRung[];
  stop: {
    defined_risk:
      | string
      | null;
    underlying_stop_pct: number | null;
    touch: RungTouch | null;
    note: string;
  };
  caveats: string[];
}

function touchAt(
  movePct: number,
  direction: "up" | "down",
  sigma: number,
  tenorSessions: number
): { gbmPct: number; report: ConversionReport | null } {
  const T = tenorSessions / 252;
  const mu = -0.5 * sigma * sigma;
  const frac = movePct / 100;
  const gbm =
    direction === "up"
      ? pTouchUp(Math.log(1 + frac), sigma, T, mu)
      : pTouchDown(-Math.log(1 - frac), sigma, T, mu);
  const report = conversionReport(tenorSessions, movePct, sigma);
  return { gbmPct: gbm * 100, report };
}

function rungTouch(
  movePct: number,
  direction: "up" | "down",
  sigma: number,
  tenorSessions: number
): RungTouch {
  const { gbmPct, report } = touchAt(movePct, direction, sigma, tenorSessions);
  const corrected =
    report !== null && report.bias_pp !== null
      ? Math.min(100, Math.max(0, gbmPct + report.bias_pp))
      : null;
  return {
    gbm_pct: Math.round(gbmPct * 10) / 10,
    corrected_pct: corrected === null ? null : Math.round(corrected * 10) / 10,
    bias_pp: report?.bias_pp ?? null,
    noise_floor_pp: report?.noise_floor_pp ?? null,
    blocks: report?.blocks ?? null,
    effective_blocks: report?.effective_blocks ?? null,
    sigma_band: report?.sigma_band.band ?? null,
    measured_at: report?.measured_at ?? null,
    calibration_note:
      report?.verdict ??
      "No calibration cell answered — the touch figure is the raw formula with no measured correction.",
  };
}

export function designOptionExit(input: OptionExitInput): OptionExitDesign | { error: string } {
  const { right, strike, expiry, premium, today, spot, bars } = input;
  if (!(premium > 0) || !(strike > 0) || !(spot > 0)) {
    return { error: "strike, premium and spot must all be positive." };
  }
  if (expiry <= today) {
    return { error: `expiry ${expiry} is not after ${today}; there is no tenor to design within.` };
  }

  /*
   * THE CONTRACT'S OWN CLOCK. Holiday-aware sessions to expiry — never a
   * default hold. This number keys every probability below.
   */
  const tenor = tradingSessionsBetween(today, expiry);
  if (tenor < 1) {
    return { error: `no full trading session remains before ${expiry}; exit design needs a window.` };
  }

  const sigma = trailingSigmaAnnualized(bars);
  const sigmaNote =
    sigma === null
      ? `Fewer than ${TRAILING_VOL_SESSIONS + 1} real closes — no sigma, so no touch probabilities. ` +
        "The rung levels still hold; only their probabilities are refused."
      : `Trailing ${TRAILING_VOL_SESSIONS}-session sigma ${sigma.toFixed(2)} — the estimator the ` +
        "touch calibration was measured against, which is what licenses applying its correction here.";

  const atrSeries = atrPctSeries(bars, 14);
  const atrPct = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : null;

  const direction: "up" | "down" = right === "call" ? "up" : "down";
  const multiples = (input.multiples ?? DEFAULT_PREMIUM_MULTIPLES).filter((m) => m > 1);

  const rungs: OptionRung[] = multiples.map((m) => {
    /*
     * Intrinsic guarantee: value >= m x premium exactly when intrinsic
     * reaches m x premium. Call: L = K + m*p. Put: L = K - m*p.
     */
    const level = right === "call" ? strike + m * premium : strike - m * premium;
    const movePct =
      right === "call" ? ((level - spot) / spot) * 100 : ((spot - level) / spot) * 100;
    const alreadyMet = movePct <= 0;

    /*
     * The validated cross-check speaks only near its own clock. The zone
     * table resolved 1,171 forward windows at 10 sessions; at any other
     * tenor, quoting it would be the register's clock-mismatch defect —
     * 21-session statistics on 1.42-hour holds — wearing new clothes.
     */
    const clockGap = Math.abs(tenor - REACH_HORIZON_SESSIONS);
    let crosscheck: OptionRung["forward_validated_crosscheck"];
    if (alreadyMet) {
      crosscheck = { refused: "The level is behind spot; there is nothing to reach." };
    } else if (clockGap > CROSSCHECK_TOLERANCE_SESSIONS) {
      crosscheck = {
        refused:
          `The only forward-validated reach table runs on a ${REACH_HORIZON_SESSIONS}-session clock; ` +
          `this contract's tenor is ${tenor}. Serving it anyway would be the clock-mismatch defect ` +
          "the register already carries.",
      };
    } else if (!input.snapshot || atrPct === null || !(atrPct > 0)) {
      crosscheck = { refused: "No zone snapshot or no ATR — the bucket table cannot be keyed." };
    } else {
      const distanceAtr = movePct / atrPct;
      const cell = reachRateFor(distanceAtr, 0, input.snapshot, "zone");
      crosscheck = cell
        ? {
            reach_pct: Math.round(cell.reachRatePct * 10) / 10,
            attempts: cell.attempts,
            clock_sessions: REACH_HORIZON_SESSIONS,
            note:
              `Pooled bucket rate at ${REACH_HORIZON_SESSIONS} sessions (tenor ${tenor}, within ` +
              `${CROSSCHECK_TOLERANCE_SESSIONS}). Direction-blind and bucketed — context beside the ` +
              "tenor-matched figure, not a second estimate to average with it.",
          }
        : { refused: "No bucket covers this distance." };
    }

    return {
      multiple: m,
      underlying_level: Math.round(level * 100) / 100,
      move_pct: Math.round(movePct * 10) / 10,
      move_atr: atrPct !== null && atrPct > 0 ? Math.round((movePct / atrPct) * 100) / 100 : null,
      already_met: alreadyMet,
      touch:
        alreadyMet || sigma === null ? null : rungTouch(movePct, direction, sigma, tenor),
      forward_validated_crosscheck: crosscheck,
      guarantee: alreadyMet
        ? "already intrinsic at the last close"
        : "intrinsic — touching the level makes the contract worth at least this multiple, before time value",
    };
  });

  /*
   * The stop, expressed the same way — but only for a level the caller
   * declared on the UNDERLYING. A premium-value stop ("exit at half the
   * premium") is refused: mapping it to an underlying level requires a
   * time-value model, which is the extrapolation the rungs were designed
   * to avoid. The defined-risk fact needs no level at all.
   */
  const stopPct = input.stopPct ?? null;
  const stopDirection: "up" | "down" = right === "call" ? "down" : "up";
  const stopTouch =
    stopPct !== null && stopPct > 0 && sigma !== null
      ? rungTouch(stopPct, stopDirection, sigma, tenor)
      : null;

  return {
    right,
    strike,
    expiry,
    premium,
    tenor_sessions: tenor,
    tenor_note:
      `${tenor} trading sessions to ${expiry} on the holiday-aware calendar, counted from ${today}. ` +
      "Every probability here uses this clock; there is no default hold to mismatch.",
    trailing_sigma: sigma === null ? null : Math.round(sigma * 100) / 100,
    sigma_note: sigmaNote,
    rungs,
    stop: {
      defined_risk:
        "Maximum loss is the premium paid, by construction — it cannot be gapped through. " +
        "That bound exists whether or not any stop below is used.",
      underlying_stop_pct: stopPct,
      touch: stopTouch,
      note:
        stopPct === null
          ? "No underlying stop declared. A premium-value stop (\"exit at half premium\") is not " +
            "mapped to a level here: that mapping needs a time-value model, and modelled rungs are " +
            "what this design exists to avoid."
          : `Probability that spot touches ${stopPct}% ${stopDirection === "down" ? "below" : "above"} ` +
            "entry within the tenor — the chance the stop is TESTED, not the chance of loss; the " +
            "defined-risk bound holds regardless.",
    },
    caveats: [
      "Each rung's probability is a LOWER bound on the contract reaching that multiple: intrinsic " +
        "value alone gets there at the stated level, and time value usually gets there earlier. " +
        "The bound is conservative in your favour on the target side.",
      "The guarantee is on the contract's VALUE. Realising it means selling, and a sale at the " +
        "bid gives up roughly half the spread below that value.",
      "Touch probabilities are GBM at trailing sigma corrected by the measured calibration at " +
        "this name's sigma band. Where the calibration refuses (mid band 0.5-0.8, or a cell the " +
        "Holm family cannot support), corrected_pct is null and the uncorrected figure stands " +
        "alone — read it knowing the measured bias above sigma 0.8 ran -4 to -10pp before " +
        "correction, i.e. the raw figure is OPTIMISTIC.",
      "This tool has no forward record of its own. It is a composition of measured pieces — the " +
        "touch calibration (32 years, family-charged) and the intrinsic-value identity — and its " +
        "refusals are inherited from them.",
    ],
  };
}
