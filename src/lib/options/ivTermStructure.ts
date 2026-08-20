import { midRankPercentilePct } from "@/lib/stats/midRankPercentile";

/**
 * IMPLIED VOL AT THE TENOR YOU ACTUALLY HOLD, AND WHETHER IT IS RICH.
 *
 * The endpoint reported `atm_iv_days_to_expiry: 1` and nothing else, which
 * answers a question nobody asked: front-week vol is dominated by pin risk
 * and event proximity, and a position held for weeks is priced off a
 * different part of the curve entirely. On 2026-08-20 one contract's IV ran
 * 120.7% -> 98.8% -> 115.1% inside a session while the position's P&L moved
 * as much on vol as on price, and the only way to ask "is this rich or
 * cheap" was by hand.
 *
 * Two things are needed and they fail differently:
 *
 *   1. IV AT A GIVEN DTE. Solvable from one live chain, today.
 *   2. WHERE THAT SITS IN ITS OWN HISTORY. Needs a comparable series, and
 *      comparable is the hard word — see below.
 *
 * ── Interpolate variance, never IV ───────────────────────────────────
 *
 * Total variance is additive in time; implied vol is not. Interpolating IV
 * linearly between a 3-day and a 30-day quote is a different number from
 * interpolating variance and converting back, and the gap widens exactly
 * where the term structure is steep — which is precisely when someone is
 * asking. This uses the total-variance convention (sigma^2 * T), the same
 * one the VIX methodology uses to hold a constant 30-day maturity.
 *
 * ── Why a CONSTANT maturity is recorded, not "the front expiry" ───────
 *
 * A percentile is a claim that today's reading is comparable with the
 * history it is ranked against. The existing recorded series is not: every
 * row is whatever tenor happened to sit nearest the money, and a tenor that
 * drifts from 1 day to 8 changes the number far more than the market does.
 * A "percentile" over that mixture measures the tenor, not the vol — the
 * same nuisance-dimension trap that made a theta ratio look like evidence
 * when it only tracked days-to-expiry.
 *
 * So history is accrued at a DECLARED constant maturity, interpolated to the
 * same point on the curve every session, and the percentile refuses to
 * compare across anything else.
 */

/**
 * The tenor the historical series is held at.
 *
 * 21 days, and the number is dictated by the data rather than by taste. The
 * chain provider fetches the front expiry plus the first listed at least
 * three weeks out, so the quoted curve reaches ~21 DTE and no further —
 * measured live on BTDR (0d/7d/21d) and CIFR (0d/7d/21d). A 30-day constant
 * maturity would sit outside that range and `ivAtDte` would rightly refuse
 * it on every symbol, every session, producing a series of nulls.
 *
 * 21 is far enough out to be past the front-week pin and event distortion
 * that makes 1-DTE vol useless as a baseline, which is the defect this
 * replaces. Moving to the more conventional 30 is a provider change — fetch
 * an expiry beyond ~35 days so 30 is bracketed — not a change here.
 */
export const CONSTANT_MATURITY_DAYS = 21;

/**
 * Sessions of history before a percentile is reported at all.
 *
 * Below this the rank is arithmetic, not evidence: at n=5 a reading is in
 * one of six buckets and "80th percentile" overstates what five observations
 * can support. Deliberately the same floor the positioning baselines use.
 */
export const MIN_IV_HISTORY = 30;

/** One observed point on the curve: an expiry's ATM implied vol. */
export interface IvPoint {
  /** Calendar days to expiry. Must be > 0. */
  dte: number;
  /** ATM implied vol at that expiry, in percent (annualised). */
  ivPct: number;
}

export type IvAtDte =
  | { ok: true; ivPct: number; method: "exact" | "interpolated"; fromDte: number; toDte: number }
  | { ok: false; reason: string };

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Total variance at a tenor: sigma^2 * T, with sigma in decimal and T in years. */
function totalVariance(ivPct: number, dte: number): number {
  const sigma = ivPct / 100;
  return sigma * sigma * (dte / 365);
}

/**
 * ATM implied vol at `targetDte`, interpolated across the observed curve.
 *
 * REFUSES TO EXTRAPOLATE. Past the observed range the curve's shape is
 * unknown, and a vol produced by extending a two-point line is a fabricated
 * number that would be indistinguishable from a quoted one. The caller gets
 * a reason and the range that IS supported.
 */
export function ivAtDte(points: readonly IvPoint[], targetDte: number): IvAtDte {
  const usable = points
    .filter((p) => Number.isFinite(p.dte) && p.dte > 0 && Number.isFinite(p.ivPct) && p.ivPct > 0)
    .sort((a, b) => a.dte - b.dte);

  if (usable.length === 0) return { ok: false, reason: "no usable implied-vol quotes on the chain" };
  if (!Number.isFinite(targetDte) || targetDte <= 0) {
    return { ok: false, reason: "target days-to-expiry must be a positive number" };
  }

  const exact = usable.find((p) => p.dte === targetDte);
  if (exact) {
    // Rounded on BOTH paths. Unrounded, an exact match surfaced
    // 101.55000000000001 while an interpolated one gave 109.32 — the same
    // field arriving in two different shapes depending on which branch ran.
    return { ok: true, ivPct: round2(exact.ivPct), method: "exact", fromDte: exact.dte, toDte: exact.dte };
  }

  const lo = [...usable].reverse().find((p) => p.dte < targetDte);
  const hi = usable.find((p) => p.dte > targetDte);

  if (!lo || !hi) {
    const min = usable[0].dte;
    const max = usable[usable.length - 1].dte;
    return {
      ok: false,
      reason:
        `${targetDte} DTE is outside the quoted range (${min}-${max} DTE). ` +
        `Refusing to extrapolate: past the listed expiries the shape of the curve is unknown, ` +
        `and a vol invented by extending a line would be indistinguishable from a quoted one.`,
    };
  }

  // Linear in TOTAL VARIANCE between the bracketing expiries, then back to a
  // vol at the target tenor. Linear-in-IV would give a different answer, and
  // the two diverge most where the curve is steep.
  const vLo = totalVariance(lo.ivPct, lo.dte);
  const vHi = totalVariance(hi.ivPct, hi.dte);
  const w = (targetDte - lo.dte) / (hi.dte - lo.dte);
  const vTarget = vLo + w * (vHi - vLo);
  const ivPct = Math.sqrt(vTarget / (targetDte / 365)) * 100;

  return {
    ok: true,
    ivPct: round2(ivPct),
    method: "interpolated",
    fromDte: lo.dte,
    toDte: hi.dte,
  };
}

/** Convenience: the constant maturity the historical series is held at. */
export function constantMaturityIv(points: readonly IvPoint[]): IvAtDte {
  return ivAtDte(points, CONSTANT_MATURITY_DAYS);
}

export type IvRichness =
  | {
      ok: true;
      percentile: number;
      n: number;
      /** The tenor both the reading and the history are held at. */
      maturityDays: number;
      sentence: string;
    }
  | { ok: false; reason: string };

/**
 * Where today's constant-maturity vol sits against its own history.
 *
 * `history` must be readings at the SAME constant maturity. That is a
 * precondition this function cannot verify from an array of numbers, so the
 * caller is responsible for it — and the only supported caller reads a
 * series recorded at CONSTANT_MATURITY_DAYS for exactly that reason.
 */
export function ivRichness(
  ivPct: number,
  history: readonly number[],
  maturityDays = CONSTANT_MATURITY_DAYS
): IvRichness {
  if (!Number.isFinite(ivPct) || ivPct <= 0) {
    return { ok: false, reason: "no current implied vol to rank" };
  }
  if (history.length < MIN_IV_HISTORY) {
    return {
      ok: false,
      reason:
        `only ${history.length} of the ${MIN_IV_HISTORY} sessions needed at ${maturityDays}-day ` +
        `constant maturity. A rank over fewer is arithmetic rather than evidence.`,
    };
  }

  const percentile = midRankPercentilePct(ivPct, history);
  if (percentile === null) {
    return { ok: false, reason: "history has no variation to rank against" };
  }

  return {
    ok: true,
    percentile: Math.round(percentile),
    n: history.length,
    maturityDays,
    sentence: describe(ivPct, percentile, history.length, maturityDays),
  };
}

/**
 * One sentence a trader can act on. Never a bare percentile: "the 82nd
 * percentile" does not say whether to buy or sell the option, and the whole
 * point of the figure is which side of the trade it argues for.
 */
function describe(ivPct: number, percentile: number, n: number, maturityDays: number): string {
  const where =
    percentile >= 80
      ? "rich — options here are priced above where this name usually trades, which favours selling premium over buying it"
      : percentile <= 20
        ? "cheap — options here are priced below this name's own norm, which favours buying premium over selling it"
        : "unremarkable — priced within this name's ordinary range, so vol is neither the reason to take the trade nor the reason to avoid it";

  return (
    `${ivPct.toFixed(1)}% at ${maturityDays}-day constant maturity is the ${percentile}th percentile ` +
    `of the last ${n} sessions: ${where}.`
  );
}
