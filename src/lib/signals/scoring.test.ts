import { describe, it, expect } from "vitest";
import {
  computeWeightedScore,
  verdictFromScore,
  intensityLabel,
  metricWeight,
  weightForBasis,
  metricRole,
  EDGE_CLUSTERS,
  METRIC_WEIGHTS,
  RESTATED_READS,
} from "./scoring";
import { MetricVerdict, Verdict } from "./types";

const metric = (id: string, verdict: Verdict, confidence = 80): MetricVerdict => ({
  id,
  label: id,
  verdict,
  confidence,
  confidenceBasis: "",
  explanation: "",
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger: null,
});

describe("computeWeightedScore", () => {
  it("returns null when nothing has real weight", () => {
    expect(computeWeightedScore([metric("liquidations", "bullish")], metricWeight)).toBeNull();
  });

  it("scores 100 when every weighted metric agrees at full confidence", () => {
    const result = computeWeightedScore([metric("funding", "bullish", 100)], metricWeight)!;
    expect(result.score).toBe(100);
    expect(result.verdict).toBe("bullish");
  });

  it("renormalizes across a custom weight function", () => {
    // Equal custom weights should fully cancel regardless of METRIC_WEIGHTS.
    const equalWeight = () => 1;
    const result = computeWeightedScore(
      [metric("funding", "bullish", 100), metric("basis", "bearish", 100)],
      equalWeight
    )!;
    expect(result.score).toBe(50);
  });
});

describe("verdictFromScore", () => {
  it("requires clearing the directional threshold to leave neutral", () => {
    expect(verdictFromScore(55)).toBe("neutral");
    expect(verdictFromScore(56)).toBe("bullish");
    expect(verdictFromScore(45)).toBe("neutral");
    expect(verdictFromScore(44)).toBe("bearish");
  });
});

describe("intensityLabel", () => {
  it("reads exactly neutral within the directional threshold", () => {
    expect(intensityLabel(50)).toBe("Neutral");
    expect(intensityLabel(55)).toBe("Neutral"); // distance 5 < threshold 6
  });

  it("escalates leaning -> plain -> strongly as distance from 50 grows", () => {
    expect(intensityLabel(60)).toBe("Leaning Bullish"); // distance 10
    expect(intensityLabel(70)).toBe("Bullish"); // distance 20
    expect(intensityLabel(85)).toBe("Strongly Bullish"); // distance 35
  });

  it("mirrors the same buckets on the bearish side", () => {
    expect(intensityLabel(40)).toBe("Leaning Bearish");
    expect(intensityLabel(30)).toBe("Bearish");
    expect(intensityLabel(15)).toBe("Strongly Bearish");
  });

  it("sits exactly on the documented boundaries correctly", () => {
    expect(intensityLabel(56)).toBe("Leaning Bullish"); // distance == threshold, no longer neutral
    expect(intensityLabel(65)).toBe("Bullish");
    expect(intensityLabel(80)).toBe("Strongly Bullish");
  });
});

/**
 * ONE INPUT, ONE DIRECTIONAL CLAIM.
 *
 * `squeezeRisk` and `longShort` both read the long/short ratio — squeezeRisk
 * via the crowded side that funding and the ratio agree on — and they mapped
 * it to OPPOSITE verdicts. On all 1181 replay observations where both took a
 * position they took opposing ones, so the composite ran squeezeRisk at
 * 0.14 - 0.08 = 0.06 whenever both fired: a deterministic 57% cancellation
 * rather than the double vote it looked like.
 *
 * The measured case for keeping squeezeRisk's direction rather than
 * longShort's is not that the fade works — over those 1181 observations the
 * fade reads t=0.04 at 24h and the trend t=-0.04 on nEff=49, an exact mirror
 * because they are the same observations. It is that squeezeRisk requires
 * funding to confirm the crowded side, so it uses strictly more information
 * than the ratio alone, and it is the one of the two with a historical source.
 */
describe("longShort is a description, not a vote", () => {
  it("carries no weight in the edge composite", () => {
    expect(metricWeight("longShort")).toBe(0);
    // The metric it used to oppose still votes, at its full weight.
    expect(metricWeight("squeezeRisk")).toBe(0.14);
  });

  it("cannot move the score, in either direction, at any confidence", () => {
    const base = computeWeightedScore(
      [metric("squeezeRisk", "bearish"), metric("etfFlows", "bearish")],
      metricWeight
    )!;

    for (const verdict of ["bullish", "bearish", "neutral"] as Verdict[]) {
      const withLongShort = computeWeightedScore(
        [
          metric("squeezeRisk", "bearish"),
          metric("etfFlows", "bearish"),
          metric("longShort", verdict, 100),
        ],
        metricWeight
      )!;
      expect(withLongShort.score).toBe(base.score);
      expect(withLongShort.confidence).toBe(base.confidence);
      expect(withLongShort.totalWeight).toBe(base.totalWeight);
    }
  });

  /*
   * The cancellation itself, reproduced as arithmetic. Before the demotion
   * these two opposed verdicts left 0.06 of net bearish weight; now the
   * crowded-side read stands at its own 0.14 and the score is identical to
   * the one squeezeRisk produces alone.
   */
  it("leaves squeezeRisk at full weight instead of netting it down", () => {
    const opposed = computeWeightedScore(
      [metric("squeezeRisk", "bearish", 100), metric("longShort", "bullish", 100)],
      metricWeight
    )!;
    const alone = computeWeightedScore([metric("squeezeRisk", "bearish", 100)], metricWeight)!;

    expect(opposed.score).toBe(alone.score);
    expect(opposed.totalWeight).toBeCloseTo(0.14, 10);
    // Unopposed and fully confident, so the read is as bearish as it gets.
    expect(opposed.score).toBe(0);
  });
});

/**
 * A DEMOTED READ MUST NOT RE-ENTER THROUGH A WRAPPER.
 *
 * `spotPerpVolume`'s verdict was literally `ctx.technicals.direction`, gated
 * on spot-led turnover. `technicals` is role "state" — it does not vote,
 * because the module census graded it at 49.1% directional accuracy at 4h
 * against a 49.9% base rate on nEff=1098. The wrapper carried that same
 * direction into the edge composite at 0.05 anyway, wearing the label "Spot
 * vs Perp Volume", and on 417 of 2896 replayed days it published a direction
 * that the price module itself had declined to call (strength below 20).
 *
 * The two verdicts agreed on 1648 of 1648 observations where both took a
 * position — rho +1.000, zero opposed cells in the cross-tab. That is not
 * two correlated signals; it is one signal counted twice under two labels.
 *
 * These tests fail if the role or the weight is restored.
 */
describe("spotPerpVolume does not vote, in any basis", () => {
  it("is context, so it carries no weight under either basis", () => {
    expect(metricRole("spotPerpVolume")).toBe("context");
    expect(metricWeight("spotPerpVolume")).toBe(0);
    // "context" not "state" on purpose: the verdict is now permanently
    // neutral, and a permanently-neutral read parked in "state" would be a
    // weight-1 vote for 50 waiting for the first state-basis caller to emit
    // it. Same standing as liquidations.
    expect(weightForBasis("state")("spotPerpVolume")).toBe(0);
    expect(weightForBasis("state")("liquidations")).toBe(0);
    // Control: a real state metric does carry weight under that basis, so
    // the assertion above is measuring the role and not a broken accessor.
    expect(weightForBasis("state")("technicals")).toBe(1);
  });

  it("cannot move the score at any confidence or direction", () => {
    const base = computeWeightedScore(
      [metric("funding", "bullish"), metric("etfFlows", "bearish")],
      metricWeight
    )!;

    for (const verdict of ["bullish", "bearish", "neutral"] as Verdict[]) {
      const withWrapper = computeWeightedScore(
        [
          metric("funding", "bullish"),
          metric("etfFlows", "bearish"),
          metric("spotPerpVolume", verdict, 100),
        ],
        metricWeight
      )!;
      expect(withWrapper.score).toBe(base.score);
      expect(withWrapper.confidence).toBe(base.confidence);
      expect(withWrapper.totalWeight).toBe(base.totalWeight);
    }
  });

  /*
   * The specific defect, stated as arithmetic rather than as a role lookup.
   * technicals is demoted and contributes nothing; if the wrapper's weight
   * came back, this pair would score a full-confidence bullish composite off
   * a read that is not allowed to vote on its own.
   */
  it("gives a demoted price-action direction no route into the composite", () => {
    const both = computeWeightedScore(
      [metric("technicals", "bullish", 100), metric("spotPerpVolume", "bullish", 100)],
      metricWeight
    );
    expect(both).toBeNull(); // nothing with weight, so there is no score at all
  });
});

/**
 * GUARDS ON THE FIX, not on the implementation.
 *
 * A restated read that quietly regains a vote reintroduces the cancellation
 * EDGE_CLUSTERS' comment documents, and it would do so without failing anything
 * else in the suite — the composite would start double-counting again and every
 * number would still look plausible. main's own cap test says as much about its
 * coverage: "this assertion would NOT catch its weight coming back."
 */
describe("restated reads never vote", () => {
  it("gives every restated module zero weight under the edge basis", () => {
    for (const id of Object.keys(RESTATED_READS)) {
      expect(metricWeight(id), `${id} must not vote`).toBe(0);
      expect(METRIC_WEIGHTS[id], `${id} must not carry a declared weight`).toBeUndefined();
    }
  });

  it("keeps restated modules out of the edge clusters, which only describe voters", () => {
    for (const id of Object.keys(RESTATED_READS)) {
      expect(EDGE_CLUSTERS[id], `${id} does not vote, so it cannot be in a voting cluster`).toBeUndefined();
    }
  });

  it("points every restated module at a module that is itself not restated", () => {
    // Guards a restatement chain (a restates b, b restates c), which would make
    // "the score takes the other one's reading" stop naming a real voter.
    for (const [id, r] of Object.entries(RESTATED_READS)) {
      expect(RESTATED_READS[r.restates], `${id} -> ${r.restates} is a chain`).toBeUndefined();
      expect(metricRole(r.restates), `${id} defers to ${r.restates}, which must be classified`).not.toBeNull();
    }
  });

  it("records the replay evidence for the relation it asserts", () => {
    for (const [id, r] of Object.entries(RESTATED_READS)) {
      expect(r.measured.sharedObservations, `${id} needs a measured sample`).toBeGreaterThan(0);
      expect(r.measured.consistent, `${id}'s relation must hold on every shared observation`).toBe(
        r.measured.sharedObservations
      );
      expect(r.disclosure.length, `${id} needs reader-facing copy`).toBeGreaterThan(80);
    }
  });

  it("still classifies longShort, so it is described and graded rather than deleted", () => {
    // `state`, not `context`: it keeps describing positioning. The point of the
    // disclosure is that describing is all it does.
    expect(metricRole("longShort")).toBe("state");
    expect(metricWeight("longShort")).toBe(0);
    expect(RESTATED_READS.longShort.restates).toBe("squeezeRisk");
    expect(RESTATED_READS.longShort.relation).toBe("inverse");
  });

  it("leaves the leverage axis voting exactly once, at its declared weight", () => {
    expect(metricWeight("squeezeRisk")).toBe(0.14);
    expect(metricWeight("longShort")).toBe(0);
  });

  /**
   * spotPerpVolume is NOT in RESTATED_READS because it publishes no direction
   * at all now. That is the condition worth pinning: if its verdict ever goes
   * directional again it becomes a restatement of Price Action, and this test
   * fails before the composite can start borrowing a State read's opinion.
   */
  it("keeps spotPerpVolume out of the table by keeping it non-directional", () => {
    expect(metricRole("spotPerpVolume")).toBe("context");
    expect(metricWeight("spotPerpVolume")).toBe(0);
    expect(METRIC_WEIGHTS.spotPerpVolume).toBeUndefined();
    expect(RESTATED_READS.spotPerpVolume).toBeUndefined();
  });
});
