import { midRankPercentilePct } from "@/lib/stats/midRankPercentile";
import { PositioningPoint } from "./positioningHistory";

/**
 * IS TODAY'S READING UNUSUAL FOR THIS NAME?
 *
 * The agent API currently hands a bot `short_sale_volume_share_pct: 48.2` and
 * `net_dealer_gamma_per_1pct: 12,088,515`, and a bot has no way to know
 * whether either is ordinary. Forty-eight percent short volume is routine for
 * one symbol and extraordinary for another; twelve million dollars of gamma is
 * enormous for a small miner and nothing for a megacap.
 *
 * This is the one thing a caller genuinely cannot compute for itself. The
 * trailing distribution exists only here — CBOE publishes no chain archive, so
 * the options fields have a past only because this platform has been writing
 * one down — which makes the positional read the highest-value thing the API
 * can add over a raw level.
 *
 * ── Per field, never for the row ──────────────────────────────────────
 *
 * Coverage differs enormously between fields on the SAME symbol: short volume
 * reaches back years through FINRA's per-date archive, while gamma and implied
 * vol begin the day the recorder first ran. A single "baseline available"
 * flag for the row would therefore be a lie about one field or the other, so
 * sufficiency is decided per field and the refusal names the field's own
 * session count.
 */

/** Prior sessions below which a percentile is noise wearing a number's clothes. */
export const MIN_BASELINE_SESSIONS = 30;

export interface FieldBaseline {
  /** Mid-rank percentile of today's value among the prior sessions, 0-100. */
  percentile: number;
  /** Prior sessions compared against. Excludes today. */
  sessions: number;
  /** Mean over those prior sessions, so "vs typical" can be stated. */
  typical: number;
  /** The oldest session in the comparison, so the window is checkable. */
  since: string;
}

/** The numeric fields worth a positional read. Signs and dates are not. */
export type BaselineField =
  | "netGexUsdPer1Pct"
  | "shortRatioPct"
  | "putCallOiRatio"
  | "atmIvPct"
  | "chainOi";

export const BASELINE_FIELDS: readonly BaselineField[] = [
  "netGexUsdPer1Pct",
  "shortRatioPct",
  "putCallOiRatio",
  "atmIvPct",
  "chainOi",
];

export type BaselineSet = Partial<Record<BaselineField, FieldBaseline>>;

/**
 * Where each field's latest value sits in that symbol's own history.
 *
 * `points` must be the FULL history for the symbol; `latest` is the row being
 * described. Prior sessions are everything strictly before `latest.date`, so
 * today never sits inside the distribution it is being ranked against — the
 * same exclusion the short-volume baseline makes, and for the same reason:
 * including it drags every reading toward the middle and caps the extremes.
 */
export function baselinesFor(
  points: readonly PositioningPoint[],
  latest: PositioningPoint
): BaselineSet {
  const prior = points.filter((p) => p.symbol === latest.symbol && p.date < latest.date);
  const out: BaselineSet = {};

  for (const field of BASELINE_FIELDS) {
    const today = latest[field];
    if (typeof today !== "number") continue;

    /*
     * Only sessions where THIS field was observed. A backfilled row carries
     * short volume and nulls for everything else, so counting rows rather
     * than observations would claim 275 sessions of gamma history on a symbol
     * that has one.
     */
    const dated = prior
      .filter((p): p is PositioningPoint & Record<BaselineField, number> => typeof p[field] === "number")
      .sort((a, b) => a.date.localeCompare(b.date));
    if (dated.length < MIN_BASELINE_SESSIONS) continue;

    const values = dated.map((p) => p[field] as number);
    out[field] = {
      percentile: midRankPercentilePct(today, values)!,
      sessions: values.length,
      typical: values.reduce((s, v) => s + v, 0) / values.length,
      since: dated[0].date,
    };
  }
  return out;
}

/**
 * The refusal reason for a field with no baseline, naming its own count.
 *
 * "insufficient_history" alone would leave a bot unable to tell a field that
 * is two sessions from usable from one that will never accrue. The count is
 * the difference between waiting and giving up.
 */
export function baselineGap(
  points: readonly PositioningPoint[],
  symbol: string,
  field: BaselineField
): { reason: string; sessions_observed: number; sessions_required: number } {
  const observed = points.filter((p) => p.symbol === symbol && typeof p[field] === "number").length;
  return {
    reason: "baseline_needs_more_sessions",
    sessions_observed: observed,
    sessions_required: MIN_BASELINE_SESSIONS,
  };
}
