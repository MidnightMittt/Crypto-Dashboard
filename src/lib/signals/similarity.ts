/**
 * Nearest-neighbor matching over historical day fingerprints — "what did the
 * market look like the last N times this many signals agreed the same way,
 * and what actually happened next." Pure, dependency-free, hand-verified
 * against reference cases before touching any real backtest data (see
 * similarity.test.ts) — same discipline as metrics.ts.
 *
 * Distance is weighted Hamming, not cosine: every dimension here is a small
 * discrete categorical (a -1/0/+1 verdict, or a regime tag), and Hamming
 * directly supports the plain-English claim this feature exists to make
 * ("14 of 15 signals matched"), which cosine similarity wouldn't. Each
 * metric's mismatch is weighted by SIMILARITY_METRIC_WEIGHTS below so a
 * funding mismatch counts more than a liquidations mismatch.
 */

/**
 * DELIBERATELY NOT scoring.ts's `metricWeight`. That function now answers
 * "how much does this metric's opinion move the composite" and returns 0 for
 * every state/context metric under the State/Edge taxonomy (see
 * METRIC_ROLES). Similarity answers a different question — "how much does a
 * disagreement on this metric make two days LESS alike" — and a day's
 * technical character or fear/greed reading is exactly the kind of thing
 * that makes days resemble each other, vote or no vote. So this table
 * freezes the relative-importance ranking similarity has always used.
 * Unknown ids fall back to 0.05, same as the historical default: an
 * unranked dimension still describes the day.
 */
const SIMILARITY_METRIC_WEIGHTS: Record<string, number> = {
  funding: 0.15,
  squeezeRisk: 0.14,
  technicals: 0.13,
  orderFlow: 0.1,
  openInterest: 0.09,
  basis: 0.08,
  longShort: 0.08,
  etfFlows: 0.08,
  options: 0.06,
  exchangeFlow: 0.06,
  spotPerpVolume: 0.05,
  spotCvd: 0.05,
  stablecoins: 0.04,
  coinbasePremium: 0.03,
  fearGreed: 0.03,
  sectorBreadth: 0.03,
  macroLiquidity: 0.04,
  liquidations: 0, // permanently neutral by design — a "match" on it carries no information
};

function similarityWeight(id: string): number {
  return SIMILARITY_METRIC_WEIGHTS[id] ?? 0.05;
}

export interface DayFingerprint {
  asset: string;
  date: string;
  metricVerdicts: Record<string, -1 | 0 | 1>;
  regimeTags: string[];
  forwardReturn1d: number | null;
  forwardReturn7d: number | null;
}

export interface SimilarSetup {
  day: DayFingerprint;
  distance: number;
}

/**
 * regimeTags come from a trailing 20-day trend classification
 * (technicals/regimes.ts's TREND_LOOKBACK_DAYS) — two days closer together
 * than that window weren't independently classified, they're the same
 * regime re-observed. Without this floor, "similar setups" would mostly
 * surface a target's own immediate neighbors (yesterday, the day before),
 * which is true but not informative; this forces matches to come from
 * genuinely separate historical episodes.
 */
const DEFAULT_MIN_DAYS_GAP = 20;

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/** Regime-tag mismatch counts for less than a metric-verdict mismatch — it's context, not the primary similarity signal (whose weights already sum to ~1.0 via SIMILARITY_METRIC_WEIGHTS). */
const REGIME_DISTANCE_WEIGHT = 0.3;

/**
 * Weighted fraction of DISAGREEING metrics among those both days actually
 * scored, in [0, 1]. Only compares the intersection of metric ids present in
 * both fingerprints — a metric missing on either day (no historical source
 * yet, e.g. spotCvd on older days) is excluded rather than counted as a
 * mismatch, so a thinner fingerprint isn't penalized for data it never had.
 * Returns null when the two days share no metric at all — not comparable.
 */
function metricMismatchFraction(a: Record<string, -1 | 0 | 1>, b: Record<string, -1 | 0 | 1>): number | null {
  const sharedIds = Object.keys(a).filter((id) => id in b);
  if (sharedIds.length === 0) return null;

  let mismatchWeight = 0;
  let totalWeight = 0;
  for (const id of sharedIds) {
    const w = similarityWeight(id);
    totalWeight += w;
    if (a[id] !== b[id]) mismatchWeight += w;
  }
  return totalWeight > 0 ? mismatchWeight / totalWeight : 0;
}

/** Jaccard distance (1 - intersection/union) over the two days' regime tag sets, in [0, 1]. */
function regimeMismatchFraction(a: string[], b: string[]): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  const intersectionSize = a.filter((tag) => b.includes(tag)).length;
  return 1 - intersectionSize / union.size;
}

/**
 * Distance between two day fingerprints. 0 = identical; Infinity = not
 * comparable (no shared metrics at all) — callers filtering by maxDistance
 * exclude Infinity automatically, so an incomparable day can never surface
 * as a "similar" match.
 */
export function fingerprintDistance(a: DayFingerprint, b: DayFingerprint): number {
  const metricFrac = metricMismatchFraction(a.metricVerdicts, b.metricVerdicts);
  if (metricFrac === null) return Infinity;
  const regimeFrac = regimeMismatchFraction(a.regimeTags, b.regimeTags);
  return metricFrac + REGIME_DISTANCE_WEIGHT * regimeFrac;
}

/**
 * The k closest days to `target` within `history`, no closer match than
 * `maxDistance` — a fixed k alone always returns SOMETHING, even for a
 * genuinely novel setup with no real historical analog; the cutoff lets
 * "no comparable historical setup found" be an honest possible answer.
 * Excludes `target`'s own date and anything within `minDaysGap` days of it
 * (see DEFAULT_MIN_DAYS_GAP), and only ever matches within the same asset —
 * a BTC setup has no business being "similar" to an ETH day even if their
 * verdicts happen to line up, since forward returns are asset-specific and
 * mixing them would silently misrepresent what actually happened next.
 */
export function findSimilarSetups(
  target: DayFingerprint,
  history: DayFingerprint[],
  k: number,
  maxDistance: number,
  minDaysGap: number = DEFAULT_MIN_DAYS_GAP
): SimilarSetup[] {
  return history
    .filter((day) => day.asset === target.asset && day.date !== target.date && daysBetween(day.date, target.date) >= minDaysGap)
    .map((day) => ({ day, distance: fingerprintDistance(target, day) }))
    .filter((s) => s.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

/**
 * Plain "how many of the compared metrics actually agreed" count, for the
 * UI's literal claim ("14 of 15 signals matched") — distance is a WEIGHTED
 * fraction, which isn't the same number and shouldn't be presented as one.
 */
export function metricAgreementCount(
  a: Record<string, -1 | 0 | 1>,
  b: Record<string, -1 | 0 | 1>
): { matched: number; total: number } {
  const sharedIds = Object.keys(a).filter((id) => id in b);
  const matched = sharedIds.filter((id) => a[id] === b[id]).length;
  return { matched, total: sharedIds.length };
}

/**
 * k and the distance cutoff for the live "Similar Historical Setups"
 * feature — derived from the real nearest-neighbor distance distribution
 * across BTC and ETH's full backtest history (2894 day-records, both past
 * DEFAULT_MIN_DAYS_GAP): the 90th percentile nearest-neighbor distance was
 * 0.114 for BTC and 0.139 for ETH. 0.15 sits just above both, so roughly 9
 * in 10 days find at least one genuine historical analog; the rest are left
 * with an honest "no comparable setup found" rather than a stretched match.
 * Re-derive these two numbers (not guess new ones) if the metric roster or
 * REGIME_DISTANCE_WEIGHT ever changes materially.
 */
export const SIMILAR_SETUPS_K = 5;
export const SIMILAR_SETUPS_MAX_DISTANCE = 0.15;
