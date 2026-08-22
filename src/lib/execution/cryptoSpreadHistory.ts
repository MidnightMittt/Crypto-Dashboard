import cryptoSpreadJson from "@/data/cryptoSpreadHistory.json";

/**
 * WHAT A CRYPTO ROUND TRIP ACTUALLY COSTS — as a distribution, never a snapshot.
 *
 * /api/cost/express originally led with a single live book, and the flaw
 * showed up within minutes of shipping: STX/USD printed 9bp on one pull and
 * 27bp on the next. The headline ratio moved from 54x to 18x on nothing but
 * which second the request landed in. A cost figure that unstable is not a
 * cost figure, and every sizing decision resting on one snapshot inherits
 * the same defect.
 *
 * So the recorder samples the book on a schedule and this reads the shape of
 * what it found. Reported the way the equity spread history is reported:
 * the MEDIAN, and the tail you would actually be filled at. Never a mean —
 * on a book that swings 3x, the mean describes a market that does not exist,
 * and it is the tail that decides whether an edge survives.
 *
 * ── One store, three questions ───────────────────────────────────────
 *
 * The same snapshot answers all of these, which is why they are one job:
 *   spread distribution  what a trade costs, with its own tail
 *   venue agreement      Kraken's mid against the site's own source, logged
 *                        rather than spot-checked
 *   the dark window      20:00-04:00 ET and weekends, the only tape here
 *                        that sees them
 *
 * Only the third needs to accrue before it answers anything.
 */

/** Nominal order size the effective (depth-walked) spread is measured at. */
export const NOMINAL_FILL_USD = 500;

export interface CryptoSpreadObservation {
  t: string;
  venue: string;
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  /** Top-of-book spread, bp of mid. */
  spreadBp: number;
  /** Round-trip spread after walking the book for NOMINAL_FILL_USD, bp of mid. Null when depth was thin. */
  effectiveSpreadBp: number | null;
  /** The site's own reference price at the same instant, when it could be fetched. */
  refPrice: number | null;
  /** Kraken mid vs that reference, bp. Null when no reference. */
  refGapBp: number | null;
  /** Which US equity session this instant falls in — the slice that answers the dark-window question. */
  usSession: "regular" | "pre-market" | "after-hours" | "overnight" | "weekend";
}

interface CryptoSpreadFile {
  version: 1;
  generatedAt: number;
  observations: CryptoSpreadObservation[];
}

const file = cryptoSpreadJson as unknown as CryptoSpreadFile;

export interface SpreadDistribution {
  pair: string;
  venue: string;
  n: number;
  /** The headline. A median spread is what a typical fill costs. */
  medianBp: number;
  /** The tail. If the edge does not survive this, it does not survive. */
  p90Bp: number;
  worstBp: number;
  bestBp: number;
  /** Depth-walked at NOMINAL_FILL_USD — what a real order pays, when measurable. */
  medianEffectiveBp: number | null;
  nominalFillUsd: number;
  firstSeen: string;
  lastSeen: string;
  /** Sessions represented, so a caller can see whether the dark window is covered yet. */
  sessionsCovered: string[];
}

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const r2 = (v: number) => Number(v.toFixed(2));

/** Below this many samples a distribution is arithmetic, not evidence. */
export const MIN_SPREAD_SAMPLES = 8;

/**
 * The recorded shape for one pair, or null when too little has been
 * gathered to describe one. Null is a real answer: a caller that gets it
 * should fall back to a live book AND say that it did.
 */
export function spreadDistribution(pair: string): SpreadDistribution | null {
  const rows = file.observations.filter((o) => o.pair === pair && Number.isFinite(o.spreadBp));
  if (rows.length < MIN_SPREAD_SAMPLES) return null;

  const spreads = rows.map((o) => o.spreadBp).sort((a, b) => a - b);
  const effective = rows
    .map((o) => o.effectiveSpreadBp)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const times = rows.map((o) => o.t).sort();

  return {
    pair,
    venue: rows[rows.length - 1].venue,
    n: rows.length,
    medianBp: r2(quantile(spreads, 0.5)),
    p90Bp: r2(quantile(spreads, 0.9)),
    worstBp: r2(spreads[spreads.length - 1]),
    bestBp: r2(spreads[0]),
    medianEffectiveBp: effective.length > 0 ? r2(quantile(effective, 0.5)) : null,
    nominalFillUsd: NOMINAL_FILL_USD,
    firstSeen: times[0],
    lastSeen: times[times.length - 1],
    sessionsCovered: [...new Set(rows.map((o) => o.usSession))].sort(),
  };
}

export interface VenueAgreement {
  pair: string;
  n: number;
  medianGapBp: number;
  p90GapBp: number;
  worstGapBp: number;
  verdict: string;
}

/**
 * How far the venue's mid sits from the site's own price source, over time.
 *
 * Logged rather than spot-checked, because a single agreement proves less
 * than it appears: two sources matching once can share an upstream feed.
 * A persistent small gap is corroboration; a widening one is a data
 * incident, and only a series can tell them apart.
 */
export function venueAgreement(pair: string): VenueAgreement | null {
  const gaps = file.observations
    .filter((o) => o.pair === pair && o.refGapBp !== null)
    .map((o) => Math.abs(o.refGapBp as number))
    .sort((a, b) => a - b);
  if (gaps.length < MIN_SPREAD_SAMPLES) return null;

  const median = quantile(gaps, 0.5);
  const p90 = quantile(gaps, 0.9);
  return {
    pair,
    n: gaps.length,
    medianGapBp: r2(median),
    p90GapBp: r2(p90),
    worstGapBp: r2(gaps[gaps.length - 1]),
    verdict:
      median <= 25
        ? `The two sources track each other (median ${r2(median)}bp apart over ${gaps.length} samples). That is corroboration of the price, not of the spread — each venue's book is its own.`
        : `The two sources DISAGREE by a median ${r2(median)}bp over ${gaps.length} samples. One of them is describing a different market; do not treat either as confirmed until that is explained.`,
  };
}

/** Every pair the recorder has written, for callers that want to enumerate. */
export function recordedPairs(): string[] {
  return [...new Set(file.observations.map((o) => o.pair))].sort();
}

export const spreadHistoryGeneratedAt = file.generatedAt;
export const spreadHistoryCount = file.observations.length;
