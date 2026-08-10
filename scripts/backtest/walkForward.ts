/**
 * The three statistical-honesty gaps left open by the first Phase 3 pass:
 * out-of-sample validation of the execution layer, a calibration test that
 * can actually populate its buckets, and regime segmentation that admits
 * when a cell is too small to conclude anything from.
 *
 * Nothing here touches the live decision engine. Every function measures
 * already-resolved trades.
 */

import { computeTradeStats, TradeRecord, TradeStats } from "./tradeStats";
import { wilsonInterval, ProportionInterval } from "./metrics";

const DAY_MS = 86_400_000;

// ── Walk-forward ────────────────────────────────────────────────────────

export interface WalkForwardTrade extends TradeRecord {
  side: "long" | "short";
  /** Entry + hold, so the embargo can exclude trades that were still open when a validation window opened. */
  exitT: number;
}

export interface Fold {
  index: number;
  discoveryEnd: string;
  discoveryN: number;
  validationStart: string;
  validationEnd: string;
  validationN: number;
  stats: TradeStats | null;
  /**
   * The strictly out-of-sample test that DOES exist here. Rank the two
   * sides on discovery data only, then check whether that ranking held in
   * the validation window. Null when either period lacks a usable sample.
   */
  discoveryBetterSide: "long" | "short" | null;
  validationBetterSide: "long" | "short" | null;
  sideRankingHeld: boolean | null;
}

export interface WalkForwardReport {
  /**
   * Named honestly. The execution engine has NO fitted parameters — every
   * threshold is a source-code constant and every percentile is ranked
   * against prior history only — so there is nothing to "train" and a
   * classic train/test split would be theatre. What this actually measures
   * is whether the edge PERSISTS across sequential unseen periods, plus a
   * genuine out-of-sample test of the conclusions drawn from the data.
   */
  methodology: string;
  foldCount: number;
  embargoDays: number;
  folds: Fold[];
  inSample: TradeStats | null;
  /** Simple mean of per-fold expectancies — deliberately unweighted, so one busy fold can't dominate the stability read. */
  meanOutOfSampleExpectancyPct: number | null;
  worstFoldExpectancyPct: number | null;
  bestFoldExpectancyPct: number | null;
  /** How many folds reproduced the discovery-period side ranking. The one true OOS hit rate available. */
  sideRankingHeldCount: number;
  sideRankingTestedCount: number;
  interpretation: string;
}

function betterSide(trades: WalkForwardTrade[], minPerSide: number): "long" | "short" | null {
  const longs = trades.filter((t) => t.side === "long");
  const shorts = trades.filter((t) => t.side === "short");
  if (longs.length < minPerSide || shorts.length < minPerSide) return null;
  const mean = (a: WalkForwardTrade[]) => a.reduce((s, t) => s + t.netReturnPct, 0) / a.length;
  return mean(longs) >= mean(shorts) ? "long" : "short";
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Chronological folds with a purge/embargo gap.
 *
 * The embargo is not ceremonial here. Trades hold for up to 7 days, so a
 * discovery-period trade opened near the boundary is still open when the
 * validation window starts, and its outcome is partly determined by
 * validation-period price action. Excluding any trade whose EXIT lands
 * after the boundary minus the embargo is what keeps the two periods
 * genuinely disjoint.
 */
export function buildWalkForward(
  trades: WalkForwardTrade[],
  foldCount = 5,
  embargoDays = 7,
  minPerSide = 20
): WalkForwardReport {
  const sorted = [...trades].sort((a, b) => a.t - b.t);
  const embargoMs = embargoDays * DAY_MS;

  const folds: Fold[] = [];
  if (sorted.length > 0) {
    const start = sorted[0].t;
    const end = sorted[sorted.length - 1].t;
    // foldCount validation windows, preceded by one seed segment so fold 1
    // has prior data to form a discovery set from.
    const segment = (end - start) / (foldCount + 1);

    for (let k = 1; k <= foldCount; k++) {
      const vStart = start + segment * k;
      const vEnd = k === foldCount ? end + 1 : start + segment * (k + 1);

      const validation = sorted.filter((t) => t.t >= vStart && t.t < vEnd);
      const discovery = sorted.filter((t) => t.exitT <= vStart - embargoMs);

      const dSide = betterSide(discovery, minPerSide);
      const vSide = betterSide(validation, minPerSide);

      folds.push({
        index: k,
        discoveryEnd: iso(vStart - embargoMs),
        discoveryN: discovery.length,
        validationStart: iso(vStart),
        validationEnd: iso(vEnd - 1),
        validationN: validation.length,
        stats: computeTradeStats(validation),
        discoveryBetterSide: dSide,
        validationBetterSide: vSide,
        sideRankingHeld: dSide && vSide ? dSide === vSide : null,
      });
    }
  }

  const withStats = folds.filter((f) => f.stats !== null);
  const expectancies = withStats.map((f) => f.stats!.expectancyNetPct);
  const tested = folds.filter((f) => f.sideRankingHeld !== null);
  const held = tested.filter((f) => f.sideRankingHeld === true);

  const inSample = computeTradeStats(sorted);
  const meanOos = expectancies.length ? expectancies.reduce((a, b) => a + b, 0) / expectancies.length : null;

  return {
    methodology:
      "The execution engine has no fitted parameters: every threshold is a source-code constant and every percentile is ranked against prior history only. There is therefore nothing to train, and a conventional train/test split would be theatre — refitting nothing would reproduce identical decisions. These folds instead measure (a) whether the edge PERSISTS across sequential unseen periods, and (b) a genuine out-of-sample test: rank the two sides on discovery data alone, then check whether that ranking held in the following window. Discovery sets exclude any trade still open at the boundary (purge + embargo), so no validation-period price action can reach back into a discovery statistic.",
    foldCount,
    embargoDays,
    folds,
    inSample,
    meanOutOfSampleExpectancyPct: meanOos,
    worstFoldExpectancyPct: expectancies.length ? Math.min(...expectancies) : null,
    bestFoldExpectancyPct: expectancies.length ? Math.max(...expectancies) : null,
    sideRankingHeldCount: held.length,
    sideRankingTestedCount: tested.length,
    interpretation: interpretWalkForward(inSample, expectancies, held.length, tested.length),
  };
}

function interpretWalkForward(
  inSample: TradeStats | null,
  expectancies: number[],
  held: number,
  tested: number
): string {
  if (!inSample || expectancies.length < 2) return "Not enough folds with a usable sample to assess stability.";
  const mean = expectancies.reduce((a, b) => a + b, 0) / expectancies.length;
  const positive = expectancies.filter((e) => e > 0).length;
  const drift = mean - inSample.expectancyNetPct;

  const stability = `Per-fold net expectancy ranged ${Math.min(...expectancies).toFixed(3)}% to ${Math.max(...expectancies).toFixed(3)}%, positive in ${positive} of ${expectancies.length} folds, averaging ${mean.toFixed(3)}% against the pooled ${inSample.expectancyNetPct.toFixed(3)}%.`;
  const deterioration =
    Math.abs(drift) < 0.05
      ? " Pooled and per-period results agree closely, which is expected given nothing is fitted — the value of this test is the spread across folds, not the average."
      : ` Sequential periods differ from the pooled figure by ${drift.toFixed(3)} points on average.`;
  const ranking =
    tested === 0
      ? " The side-ranking test had too few trades per side in any fold to run."
      : ` The discovery-period side ranking held in ${held} of ${tested} validation windows.`;

  return stability + deterioration + ranking;
}

// ── Confidence distribution ─────────────────────────────────────────────

export interface DistributionSummary {
  n: number;
  min: number;
  max: number;
  mean: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function summarizeDistribution(values: number[]): DistributionSummary | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    median: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
  };
}

// ── Quantile calibration ────────────────────────────────────────────────

export interface QuantileBucket {
  label: string;
  lowerBound: number;
  upperBound: number;
  n: number;
  observedRatePct: number;
  interval: ProportionInterval;
}

export interface QuantileCalibration {
  buckets: QuantileBucket[];
  /** Observed rate never decreases as confidence rises. The ORDERING claim — much weaker than calibration, and the only one this data can address. */
  monotonic: boolean | null;
  /** Top bucket minus bottom. The practical question: how much does confidence actually separate outcomes? */
  spreadPct: number | null;
  interpretation: string;
}

export interface CalibrationObservation {
  confidence: number;
  verdict: string;
  forwardReturnPct: number | null;
}

/**
 * Calibration measured against EMPIRICAL quantiles rather than fixed
 * 0-20/20-40/... bands.
 *
 * Fixed bands are the wrong instrument for this score. Measured over the
 * full history the engine's confidence occupies roughly [33, 58] — a
 * mathematical consequence of it being a weighted MEAN of ~15 bounded
 * per-metric confidences (scoring.ts), which concentrates by construction.
 * Three of the five fixed bands are therefore permanently empty, and the
 * two that populate are too coarse to test ordering within the range the
 * score actually uses.
 *
 * Splitting the observed distribution into equal-population quantiles fixes
 * the measurement without touching the engine: every bucket gets a usable
 * sample, and "does higher confidence do better" becomes answerable.
 *
 * This tests ORDERING, not calibration to a probability. A quantile bucket
 * has no implied success rate to be right or wrong about, so nothing here
 * can be read as "confidence N means N%".
 */
export function buildQuantileCalibration(
  observations: CalibrationObservation[],
  bucketCount = 4,
  minSampleN = 30
): QuantileCalibration {
  const scored = observations.filter((o) => o.verdict !== "neutral" && o.forwardReturnPct !== null);
  if (scored.length < minSampleN * bucketCount) {
    return { buckets: [], monotonic: null, spreadPct: null, interpretation: "Not enough scored days to split into quantile buckets." };
  }

  const sortedConf = [...scored.map((o) => o.confidence)].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < bucketCount; i++) edges.push(quantile(sortedConf, i / bucketCount));

  const buckets: QuantileBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lower = i === 0 ? -Infinity : edges[i - 1];
    const upper = i === bucketCount - 1 ? Infinity : edges[i];
    const inBucket = scored.filter((o) => o.confidence >= lower && (i === bucketCount - 1 ? true : o.confidence < upper));
    if (inBucket.length < minSampleN) continue;

    const hits = inBucket.filter((o) =>
      o.verdict === "bullish" ? (o.forwardReturnPct as number) > 0 : (o.forwardReturnPct as number) < 0
    ).length;

    buckets.push({
      label: `${i === 0 ? sortedConf[0] : lower.toFixed(0)}-${i === bucketCount - 1 ? sortedConf[sortedConf.length - 1] : upper.toFixed(0)}`,
      lowerBound: i === 0 ? sortedConf[0] : lower,
      upperBound: i === bucketCount - 1 ? sortedConf[sortedConf.length - 1] : upper,
      n: inBucket.length,
      observedRatePct: (hits / inBucket.length) * 100,
      interval: wilsonInterval(hits, inBucket.length)!,
    });
  }

  const monotonic =
    buckets.length < 2 ? null : buckets.every((b, i) => i === 0 || b.observedRatePct >= buckets[i - 1].observedRatePct);
  const spreadPct = buckets.length < 2 ? null : buckets[buckets.length - 1].observedRatePct - buckets[0].observedRatePct;

  let interpretation: string;
  if (buckets.length < 2 || spreadPct === null) {
    interpretation = "Too few populated quantile buckets to test whether confidence orders outcomes.";
  } else {
    const overlap =
      buckets[0].interval.upper >= buckets[buckets.length - 1].interval.lower
        ? " The confidence intervals of the lowest and highest buckets overlap, so even the observed spread is not statistically distinguishable from no effect."
        : " The lowest and highest buckets' confidence intervals do not overlap.";
    interpretation =
      `${monotonic ? "Observed rates rise monotonically across quantiles" : "Observed rates do NOT rise monotonically across quantiles"}, spanning ${spreadPct.toFixed(1)} points from the lowest to the highest confidence quartile.${overlap}`;
  }

  return { buckets, monotonic, spreadPct, interpretation };
}

// ── Sample adequacy + marginal regime analysis ──────────────────────────

export type SampleAdequacy = "adequate" | "thin" | "insufficient";

/**
 * Thresholds are declared, not conventional-by-accident. 100 is where a
 * proportion's Wilson interval narrows to roughly +/-10 points, which is
 * about the coarsest read still worth acting on; 30 is the existing
 * MIN_SAMPLE_N floor already used throughout this codebase. Below that,
 * cells are reported as insufficient and carry no conclusion.
 */
export function classifySample(n: number): SampleAdequacy {
  if (n >= 100) return "adequate";
  if (n >= 30) return "thin";
  return "insufficient";
}

export interface RegimeCell {
  label: string;
  dimension: "trend" | "volatility" | "structure" | "combined";
  n: number;
  adequacy: SampleAdequacy;
  stats: TradeStats | null;
}

/**
 * Regime performance along each dimension SEPARATELY, in addition to the
 * full cross-product.
 *
 * The cross-product is where the sample problem lives: three dimensions
 * multiply into 16 cells, several holding a dozen trades, and a -2.5%
 * expectancy from twelve trades is noise wearing a conclusion's clothing.
 * The marginal view answers the same practical questions ("does this work
 * in a bear trend", "does high volatility hurt") at 5-10x the sample size.
 * Both are reported; neither replaces the other.
 */
export function marginalRegimeCells(
  trades: Array<TradeRecord & { regimeTags: string[] }>
): RegimeCell[] {
  const dimensionOf = (tag: string): RegimeCell["dimension"] =>
    tag === "bull" || tag === "bear" || tag === "neutral"
      ? "trend"
      : tag.endsWith("-vol")
        ? "volatility"
        : "structure";

  const tags = Array.from(new Set(trades.flatMap((t) => t.regimeTags)));
  return tags
    .map((tag) => {
      const subset = trades.filter((t) => t.regimeTags.includes(tag));
      const adequacy = classifySample(subset.length);
      return {
        label: tag,
        dimension: dimensionOf(tag),
        n: subset.length,
        adequacy,
        /*
         * Withheld entirely below the "insufficient" line, even though
         * computeTradeStats would happily return numbers from 10 trades —
         * its MIN_SAMPLE_N floor is a computation guard, not a publication
         * standard. Labelling a cell insufficient and then printing its
         * expectancy anyway invites exactly the reading the label exists to
         * prevent.
         */
        stats: adequacy === "insufficient" ? null : computeTradeStats(subset),
      };
    })
    .sort((a, b) => b.n - a.n);
}
