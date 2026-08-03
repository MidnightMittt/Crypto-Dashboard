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
