/**
 * THE VOLATILITY TERM STRUCTURE — is the stress now, or later?
 *
 * Roadmap Phase 3's FRED wave names this explicitly. It is the one genuinely
 * new macro read in that list: the platform already carries a VIX LEVEL
 * through the macro backdrop, and a level and a slope are different
 * quantities that answer different questions. "Volatility is high" and
 * "near-dated volatility is bid above three-month" can be true separately,
 * and it is the second that marks acute stress.
 *
 * ── The measurement ──────────────────────────────────────────────────
 *
 * VIX3M / VIX. Above 1 is CONTANGO: the market prices more uncertainty three
 * months out than this month, which is the resting state of a calm tape.
 * Below 1 is BACKWARDATION: near-dated fear exceeds far-dated, which happens
 * when something is happening NOW rather than being feared later.
 *
 * ── Why it is banded rather than compared to 1.0 ─────────────────────
 *
 * 1.0 is the mechanically meaningful line and it is also a bad threshold to
 * trade off, because the ratio sits above it the overwhelming majority of the
 * time — a rule that fires only below 1.0 fires almost never and says nothing
 * about the many days when contango is merely unusually thin. So the reading
 * is placed in its own 18-year distribution, the same discipline every other
 * banded metric here uses, AND the raw ratio is reported so a reader can see
 * which side of 1.0 it sits.
 *
 * ── What is NOT claimed ──────────────────────────────────────────────
 *
 * This is a STATE read. It describes the volatility market's shape and makes
 * no forecast — it has no measured record on this platform, does not vote in
 * any composite, and its section does not claim a tier for existing. That is
 * the same standing every other unvalidated context read has here, and the
 * roadmap classifies it the same way.
 */


import { midRankPercentile } from "@/lib/stats/midRankPercentile";
export type TermStructureState = "backwardation" | "flat" | "contango";

export interface VolTermRead {
  /** VIX3M / VIX at the latest common session. */
  ratio: number;
  /** Where that sits in its own history, 0-100. */
  percentile: number;
  state: TermStructureState;
  /** Sessions of history the percentile was computed over. */
  historyLength: number;
  /** The date both legs share. Never a date only one of them has. */
  asOf: string;
  /** One sentence. Never a bare ratio. */
  sentence: string;
}

/**
 * Below this the curve is inverted enough to call it. Not 1.0 exactly: the
 * ratio crosses 1 by rounding on quiet days, and a state that flickers is a
 * state nobody can act on.
 */
const BACKWARDATION_MAX = 0.98;
/** Above this the curve is comfortably upward-sloping. */
const CONTANGO_MIN = 1.02;
/** Below this many observations a percentile is not worth printing. */
const MIN_HISTORY = 250;

export interface DatedValue {
  date: string;
  value: number;
}

/**
 * Reads the term structure from two independently-dated series.
 *
 * ALIGNED ON DATES PRESENT IN BOTH, which is the whole reason this takes
 * dated values rather than two arrays. Yahoo's ^VIX3M was a month staler than
 * its ^VIX when this was built: pairing by position would have divided a
 * fresh near-dated print by a month-old far-dated one and produced a
 * confident number describing nothing. Pairing by date makes that failure
 * impossible rather than unlikely.
 */
export function readVolTermStructure(
  vix: readonly DatedValue[],
  vix3m: readonly DatedValue[]
): VolTermRead | null {
  const near = new Map(vix.map((d) => [d.date, d.value]));
  const paired: Array<{ date: string; ratio: number }> = [];

  for (const far of vix3m) {
    const n = near.get(far.date);
    if (n === undefined || !(n > 0) || !(far.value > 0)) continue;
    paired.push({ date: far.date, ratio: far.value / n });
  }

  if (paired.length < MIN_HISTORY) return null;
  paired.sort((a, b) => a.date.localeCompare(b.date));

  const latest = paired[paired.length - 1];
  const history = paired.slice(0, -1).map((p) => p.ratio);
  const percentile = percentileOf(latest.ratio, history) * 100;

  const state: TermStructureState =
    latest.ratio <= BACKWARDATION_MAX ? "backwardation" : latest.ratio >= CONTANGO_MIN ? "contango" : "flat";

  return {
    ratio: latest.ratio,
    percentile,
    state,
    historyLength: history.length,
    asOf: latest.date,
    sentence: describe(latest.ratio, percentile, state, history.length),
  };
}

function describe(ratio: number, percentile: number, state: TermStructureState, n: number): string {
  const where = `${ratio.toFixed(2)}× three-month over spot, ${Math.round(percentile)}th percentile of ${n} sessions`;

  if (state === "backwardation") {
    return (
      `Volatility is BACKWARDATED — near-dated fear is priced above three-month (${where}). That is the shape of ` +
      `stress happening now rather than anticipated later, and it is historically rare. It says nothing about ` +
      `direction; it says the market is paying up for immediate protection.`
    );
  }
  if (state === "flat") {
    return (
      `The volatility curve is nearly FLAT (${where}). The usual cushion between near-dated and three-month ` +
      `has compressed, which is the state that precedes inversion without being one.`
    );
  }
  const unusual =
    percentile <= 20
      ? " Thin for this market, though: the curve is flatter than it usually is even while sloping the right way."
      : percentile >= 80
        ? " Unusually steep, which is the resting shape of a calm tape rather than a warning."
        : "";
  return `Volatility is in CONTANGO — three-month is priced above spot (${where}), the normal state.${unusual}`;
}

/**
 * Mid-rank percentile, matching the equity evidence modules exactly.
 *
 * Ties split rather than counting as "below", so a measure sitting on a
 * common value lands at the middle rather than the floor — the same
 * zero-variance trap the relative-strength read documents.
 */
function percentileOf(value: number, history: readonly number[]): number {
  /*
   * An empty history reads as the MIDDLE here rather than as a refusal, which
   * is this caller's own convention: a term-structure percentile feeds a
   * continuous read that has no null branch, and 0.5 is "no information"
   * expressed in its units. The shared estimator returns null instead, so the
   * mapping is written down rather than buried in a default.
   */
  return midRankPercentile(value, history) ?? 0.5;
}
