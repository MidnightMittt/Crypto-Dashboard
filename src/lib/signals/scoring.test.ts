import { describe, it, expect } from "vitest";
import { computeWeightedScore, verdictFromScore, intensityLabel, metricWeight } from "./scoring";
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
