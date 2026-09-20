import { THRESHOLDS } from "../chain/config";
import { PostGapRvResult } from "./postGapRv";

/**
 * FPS OPTION TRIGGER T1 — measure and arm, never recommend.
 *
 * T1 arms when a contract's implied vol sits at or below 0.90 × the post-gap
 * RV21 of the underlying: the option is cheap against the realized vol that
 * remains once earnings gaps are removed. ARMING IS THE ALERT. What to do
 * about an armed trigger — whether it claims the week's budget — lives with the
 * trading session, never here. This module states a ratio and a boolean and
 * stops.
 *
 * ── The correction that shaped the output ─────────────────────────────
 *
 * The useful reading most days is "how far from arming", not the boolean. So
 * the RAW ratio and BOTH windows are always returned, armed or not — the
 * boolean is the alert, the ratio is the information. A card that only showed
 * ARMED / NOT-ARMED would throw away the number a human actually watches.
 *
 * ── The event-content check that caught two false "fair" reads ────────
 *
 * IV prices the events inside the contract's life; RV measures the moves
 * inside its own window. If one contains an earnings print and the other does
 * not, the ratio compares an implied number that priced an event against a
 * realized number that never saw one (or vice versa) — a mismatch that reads
 * as "fair" while comparing two different things. It is surfaced on the card,
 * not silently folded in.
 */

export interface FpsTriggerInput {
  symbol: string;
  /** The contract's implied vol, percent, annualised — the caller's posted number. */
  contractIvPct: number;
  /** Which contract this IV is for, so the card names it. */
  contractLabel: string;
  /** Post-gap RV21 of the underlying, from postGapRv(). Null = unmeasurable. */
  rv: PostGapRvResult | null;
  /** Does the contract's life (now → expiry) contain an earnings print? */
  earningsInContractLife: boolean;
  /** Does the RV window contain an earnings print? */
  earningsInRvWindow: boolean;
  /** Observation stamp, ISO. */
  observedAt: string;
}

export interface FpsTriggerReading {
  symbol: string;
  observedAt: string;
  contract: string;
  /** ARMED / NOT-ARMED / INCOMPLETE (RV unmeasurable). */
  state: "ARMED" | "NOT_ARMED" | "INCOMPLETE";
  /** IV / post-gap RV21 — the number to watch, present whenever RV is. */
  rawRatio: number | null;
  /** The arming threshold (0.90), echoed so the card is self-describing. */
  armRatio: number;
  ivPct: number;
  rvPct: number | null;
  rvWindow: { from: string; to: string; sessions: number; retained: number; dropped: number } | null;
  /** Non-null when the earnings-content of the two windows disagrees. */
  eventContentMismatch: string | null;
  /** One-line human summary — states the fact, never an instruction. */
  summary: string;
}

export function evaluateFpsT1(input: FpsTriggerInput): FpsTriggerReading {
  const armRatio = THRESHOLDS.armIvToRvRatio;

  const mismatch =
    input.earningsInContractLife !== input.earningsInRvWindow
      ? input.earningsInContractLife
        ? "the contract's life contains an earnings print but the RV window does not — IV prices an event the realized vol never saw; the ratio understates."
        : "the RV window contains an earnings print but the contract's life does not — realized vol carries an event the option will not; the ratio overstates."
      : null;

  if (!input.rv) {
    return {
      symbol: input.symbol,
      observedAt: input.observedAt,
      contract: input.contractLabel,
      state: "INCOMPLETE",
      rawRatio: null,
      armRatio,
      ivPct: input.contractIvPct,
      rvPct: null,
      rvWindow: null,
      eventContentMismatch: mismatch,
      summary:
        `${input.symbol} T1 INCOMPLETE — post-gap RV21 could not be measured (too few clean sessions). ` +
        `No ratio, no arm. Unmeasured is not the same as fair.`,
    };
  }

  const rawRatio = input.rv.rvPct > 0 ? input.contractIvPct / input.rv.rvPct : null;
  const armed = rawRatio !== null && rawRatio <= armRatio;
  const distancePct = rawRatio !== null ? (rawRatio - armRatio) * 100 : null;
  const distanceText =
    distancePct === null ? "" : `; ${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(1)}pp from the line`;

  return {
    symbol: input.symbol,
    observedAt: input.observedAt,
    contract: input.contractLabel,
    state: armed ? "ARMED" : "NOT_ARMED",
    rawRatio,
    armRatio,
    ivPct: input.contractIvPct,
    rvPct: input.rv.rvPct,
    rvWindow: {
      from: input.rv.window.from,
      to: input.rv.window.to,
      sessions: input.rv.window.sessions,
      retained: input.rv.retained,
      dropped: input.rv.dropped.length,
    },
    eventContentMismatch: mismatch,
    summary:
      `${input.symbol} T1 ${armed ? "ARMED" : "not armed"}: IV ${input.contractIvPct.toFixed(1)}% ` +
      `vs post-gap RV21 ${input.rv.rvPct.toFixed(1)}% = ratio ${rawRatio?.toFixed(3) ?? "n/a"} ` +
      `(arms at ≤ ${armRatio}${distanceText})` +
      `${input.rv.dropped.length ? `, ${input.rv.dropped.length} gap session(s) dropped` : ""}` +
      `${mismatch ? " — EVENT-CONTENT MISMATCH, see card" : ""}.`,
  };
}
