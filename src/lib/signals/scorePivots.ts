/**
 * WHAT "50" MEANS, AND WHY IT WASN'T TRUE.
 *
 * `verdictFromScore` calls a score bearish at 44 and bullish at 56, pivoting
 * on a hard 50. That is correct only if 50 is where the engine actually sits
 * when it has nothing to say. It is not, and the gap is not small:
 *
 *   scope                    median   share below 50
 *   composite (BTC)              41             73.3%
 *   composite (ETH)              41             82.3%
 *   positioning (BTC)            33             81.4%
 *   positioning (ETH)            32             93.8%
 *   leadingDrivers               47             53.7%   <- the one that is fine
 *
 * The cause is arithmetic, not a bug in any metric. `combineCategoryScores`
 * converts each category back to a signed pull with `(c.score - 50) / 50`,
 * so a category whose ordinary reading is 32 contributes a permanent -0.36
 * bearish pull on a completely unremarkable day. Positioning's metrics —
 * funding, open interest, long/short, basis — read "leveraged longs are
 * crowded" most of the time because in crypto perpetual markets that is
 * simply TRUE most of the time. The metrics are right. Calling their
 * ordinary state "bearish today" is what is wrong.
 *
 * The measured consequence: 61.9% of replay days shipped a bearish verdict,
 * and those 1789 bearish days preceded a +0.326% RISE. The score itself
 * carries real information — top-decile-minus-bottom-decile forward return
 * is +3.408% (t = 2.42), Spearman rho 0.0833 — and the hard pivot was
 * throwing it away by cutting the distribution in the wrong place.
 *
 * THE FIX: every score is stated relative to its own history.
 *
 * A score is recentred by translation, `score - pivot + 50`, where `pivot`
 * is the median of that same scope's own raw scores. The recentred number is
 * what the page shows and what every threshold reads, so "50" recovers its
 * plain meaning — a typical day for this engine — and `verdictFromScore`,
 * `DIRECTIONAL_THRESHOLD`, `intensityLabel` and the UI meter all keep
 * working unmodified. `rawScore` is carried alongside so the untranslated
 * evidence balance is never hidden.
 *
 * WHY TRANSLATE RATHER THAN MOVE THE THRESHOLD. Leaving the score at 41 and
 * teaching the verdict to pivot elsewhere would put a NEUTRAL badge above a
 * meter filled to 41 and an `intensityLabel` reading "Leaning Bearish" — a
 * card contradicting itself in three places. Fixing that means threading the
 * pivot through the label, the meter and every consumer that compares a
 * score to 50, which is strictly more surface area than translating once.
 * One number, one meaning.
 *
 * WHY EXPANDING, NOT A ROLLING WINDOW. The pivot answers "is this score high
 * or low FOR THIS ENGINE?" Where the engine sits is a property of its
 * construction — its metric mix, weights and thresholds — not of the market,
 * and that property is fixed for as long as the engine is. `ENGINE_VERSION`
 * already marks the moment it changes. So the estimator is the full history
 * under the current engine version, and the pivot is invalidated by an
 * engine change rather than by the passage of time.
 *
 * A rolling window would additionally chase MARKET drift, and that is the
 * signal's job, not the pivot's. If the market genuinely trends up and the
 * engine consequently spends more days bullish, that is the engine reporting
 * something true. A 365-day pivot would define it away by construction and
 * force a fixed bullish/bearish mix no matter what price did — the pivot
 * eating the signal. Expanding also needs no fitted window length, so there
 * is no constant here chosen off an outcome table.
 *
 * THE COST, STATED PLAINLY. An expanding median lags a drifting series, and
 * the composite is corrected only INDIRECTLY — its own residual offset falls
 * below PIVOT_MIN_OFFSET once positioning is fixed, so it gets no pivot of its
 * own and simply follows. It therefore lands at 53, not 50: 25.7% of days
 * bearish against 35.7% bullish. That is a real residual, it sits inside the
 * deadband, and it is not tuned away here. Shorter windows centre better (90
 * days puts the median exactly on 50) and separate worse; picking one off that
 * table is the selection procedure this comment just refused.
 *
 * WHAT THE FIX IS WORTH, MEASURED AGAINST THE ENGINE THAT ACTUALLY RUNS.
 *
 * After both credibility gates the ONLY surviving pivot is positioning, 33 for
 * BTC and 32 for ETH. Replaying the committed artifact rather than the
 * point-in-time walk — i.e. what live does — the bearish verdict stops
 * preceding a rise (+0.326% -> -0.890%, t = -2.76) and the share of days
 * called bearish falls 61.9% -> 25.7%. But bullish-minus-bearish SEPARATION
 * does not improve: +0.120%, SE 0.793, t = 0.15, because the bullish leg
 * dilutes by as much as the bearish leg gains.
 *
 * So this is a calibration fix and must never be cited as a performance one.
 * The larger separation improvement measured under a point-in-time walk
 * (+1.445%, t = 1.46) belongs to an engine that will not run: it came almost
 * entirely from recentring leadingDrivers during 2022-2025, and that scope has
 * since genuinely re-centred, so the shipped artifact correctly excludes it.
 * The full accounting is the 9.1.0 entry in scripts/backtest/version.ts.
 */
import { Category } from "./types";

/**
 * The pivot for one scope, carried with the evidence that it deserves to be
 * anything other than 50 — see `pivotIsCredible`.
 */
export interface PivotEstimate {
  /** Median of this scope's own raw scores. */
  pivot: number;
  /** How many raw scores it was estimated from. */
  n: number;
  /** Their standard deviation, for the credibility gate. */
  sd: number;
}

export interface ScorePivots {
  composite: PivotEstimate | null;
  categories: Partial<Record<Category, PivotEstimate>>;
}

/** No calibration: every scope pivots on 50, which is exactly today's behavior. */
export const NEUTRAL_PIVOTS: ScorePivots = { composite: null, categories: {} };

/**
 * Below this the median and the standard deviation are not worth computing,
 * never mind trusting. A floor for estimability, not a tuned burn-in — the
 * real decision is `pivotIsCredible` below.
 */
export const PIVOT_MIN_OBSERVATIONS = 30;

/**
 * How many standard errors the pivot must sit away from 50 before it is used.
 * Two, the ordinary significance convention. Nothing about this number was
 * chosen by looking at forward returns.
 */
export const PIVOT_SIGMA_GATE = 2;

/**
 * SIGNIFICANT IS NOT THE SAME AS WORTH CORRECTING, AND THE FIRST BUILD OF
 * THIS FILE LEARNED IT THE EXPENSIVE WAY.
 *
 * With only the sigma gate, leadingDrivers qualified: median 47, an offset of
 * 3 against a standard error of 0.65 at full sample, comfortably significant.
 * It was also the one category that did not need correcting — 53.7% of its
 * days already sat below 50. Recentring it moved its median to 61 and left
 * only 24.8% below, replacing "positioning is always bearish" with
 * "leadingDrivers is usually bullish". Worse, its point-in-time pivot was not
 * stable: the applied shift ranged over 25 points across the walk, because
 * that scope's raw distribution genuinely moves between eras and an expanding
 * median chases it. A 3-point offset was authorising a 25-point correction.
 *
 * So a pivot must also be MATERIAL: at least as large as the deadband it
 * shifts. Below `DIRECTIONAL_THRESHOLD` the correction is smaller than the
 * resolution of the verdict it is correcting, so it cannot reliably change an
 * answer — it can only add noise. Kept as its own constant rather than
 * imported from scoring.ts, which imports this file; scorePivots.test.ts pins
 * the two together so the relationship is enforced rather than commented.
 */
export const PIVOT_MIN_OFFSET = 6;

/**
 * IS THIS PIVOT BETTER THAN NO PIVOT?
 *
 * The temptation is to demand a long burn-in so the median is precise. That
 * gets the comparison backwards. During a burn-in the pivot is 50, which for
 * positioning is an error of SEVENTEEN POINTS. Any estimate whose own
 * standard error is smaller than that is an improvement, and waiting is the
 * expensive choice, not the safe one.
 *
 * So the gate is not "is n large" but "is the offset from 50 distinguishable
 * from zero": the median's standard error is 1.2533 x sd / sqrt(n) for a
 * roughly normal series, and the pivot is used once |pivot - 50| clears two
 * of them. This is self-calibrating in both directions. Positioning, offset
 * ~17 with sd ~10, clears it within a handful of observations. leadingDrivers,
 * offset ~3 with sd ~20, needs several hundred — correctly, because a scope
 * that already sits at 50 should never be moved off it.
 */
export function pivotIsCredible(e: PivotEstimate): boolean {
  if (e.n < PIVOT_MIN_OBSERVATIONS) return false;
  const offset = Math.abs(e.pivot - 50);
  if (offset < PIVOT_MIN_OFFSET) return false;
  const standardError = (1.2533 * e.sd) / Math.sqrt(e.n);
  return offset >= PIVOT_SIGMA_GATE * standardError;
}

/**
 * The raw score restated against its scope's own history. A translation, so
 * the spread and therefore the meaning of DIRECTIONAL_THRESHOLD are
 * unchanged; clamped because 0-100 is the published range, which compresses
 * the tail on whichever side the pivot moved toward.
 */
export function recentreScore(raw: number, pivot: PivotEstimate | null | undefined): number {
  if (!pivot || !pivotIsCredible(pivot)) return raw;
  return Math.max(0, Math.min(100, Math.round(raw - pivot.pivot + 50)));
}

/**
 * POINT-IN-TIME ACCUMULATION.
 *
 * The replay walks each asset forward one day at a time and must score day N
 * using only days before it. `pivot()` reports what was knowable at the open;
 * `observe()` files the day's RAW score afterwards. Feeding it the recentred
 * score instead would compound the correction on itself, so the caller's
 * contract is raw in, raw out.
 *
 * THE GATE IS RE-ASKED EVERY DAY, AND IT WAS A RATCHET FIRST.
 *
 * The original build latched the gate on the reasoning that a scope which has
 * earned its pivot should not lose it to boundary jitter. That is wrong for
 * the half of `pivotIsCredible` that asks whether the offset is MATERIAL,
 * because materiality is a claim about the present, not a qualification the
 * scope keeps. leadingDrivers proved it: its running median started near 25,
 * latched the pivot at a genuinely large offset, then drifted up to 47 over
 * the walk while the latch kept applying a correction the scope no longer
 * needed. That scope's raw distribution really does move between eras —
 * macro liquidity and ETF flows read differently in 2022 and 2026 — so a
 * one-way gate turns a temporary offset into a permanent one.
 *
 * The jitter the ratchet was protecting against is bounded and rare: the gate
 * can only flip when the running MEDIAN crosses PIVOT_MIN_OFFSET, which moves
 * slowly, and the resulting step is exactly PIVOT_MIN_OFFSET points — smaller
 * than the score's own daily standard deviation. Hysteresis would need a
 * second constant to fix a smaller problem than it introduces.
 */
export class PivotAccumulator {
  private readonly samples: number[] = [];
  private sum = 0;
  private sumSq = 0;

  observe(rawScore: number): void {
    this.samples.push(rawScore);
    this.sum += rawScore;
    this.sumSq += rawScore * rawScore;
  }

  get count(): number {
    return this.samples.length;
  }

  /** What was knowable before today's score existed. Null until it is credible. */
  estimate(): PivotEstimate | null {
    const n = this.samples.length;
    if (n < PIVOT_MIN_OBSERVATIONS) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pivot =
      n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const variance = Math.max(0, (this.sumSq - (this.sum * this.sum) / n) / (n - 1));
    const e: PivotEstimate = { pivot, n, sd: Math.sqrt(variance) };
    return pivotIsCredible(e) ? e : null;
  }
}

/**
 * Every scope for one asset, accumulated together.
 *
 * THE COMPOSITE MEASURES A MOVING TARGET UNTIL THE CATEGORIES SETTLE.
 *
 * The composite is built FROM the recentred categories, so the day a
 * category pivot first fires, the composite's own distribution shifts — and
 * every composite observation collected before that describes a different
 * quantity. Pooling them would estimate the composite pivot on a mixture of
 * two engines, which is the same mistake `pivotsForAsset` refuses across an
 * ENGINE_VERSION boundary, committed silently inside one run.
 *
 * So the composite accumulator is discarded and restarted whenever the set of
 * categories carrying a credible pivot changes. The cost is that the
 * composite pivot arrives later than the category pivots, and arrives late
 * again after any change in which categories qualify — which is correct: it
 * cannot be estimated before the thing it is estimating exists. `n` on the
 * shipped composite estimate is how many days it has actually had, and it
 * being lower than the category `n` is this reset, not a gap in the data.
 */
export class AssetPivotAccumulator {
  private composite = new PivotAccumulator();
  private compositeRegime = "";
  private readonly categories = new Map<Category, PivotAccumulator>();

  private categoryAcc(c: Category): PivotAccumulator {
    let acc = this.categories.get(c);
    if (!acc) {
      acc = new PivotAccumulator();
      this.categories.set(c, acc);
    }
    return acc;
  }

  /** The pivots to score today with — strictly from days already observed. */
  pivots(): ScorePivots {
    const categories: Partial<Record<Category, PivotEstimate>> = {};
    for (const [c, acc] of this.categories) {
      const e = acc.estimate();
      if (e) categories[c] = e;
    }
    const regime = Object.keys(categories).sort().join(",");
    if (regime !== this.compositeRegime) {
      this.compositeRegime = regime;
      this.composite = new PivotAccumulator();
    }
    return { composite: this.composite.estimate(), categories };
  }

  /**
   * The composite BEFORE recentring, i.e. the combination of already-recentred
   * categories. Call `pivots()` first on each day — that is what detects a
   * regime change and clears the stale history.
   */
  observeComposite(rawScore: number): void {
    this.composite.observe(rawScore);
  }

  observeCategory(c: Category, rawScore: number): void {
    this.categoryAcc(c).observe(rawScore);
  }
}

/**
 * The shipped calibration. Keyed by asset, and stamped with the engine
 * version it was measured under — see `pivotsForAsset`.
 */
export interface ScorePivotArtifact {
  engineVersion: string;
  generatedAt: string;
  /** Last replay day that fed the estimate, so staleness is legible. */
  through: string;
  assets: Record<string, ScorePivots>;
}

/**
 * A PIVOT MEASURED ON A DIFFERENT ENGINE IS NOT A PIVOT.
 *
 * The offsets this corrects for are a property of the metric mix and the
 * category weights. Change either and the distribution moves, so applying a
 * stale calibration would recentre today's engine on yesterday's typical day
 * and do it silently. If the artifact's `engineVersion` does not match the
 * running one, this returns the neutral pivots — the site reverts to the
 * hard 50 it has always used, which is wrong in a known and already
 * documented way rather than wrong in a new and invisible one.
 *
 * The same rule handles the assets that were never calibrated at all. The
 * replay universe is BTC and ETH; equities, the search surface and every
 * other symbol reach `buildMarketBias` with no entry here and keep pivot 50.
 * The correction applies exactly where it was measured.
 */
export function pivotsForAsset(
  artifact: ScorePivotArtifact | null,
  engineVersion: string,
  asset: string
): ScorePivots {
  if (!artifact || artifact.engineVersion !== engineVersion) return NEUTRAL_PIVOTS;
  return artifact.assets[asset] ?? NEUTRAL_PIVOTS;
}
