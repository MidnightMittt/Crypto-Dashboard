import { describe, expect, it } from "vitest";
import { assessEdge, EdgeRecord, mayVote, wilsonLowerBound } from "./edgeGate";

const record = (over: Partial<EdgeRecord> = {}): EdgeRecord => ({
  winRate: 0.6,
  baseRate: 0.5,
  effectiveN: 300,
  holdingPeriod: "24h",
  ...over,
});

describe("wilsonLowerBound", () => {
  /*
   * Hand-checkable anchors rather than a reimplementation of the formula in
   * the assertion, which would only prove the code equals itself.
   */
  it("is far below the point estimate on a tiny sample, and close on a large one", () => {
    const small = wilsonLowerBound(0.6, 10);
    const large = wilsonLowerBound(0.6, 1000);
    expect(small).toBeLessThan(0.35);
    expect(large).toBeGreaterThan(0.56);
    expect(large).toBeLessThan(0.6);
  });

  it("never returns a negative bound, however extreme the input", () => {
    expect(wilsonLowerBound(0, 5)).toBe(0);
    expect(wilsonLowerBound(0.01, 3)).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 rather than NaN for a degenerate sample", () => {
    expect(wilsonLowerBound(0.6, 0)).toBe(0);
    expect(wilsonLowerBound(Number.NaN, 100)).toBe(0);
  });
});

describe("assessEdge", () => {
  it("passes a large-sample record whose lower bound clears the base rate", () => {
    // etfFlows' real shape: 65.7% on 271 independent observations.
    const a = assessEdge(record({ winRate: 0.657, baseRate: 0.5, effectiveN: 271 }));
    expect(a.verdict).toBe("edge");
    expect(mayVote(a)).toBe(true);
    expect(a.lowerBound).toBeGreaterThan(0.5);
    expect(a.sentence).toContain("allowed to move a decision");
  });

  /*
   * THE SMALL-SAMPLE TRAP. funding's real record is a 30.3% win rate on an
   * effective n of 17 — the point estimate is dramatic, and the interval is
   * so wide it says almost nothing. What disqualifies it is that the point
   * estimate sits below the null, not that the bound is low.
   */
  it("calls a below-null record what it is, and does not let it vote", () => {
    const a = assessEdge(record({ winRate: 0.303, baseRate: 0.5, effectiveN: 17 }));
    expect(a.verdict).toBe("below-base-rate");
    expect(mayVote(a)).toBe(false);
    expect(a.sentence).toContain("Doing nothing beat it");
  });

  /*
   * squeezeRisk carries the engine's second-largest weight and measures
   * 50.8% against a 50.0% null on 1,174 observations. A large sample makes
   * the interval tight, and the answer it tightens around is "nothing".
   */
  it("separates a measured coin flip from an absence of measurement", () => {
    const coin = assessEdge(record({ winRate: 0.508, baseRate: 0.5, effectiveN: 1174 }));
    expect(coin.verdict).toBe("not-distinguishable");
    expect(coin.sentence).toContain("coin flip as measured");
    expect(mayVote(coin)).toBe(false);

    const absent = assessEdge(null);
    expect(absent.verdict).toBe("unmeasured");
    expect(absent.sentence).toContain("absence of evidence");
    expect(mayVote(absent)).toBe(false);
  });

  /*
   * The bar is the drift-matched null, not 50%. A long-only signal in a
   * rising market clears 50% by holding, and calling that an edge is the
   * error the drift null exists to prevent.
   */
  it("uses the base rate as the bar, so drift cannot masquerade as skill", () => {
    const againstCoinFlip = assessEdge(record({ winRate: 0.58, baseRate: 0.5, effectiveN: 900 }));
    const againstRealDrift = assessEdge(record({ winRate: 0.58, baseRate: 0.62, effectiveN: 900 }));
    expect(againstCoinFlip.verdict).toBe("edge");
    expect(againstRealDrift.verdict).toBe("below-base-rate");
  });

  it("requires the edge to clear costs, not merely the null", () => {
    const r = record({ winRate: 0.545, baseRate: 0.5, effectiveN: 2000 });
    expect(assessEdge(r, 0).verdict).toBe("edge");
    // Same record, now asked to clear an extra 3pp of trading friction.
    expect(assessEdge(r, 3).verdict).toBe("not-distinguishable");
  });

  /*
   * Overlapping windows share price action, so raw n overstates independent
   * evidence. A record that never had its effective sample computed must
   * withhold a verdict rather than quietly borrow the raw count.
   */
  it("withholds a verdict when the effective sample is missing", () => {
    const a = assessEdge(record({ effectiveN: null }));
    expect(a.verdict).toBe("unmeasured");
    expect(a.lowerBound).toBeNull();
  });
});
