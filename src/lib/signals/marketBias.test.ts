import { describe, it, expect } from "vitest";
import { buildMarketBias, snapshotVerdicts } from "./marketBias";
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
});

const build = (metrics: MetricVerdict[], previous: Record<string, Verdict> | null = null) =>
  buildMarketBias({
    asset: "BTC",
    metrics,
    technicals: null,
    squeezeScore: null,
    previous,
    now: 1_700_000_000_000,
  });

describe("buildMarketBias scoring", () => {
  it("returns null with nothing to score rather than a fabricated neutral", () => {
    expect(build([])).toBeNull();
  });

  it("scores above 50 when the weighted evidence is bullish", () => {
    const bias = build([metric("funding", "bullish"), metric("technicals", "bullish")])!;
    expect(bias.score).toBeGreaterThan(50);
    expect(bias.verdict).toBe("bullish");
  });

  it("scores below 50 when the weighted evidence is bearish", () => {
    const bias = build([metric("funding", "bearish"), metric("technicals", "bearish")])!;
    expect(bias.score).toBeLessThan(50);
    expect(bias.verdict).toBe("bearish");
  });

  it("lands at exactly 50 when equal-weight metrics fully offset", () => {
    // funding and squeezeRisk carry near-identical weight, so one of each
    // should cancel almost exactly.
    const bias = build([metric("funding", "bullish"), metric("funding", "bearish")])!;
    expect(bias.score).toBe(50);
    expect(bias.verdict).toBe("neutral");
  });

  it("stays within 0-100 even when every metric agrees", () => {
    const ids = ["funding", "squeezeRisk", "technicals", "orderFlow", "openInterest", "basis"];
    const bull = build(ids.map((id) => metric(id, "bullish", 100)))!;
    const bear = build(ids.map((id) => metric(id, "bearish", 100)))!;
    expect(bull.score).toBeLessThanOrEqual(100);
    expect(bear.score).toBeGreaterThanOrEqual(0);
  });

  it("lets a low-confidence metric pull less than a well-evidenced one", () => {
    // Same weight class, opposite directions — the confident one should win.
    const bias = build([metric("funding", "bullish", 100), metric("squeezeRisk", "bearish", 10)])!;
    expect(bias.verdict).toBe("bullish");
  });

  it("renormalizes across whatever reported instead of defaulting absences to neutral", () => {
    // A single bullish metric should read strongly bullish, NOT be dragged
    // toward 50 by the thirteen metrics that didn't report.
    const bias = build([metric("funding", "bullish", 100)])!;
    expect(bias.score).toBeGreaterThan(90);
  });

  it("excludes liquidations from the score, since it is backward-looking", () => {
    const withLiq = build([metric("funding", "bullish"), metric("liquidations", "bearish")])!;
    const without = build([metric("funding", "bullish")])!;
    expect(withLiq.score).toBe(without.score);
  });
});

describe("top reasons", () => {
  it("ranks by weight x confidence, not by list order", () => {
    const bias = build([
      metric("coinbasePremium", "bullish", 90), // lightest weight
      metric("funding", "bullish", 90), // heaviest weight
    ])!;
    expect(bias.topBullish[0].id).toBe("funding");
  });

  it("caps each side at five entries", () => {
    const ids = ["funding", "squeezeRisk", "technicals", "orderFlow", "openInterest", "basis", "longShort"];
    const bias = build(ids.map((id) => metric(id, "bullish")))!;
    expect(bias.topBullish).toHaveLength(5);
  });

  it("separates bullish and bearish reasons correctly", () => {
    const bias = build([metric("funding", "bullish"), metric("basis", "bearish")])!;
    expect(bias.topBullish.map((m) => m.id)).toEqual(["funding"]);
    expect(bias.topBearish.map((m) => m.id)).toEqual(["basis"]);
  });
});

describe("what changed", () => {
  it("flags a first reading instead of inventing a delta", () => {
    const bias = build([metric("funding", "bullish")], null)!;
    expect(bias.isFirstReading).toBe(true);
    expect(bias.changes).toHaveLength(0);
  });

  it("reports only metrics whose verdict actually flipped", () => {
    const bias = build([metric("funding", "bullish"), metric("basis", "bearish")], {
      funding: "bearish",
      basis: "bearish",
    })!;
    expect(bias.changes).toHaveLength(1);
    expect(bias.changes[0]).toMatchObject({ label: "funding", from: "bearish", to: "bullish" });
  });

  it("ignores metrics absent from the prior snapshot rather than calling them changed", () => {
    const bias = build([metric("funding", "bullish"), metric("etfFlows", "bullish")], {
      funding: "bullish",
    })!;
    expect(bias.changes).toHaveLength(0);
  });
});

describe("risk assessment", () => {
  const withConflicts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...metric(`m${i}`, "bullish"),
      conflicts: ["something disagrees"],
    }));

  it("reads consistent, calm conditions as low risk", () => {
    const bias = build([metric("funding", "bullish"), metric("basis", "bullish")])!;
    expect(bias.riskLevel).toBe("low");
  });

  it("escalates when many metrics contradict themselves", () => {
    const bias = build(withConflicts(4))!;
    expect(bias.riskLevel).toBe("medium");
    expect(bias.riskRationale).toContain("contradictions");
  });

  it("escalates on an elevated squeeze setup", () => {
    const bias = buildMarketBias({
      asset: "BTC",
      metrics: [metric("funding", "bullish")],
      technicals: null,
      squeezeScore: 85,
      previous: null,
      now: 0,
    })!;
    expect(bias.riskLevel).toBe("medium");
    expect(bias.riskRationale).toContain("squeeze");
  });

  it("reaches high risk when volatility, squeeze and conflict stack up", () => {
    const bias = buildMarketBias({
      asset: "BTC",
      metrics: withConflicts(4),
      technicals: {
        direction: "bearish",
        strength: 50,
        summary: "",
        rsi: 50,
        macdHistogram: 0,
        emaAlignment: "mixed",
        adx: 30,
        atrPct: 5,
        volumeRatio: 1,
        vwapPosition: "below",
        trendStructure: "sideways",
      },
      squeezeScore: 80,
      previous: null,
      now: 0,
    })!;
    expect(bias.riskLevel).toBe("high");
  });

  it("keeps risk independent of direction — a bullish read can still be high risk", () => {
    const bias = buildMarketBias({
      asset: "BTC",
      metrics: [...withConflicts(4), metric("funding", "bullish", 100)],
      technicals: null,
      squeezeScore: 90,
      previous: null,
      now: 0,
    })!;
    expect(bias.verdict).toBe("bullish");
    expect(bias.riskLevel).toBe("high");
  });
});

describe("headline", () => {
  it("names the direction when there is one", () => {
    expect(build([metric("funding", "bullish", 100)])!.headline).toContain("bullish");
  });

  it("says so plainly when evidence is balanced", () => {
    expect(build([metric("funding", "bullish"), metric("funding", "bearish")])!.headline).toContain("balanced");
  });

  it("caveats a direction built on thin evidence", () => {
    const bias = build([metric("funding", "bullish", 20)])!;
    expect(bias.headline).toContain("thin");
  });
});

describe("snapshotVerdicts", () => {
  it("reduces to one verdict per metric id", () => {
    expect(snapshotVerdicts([metric("funding", "bullish"), metric("basis", "bearish")])).toEqual({
      funding: "bullish",
      basis: "bearish",
    });
  });
});
