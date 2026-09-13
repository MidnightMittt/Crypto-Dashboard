import { describe, it, expect } from "vitest";
import {
  AssetPivotAccumulator,
  NEUTRAL_PIVOTS,
  PIVOT_MIN_OBSERVATIONS,
  PIVOT_MIN_OFFSET,
  PIVOT_SIGMA_GATE,
  PivotAccumulator,
  PivotEstimate,
  ScorePivotArtifact,
  pivotIsCredible,
  pivotsForAsset,
  recentreScore,
} from "./scorePivots";
import { DIRECTIONAL_THRESHOLD } from "./scoring";
import { ENGINE_VERSION } from "./engineVersion";

const est = (pivot: number, n: number, sd: number): PivotEstimate => ({ pivot, n, sd });

describe("PIVOT_MIN_OFFSET", () => {
  /**
   * THE PROMISE MADE IN scorePivots.ts's COMMENT, ENFORCED.
   *
   * The materiality floor exists because a pivot smaller than the deadband it
   * shifts cannot reliably change an answer — it can only add noise. That
   * argument is only true while the two numbers are equal, and the constant is
   * deliberately NOT imported from scoring.ts (which imports this module, so
   * the dependency would invert). This test is the substitute for that import.
   * If DIRECTIONAL_THRESHOLD moves, this fails and the reasoning gets re-read
   * rather than silently invalidated.
   */
  it("is pinned to DIRECTIONAL_THRESHOLD, the deadband it has to clear", () => {
    expect(PIVOT_MIN_OFFSET).toBe(DIRECTIONAL_THRESHOLD);
  });
});

describe("pivotIsCredible", () => {
  it("rejects an estimate below the observation floor however extreme it looks", () => {
    expect(pivotIsCredible(est(20, PIVOT_MIN_OBSERVATIONS - 1, 1))).toBe(false);
    expect(pivotIsCredible(est(20, PIVOT_MIN_OBSERVATIONS, 1))).toBe(true);
  });

  it("rejects a statistically clean but IMMATERIAL offset", () => {
    // The leadingDrivers case that the first build shipped and the measurement
    // caught: median 47, sd 20, n 1448. Its standard error is ~0.66, so a
    // 3-point offset is over four sigma — significant, and still not worth
    // correcting, because 3 < the 6-point deadband it would be shifting.
    const leadingDrivers = est(47, 1448, 20);
    const se = (1.2533 * 20) / Math.sqrt(1448);
    expect(Math.abs(47 - 50) / se).toBeGreaterThan(PIVOT_SIGMA_GATE);
    expect(pivotIsCredible(leadingDrivers)).toBe(false);
  });

  it("accepts an offset that is both material and distinguishable from zero", () => {
    // positioning as actually measured: 33 for BTC on the full replay.
    expect(pivotIsCredible(est(33, 1448, 10))).toBe(true);
  });

  it("rejects a material offset that its own noise cannot support", () => {
    // Same 17-point offset, but only 30 observations of a very wide series:
    // SE = 1.2533*60/sqrt(30) = 13.7, so 17 is under two of them.
    expect(pivotIsCredible(est(33, 30, 60))).toBe(false);
  });
});

describe("recentreScore", () => {
  it("is the identity when there is no pivot", () => {
    expect(recentreScore(33, null)).toBe(33);
    expect(recentreScore(33, undefined)).toBe(33);
  });

  it("is the identity when the pivot exists but is not credible", () => {
    // The gate is re-asked here, not just at estimation time, so an artifact
    // hand-edited to contain an immaterial pivot still cannot move a score.
    expect(recentreScore(33, est(47, 1448, 20))).toBe(33);
  });

  it("translates so the pivot lands exactly on 50", () => {
    expect(recentreScore(33, est(33, 1448, 10))).toBe(50);
  });

  it("preserves distances, which is what keeps DIRECTIONAL_THRESHOLD meaningful", () => {
    const p = est(33, 1448, 10);
    expect(recentreScore(40, p) - recentreScore(30, p)).toBe(10);
  });

  it("clamps to the published 0-100 range", () => {
    expect(recentreScore(99, est(30, 1448, 10))).toBe(100);
    expect(recentreScore(1, est(70, 1448, 10))).toBe(0);
  });
});

describe("PivotAccumulator", () => {
  const feed = (acc: PivotAccumulator, values: number[]) => values.forEach((v) => acc.observe(v));

  it("withholds an estimate until the observation floor is reached", () => {
    const acc = new PivotAccumulator();
    feed(acc, Array.from({ length: PIVOT_MIN_OBSERVATIONS - 1 }, () => 30));
    expect(acc.estimate()).toBeNull();
    acc.observe(30);
    expect(acc.estimate()?.pivot).toBe(30);
  });

  it("reports the median, not the mean, so a tail day cannot set the pivot", () => {
    // Ten extreme days against forty ordinary ones. The mean is dragged to
    // 41.7; the median is untouched, which is the whole reason the pivot is a
    // median. Scores are clamped to 0-100 so 100 is the worst case available.
    const acc = new PivotAccumulator();
    feed(acc, Array.from({ length: 40 }, () => 30));
    feed(acc, Array.from({ length: 10 }, () => 100));
    // The tail days do still reach `sd`, and a noisy enough scope loses its
    // pivot on the sigma gate even with a decisive-looking median — asserted
    // directly on pivotIsCredible above rather than reconstructed here.
    expect(acc.estimate()?.pivot).toBe(30);
  });

  it("returns null for a scope that genuinely sits at 50", () => {
    const acc = new PivotAccumulator();
    feed(acc, Array.from({ length: 500 }, (_, i) => 50 + (i % 5) - 2));
    expect(acc.estimate()).toBeNull();
  });

  /**
   * THE RATCHET REGRESSION. An earlier build latched credibility on first
   * qualification, and leadingDrivers then kept a correction for two years
   * after its distribution had moved back to centre. Materiality is a claim
   * about the present.
   */
  it("gives the pivot BACK when the scope re-centres", () => {
    const acc = new PivotAccumulator();
    feed(acc, Array.from({ length: 60 }, () => 25));
    expect(acc.estimate()?.pivot).toBe(25);
    // Enough centred observations to drag the running median past the floor.
    feed(acc, Array.from({ length: 200 }, () => 50));
    expect(acc.estimate()).toBeNull();
  });
});

describe("AssetPivotAccumulator", () => {
  it("keeps categories independent of one another", () => {
    const acc = new AssetPivotAccumulator();
    for (let i = 0; i < 60; i++) {
      acc.observeCategory("positioning", 33);
      acc.observeCategory("risk", 50);
    }
    const p = acc.pivots();
    expect(p.categories.positioning?.pivot).toBe(33);
    expect(p.categories.risk).toBeUndefined();
  });

  /**
   * The composite is built FROM recentred categories, so the day a category
   * pivot first fires it starts measuring a different quantity. Observations
   * from before that describe the old one and pooling them would estimate the
   * pivot on a mixture of two engines.
   */
  it("restarts the composite's history when the credible category set changes", () => {
    const acc = new AssetPivotAccumulator();
    for (let i = 0; i < 60; i++) {
      acc.pivots();
      acc.observeComposite(30);
    }
    // No category has qualified yet, so this history is all one regime.
    expect(acc.pivots().composite?.n).toBe(60);

    // Now let positioning qualify. The next pivots() call must notice.
    for (let i = 0; i < 60; i++) acc.observeCategory("positioning", 33);
    const after = acc.pivots();
    expect(after.categories.positioning).toBeDefined();
    expect(after.composite).toBeNull();

    for (let i = 0; i < 40; i++) {
      acc.pivots();
      acc.observeComposite(30);
    }
    expect(acc.pivots().composite?.n).toBe(40);
  });

  it("reports nothing before anything is observed", () => {
    const p = new AssetPivotAccumulator().pivots();
    expect(p.composite).toBeNull();
    expect(p.categories).toEqual({});
  });
});

describe("pivotsForAsset", () => {
  const artifact: ScorePivotArtifact = {
    engineVersion: "9.0.0",
    generatedAt: "2026-09-13T00:00:00.000Z",
    through: "2026-07-31",
    assets: { BTC: { composite: null, categories: { positioning: est(33, 1448, 10) } } },
  };

  it("hands back the calibration for a replayed asset under a matching engine", () => {
    expect(pivotsForAsset(artifact, "9.0.0", "BTC").categories.positioning?.pivot).toBe(33);
  });

  /**
   * The failure mode that matters. A pivot describes a metric mix and a set of
   * category weights; applied to a different engine it recentres today's
   * scores on yesterday's typical day, silently. Reverting to the hard 50 is
   * wrong in a way that is already documented.
   */
  it("refuses an artifact stamped for a different engine", () => {
    expect(pivotsForAsset(artifact, "10.0.0", "BTC")).toBe(NEUTRAL_PIVOTS);
  });

  it("refuses a missing artifact rather than throwing", () => {
    expect(pivotsForAsset(null, "9.0.0", "BTC")).toBe(NEUTRAL_PIVOTS);
  });

  it("leaves an asset that was never calibrated at 50", () => {
    // Equities and the search surface reach buildMarketBias with no entry here.
    expect(pivotsForAsset(artifact, "9.0.0", "AAPL")).toBe(NEUTRAL_PIVOTS);
  });
});

describe("the shipped artifact", () => {
  /**
   * THE STALENESS TRIPWIRE. src/data/scorePivots.json is regenerated only by a
   * full replay, which needs the backtest corpus and COINALYZE_API_KEY — so CI
   * cannot refresh it (see BLOCKED_ON_BACKTEST_CORPUS in studyArtifacts.ts).
   * That makes a version bump without a regeneration entirely plausible, and
   * its consequence is silent: `pivotsForAsset` would revert the live site to
   * pivot 50 and nothing would say so. This test says so.
   */
  it("is stamped for the running engine", async () => {
    const shipped = (await import("@/data/scorePivots.json")) as unknown as { default: ScorePivotArtifact };
    const artifact = shipped.default ?? (shipped as unknown as ScorePivotArtifact);
    expect(artifact.engineVersion).toBe(ENGINE_VERSION);
  });

  it("still contains the positioning pivot the 9.1.0 entry claims", async () => {
    const shipped = (await import("@/data/scorePivots.json")) as unknown as { default: ScorePivotArtifact };
    const artifact = shipped.default ?? (shipped as unknown as ScorePivotArtifact);
    for (const asset of ["BTC", "ETH"]) {
      const p = pivotsForAsset(artifact, ENGINE_VERSION, asset);
      expect(p.categories.positioning, `${asset} lost its positioning pivot`).toBeDefined();
      // Measured 33/32. A wide band: this asserts the correction still EXISTS
      // and still points the same way, not that a re-measurement reproduced a
      // number to the point.
      expect(p.categories.positioning!.pivot).toBeGreaterThan(20);
      expect(p.categories.positioning!.pivot).toBeLessThan(50 - PIVOT_MIN_OFFSET);
    }
  });
});
