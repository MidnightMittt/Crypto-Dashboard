import { effectiveSampleSize } from "./overlap";

/**
 * MARKET FINGERPRINTS — "the environments most like this one, and what
 * happened next."
 *
 * The analogs this replaces bucketed a day into a handful of coarse cells
 * (side x volatility regime x entry style). That answers "what happened in
 * roughly this kind of market", which is a much weaker question than the one
 * a trader is actually asking. A fingerprint describes the day as a POINT IN
 * A CONTINUOUS SPACE, so "most similar" means what it sounds like.
 *
 * ── The definition comes first ────────────────────────────────────────
 *
 * DIMENSIONS below is fixed before anything is measured, and deliberately so.
 * Picking dimensions by trying them and keeping the ones with good forward
 * returns is how a backtest is made to say whatever you want; the resulting
 * "50 similar environments" would be 50 environments selected for agreeing
 * with a conclusion. So the list is declared, justified on mechanism, and
 * then measured — and if the measurement says the fingerprint has no edge,
 * that is the finding.
 *
 * ── Why these eleven ──────────────────────────────────────────────────
 *
 * Two of the thirteen dimensions originally wanted are absent, and named
 * here rather than quietly dropped:
 *
 *   MONEY FLOW at single-name level is not ingested by this platform at all
 *   (it is in the research page's own gaps list as `no-provider`). There is
 *   nothing to compute it from historically.
 *
 *   OPTIONS POSITIONING exists only as today's live chain. No chain history
 *   is stored, which is the same gap that leaves IV rank unavailable in the
 *   options section. Including it would restrict the library to the days
 *   since recording began — effectively none.
 *
 * Both are listed in FUTURE_DIMENSIONS. The vector is versioned so that when
 * they land, old fingerprints are not silently compared against new ones
 * carrying two extra dimensions.
 *
 * ── Everything is a z-score against the instrument's own past ─────────
 *
 * Raw values cannot be compared across instruments: a 2% daily range is calm
 * for a biotech and a shock for a utility. Each dimension is therefore
 * standardised against that instrument's OWN trailing distribution, which is
 * what makes "NVDA today resembles a 2014 utility" a meaningful sentence
 * rather than a units error. The trailing window must end strictly before
 * the fingerprint's date — the ingest is responsible for that, and the leak
 * tripwire covers it.
 */

/** Bumped whenever DIMENSIONS changes, so mismatched vectors can never be compared. */
export const FINGERPRINT_VERSION = 1;

export interface DimensionDef {
  id: string;
  /** What it measures, in the terms the mechanism is argued in. */
  meaning: string;
  /**
   * Relative importance in the distance metric. Set from how much each
   * dimension is believed to define "the same kind of environment", NOT from
   * forward-return performance — see the header.
   */
  weight: number;
}

export const DIMENSIONS: readonly DimensionDef[] = [
  { id: "trend", meaning: "direction and persistence of the instrument's own price path", weight: 0.14 },
  { id: "volatility", meaning: "realised range relative to this instrument's normal", weight: 0.13 },
  { id: "technicalStructure", meaning: "position within the support/resistance map — where price sits, not where it came from", weight: 0.11 },
  { id: "relativeStrength", meaning: "performance against the benchmark, the single most persistent cross-sectional effect", weight: 0.1 },
  { id: "riskRegime", meaning: "risk-on or risk-off in the broad market, from the shared regime read", weight: 0.1 },
  { id: "breadth", meaning: "how much of the market is participating — a rally on ten names is a different environment", weight: 0.09 },
  { id: "macroBackdrop", meaning: "volatility, rates, dollar and credit conditions the instrument is priced inside", weight: 0.09 },
  { id: "sectorLeadership", meaning: "whether the instrument's sector is leading or lagging the rotation", weight: 0.08 },
  { id: "volumeProfile", meaning: "participation relative to normal — conviction behind the move", weight: 0.07 },
  { id: "industryLeadership", meaning: "the same at industry granularity, where rotation shows up before it reaches the sector", weight: 0.05 },
  { id: "harmonics", meaning: "geometric structure completion, already computed by the engine", weight: 0.04 },
] as const;

/**
 * Dimensions the vector will grow into. Declared so the roadmap stays
 * self-documenting and so nobody re-derives why they are missing.
 */
export const FUTURE_DIMENSIONS: readonly { id: string; blockedBy: string }[] = [
  { id: "moneyFlow", blockedBy: "no single-name flow provider is ingested; nothing exists to compute it from, historically or live" },
  { id: "optionsPositioning", blockedBy: "no stored options-chain history; only today's live snapshot exists" },
] as const;

const TOTAL_WEIGHT = DIMENSIONS.reduce((s, d) => s + d.weight, 0);

export interface MarketFingerprint {
  symbol: string;
  /** ISO date of the session this describes. */
  date: string;
  version: number;
  /**
   * Standardised value per dimension, keyed by id. A dimension may be absent
   * (an instrument with no industry mapping, a day before a source existed);
   * absence is handled by comparing the intersection rather than by
   * substituting zero, which would assert "perfectly average" about
   * something unmeasured.
   */
  values: Partial<Record<string, number>>;
}

/**
 * Weighted Euclidean distance over the dimensions BOTH days measured,
 * normalised by the weight actually compared so a thin fingerprint is not
 * penalised for data it never had.
 *
 * Euclidean rather than the Hamming used by the crypto day-matcher in
 * `signals/similarity.ts`: those are discrete -1/0/+1 verdicts where "how
 * many disagreed" is the natural claim, while these are continuous
 * z-scores where the SIZE of a gap is the information.
 *
 * Returns Infinity when the two share too few dimensions to be comparable,
 * so a caller filtering on maxDistance can never surface an incomparable day.
 */
export function fingerprintDistance(a: MarketFingerprint, b: MarketFingerprint, minShared = 6): number {
  if (a.version !== b.version) return Infinity;

  let sum = 0;
  let comparedWeight = 0;
  let shared = 0;
  for (const dim of DIMENSIONS) {
    const av = a.values[dim.id];
    const bv = b.values[dim.id];
    if (av === undefined || bv === undefined) continue;
    shared++;
    comparedWeight += dim.weight;
    sum += dim.weight * (av - bv) ** 2;
  }
  if (shared < minShared || comparedWeight <= 0) return Infinity;
  // Rescale to the full weight so distances stay comparable across pairs
  // that happened to share different subsets.
  return Math.sqrt((sum / comparedWeight) * TOTAL_WEIGHT);
}

export interface Neighbour<T> {
  fingerprint: MarketFingerprint;
  distance: number;
  outcome: T;
}

export interface NeighbourSearchOptions {
  k: number;
  /** Beyond this, "no comparable environment" is the honest answer. */
  maxDistance: number;
  /**
   * Two dates from the same instrument closer together than this are the
   * same episode re-observed, not two observations.
   */
  windowDays: number;
  /** Never match a day against its own instrument inside this window. */
  minDaysGap: number;
}

export const DEFAULT_SEARCH: NeighbourSearchOptions = {
  k: 50,
  maxDistance: 1.2,
  /*
   * A month. The trend and volatility dimensions are built from trailing
   * windows of roughly this length, so two dates closer than that share most
   * of their inputs by construction — they cannot be independent readings of
   * anything.
   */
  windowDays: 21,
  minDaysGap: 21,
};

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * THE K NEAREST ENVIRONMENTS, DE-CLUSTERED IN TIME.
 *
 * Taken naively, the fifty nearest neighbours across a 120-instrument panel
 * are mostly one fortnight seen through forty names that all move together.
 * That is one observation wearing forty hats, and reporting it as fifty is
 * the difference between a real sample and a fabricated one.
 *
 * So selection is greedy by distance, and a candidate is rejected when an
 * already-accepted neighbour covers the SAME INSTRUMENT within windowDays.
 * That handles the repeated-episode axis exactly. The correlated-instrument
 * axis cannot be fixed by dropping matches — different instruments in the
 * same week are genuinely different observations, just not independent ones
 * — so it is handled by reporting effective sample size instead. See
 * `summariseIndependence`.
 */
export function findNeighbours<T>(
  target: MarketFingerprint,
  library: Array<{ fingerprint: MarketFingerprint; outcome: T }>,
  options: NeighbourSearchOptions = DEFAULT_SEARCH
): Neighbour<T>[] {
  const scored = library
    .filter(
      (row) =>
        !(row.fingerprint.symbol === target.symbol && dayGap(row.fingerprint.date, target.date) < options.minDaysGap)
    )
    .map((row) => ({
      fingerprint: row.fingerprint,
      outcome: row.outcome,
      distance: fingerprintDistance(target, row.fingerprint),
    }))
    .filter((n) => n.distance <= options.maxDistance)
    .sort((a, b) => a.distance - b.distance);

  const accepted: Neighbour<T>[] = [];
  for (const cand of scored) {
    if (accepted.length >= options.k) break;
    const duplicateEpisode = accepted.some(
      (acc) =>
        acc.fingerprint.symbol === cand.fingerprint.symbol &&
        dayGap(acc.fingerprint.date, cand.fingerprint.date) < options.windowDays
    );
    if (!duplicateEpisode) accepted.push(cand);
  }
  return accepted;
}

export interface IndependenceSummary {
  /** Neighbours actually returned. */
  matches: number;
  /** Distinct time clusters they fall into, across all instruments. */
  episodes: number;
  /**
   * What the sample is worth once cross-instrument correlation is charged
   * for. This is the number any confidence statement must use.
   */
  effectiveN: number;
  /** Plain-language statement of the gap between `matches` and `effectiveN`. */
  line: string;
}

/**
 * WHAT THE SAMPLE IS ACTUALLY WORTH.
 *
 * Within one time cluster, m correlated instruments are not m observations.
 * The standard design-effect correction gives m / (1 + (m-1)·rho): at the
 * rho ≈ 0.82 measured across this equity panel, forty names in the same week
 * are worth about 1.2 independent readings, not forty. Summing that across
 * clusters gives the honest count.
 *
 * The result is then passed through the same overlap correction the rest of
 * the research code uses, so a neighbourhood spanning overlapping forward
 * windows is not double-counted either.
 */
export function summariseIndependence(
  dates: string[],
  symbols: string[],
  rho: number,
  windowDays: number,
  forwardHorizonDays: number
): IndependenceSummary {
  const matches = dates.length;
  if (matches === 0) {
    return { matches: 0, episodes: 0, effectiveN: 0, line: "No comparable historical environment was found." };
  }

  // Cluster dates greedily: anything within windowDays of a cluster's anchor
  // belongs to it. Sorted first so the clustering is order-independent.
  const sorted = [...dates].map((d) => Date.parse(d)).sort((a, b) => a - b);
  const clusterSizes: number[] = [];
  let anchor = sorted[0];
  let size = 0;
  for (const t of sorted) {
    if ((t - anchor) / 86_400_000 < windowDays) {
      size++;
    } else {
      clusterSizes.push(size);
      anchor = t;
      size = 1;
    }
  }
  clusterSizes.push(size);

  const perCluster = clusterSizes.map((m) => m / (1 + (m - 1) * Math.max(0, Math.min(0.99, rho))));
  const correlationAdjusted = perCluster.reduce((s, x) => s + x, 0);

  // Overlapping forward windows on top of that.
  const blockLength = Math.max(1, Math.round(forwardHorizonDays / windowDays));
  const effectiveN = effectiveSampleSize(correlationAdjusted, blockLength);

  const distinctSymbols = new Set(symbols).size;
  const line =
    effectiveN >= matches * 0.8
      ? `${matches} matches across ${clusterSizes.length} separate periods and ${distinctSymbols} instruments — close to ${Math.round(effectiveN)} independent observations.`
      : `${matches} matches, but they fall into ${clusterSizes.length} periods across ${distinctSymbols} instruments that move together. Charged for that overlap, the sample is worth about ${effectiveN.toFixed(1)} independent observations, and every confidence statement below uses that number rather than ${matches}.`;

  return { matches, episodes: clusterSizes.length, effectiveN, line };
}
