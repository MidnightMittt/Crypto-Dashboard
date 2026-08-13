import { describe, it, expect } from "vitest";
import { buildMarketBias, buildHeadline, snapshotVerdicts, topReasons } from "./marketBias";
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

describe("topReasons", () => {
  it("interleaves bullish and bearish by rank, not by side", () => {
    // Hand-computed rankMetric (weight x confidence/100) at confidence 90,
    // all four EDGE voters (a state/context metric can't be a top reason at
    // all — see the test below): funding 0.15*0.9=0.135, squeezeRisk
    // 0.14*0.9=0.126, basis 0.08*0.9=0.072, stablecoins 0.04*0.9=0.036 —
    // so the merged, re-ranked order should be funding(bull),
    // squeezeRisk(bear), basis(bear), stablecoins(bull), NOT the two
    // topBullish entries first followed by the two topBearish.
    const bias = build([
      metric("funding", "bullish", 90),
      metric("basis", "bearish", 90),
      metric("stablecoins", "bullish", 90),
      metric("squeezeRisk", "bearish", 90),
    ])!;
    const reasons = topReasons(bias, 4);
    expect(reasons.map((r) => r.id)).toEqual(["funding", "squeezeRisk", "basis", "stablecoins"]);
    expect(reasons.map((r) => r.side)).toEqual(["bullish", "bearish", "bearish", "bullish"]);
  });

  it("never lists a non-voting (state/context) metric as a top reason", () => {
    // technicals is State and coinbasePremium is context under the
    // taxonomy: both weight 0. A read that contributed nothing to the
    // score cannot be presented as the reason for it, however confident.
    const bias = build([
      metric("funding", "bullish", 50),
      metric("technicals", "bullish", 100),
      metric("coinbasePremium", "bearish", 100),
    ])!;
    expect(bias.topBullish.map((m) => m.id)).toEqual(["funding"]);
    expect(bias.topBearish).toEqual([]);
  });

  it("defaults to five and respects a smaller explicit limit", () => {
    const ids = ["funding", "squeezeRisk", "technicals", "orderFlow", "openInterest", "basis", "longShort"];
    const bias = build(ids.map((id) => metric(id, "bullish")))!;
    expect(topReasons(bias)).toHaveLength(5);
    expect(topReasons(bias, 2)).toHaveLength(2);
  });

  it("returns an empty list when neither side has a reason", () => {
    const bias = build([metric("funding", "neutral")])!;
    expect(bias.topBullish).toHaveLength(0);
    expect(bias.topBearish).toHaveLength(0);
    expect(topReasons(bias)).toHaveLength(0);
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
  // Real metric ids, spread across categories — CATEGORY_MAP only scores
  // ids it recognizes, so a fake "m0"-style id now contributes nothing at
  // all under the category-weighted engine (correctly; it doesn't exist).
  const CONFLICT_IDS = ["funding", "squeezeRisk", "technicals", "coinbasePremium"];
  const withConflicts = (n: number) =>
    CONFLICT_IDS.slice(0, n).map((id) => ({
      ...metric(id, "bullish"),
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
    bollingerBandwidthPct: null,
    bollingerPosition: null,
    stochasticK: null,
    obvTrend: null,
    supertrendDirection: null,
    parabolicSarDirection: null,
    ichimokuPosition: null,
    fibonacciNearestLevel: null,
    rsiDivergence: null,
    macdDivergence: null,
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

  it("says so plainly when evidence is exactly tied — the one case honestly worded as even, not a vague dodge", () => {
    expect(build([metric("funding", "bullish"), metric("funding", "bearish")])!.headline).toContain("evenly weighted");
  });

  it("caveats a direction built on thin evidence", () => {
    const bias = build([metric("funding", "bullish", 20)])!;
    expect(bias.headline).toContain("thin");
  });
});

describe("buildHeadline — never says 'mixed'/'conflicting'/'uncertain', always names the real lean", () => {
  const bull = metric("etfFlows", "bullish", 70);
  const bear = metric("fearGreed", "bearish", 60);

  it("neutral verdict with a real (non-tied) lean names the direction and the leading metric", () => {
    // score=53: inside the neutral band (DIRECTIONAL_THRESHOLD=6) but NOT
    // an exact tie — this is exactly the case that used to fall through to
    // "signals are mixed"/"no directional edge."
    const headline = buildHeadline("neutral", 53, 55, false, bull, bear);
    expect(headline.toLowerCase()).not.toContain("mixed");
    expect(headline.toLowerCase()).not.toContain("conflicting");
    expect(headline.toLowerCase()).not.toContain("uncertain");
    expect(headline.toLowerCase()).not.toContain("cannot determine");
    expect(headline).toContain("bullish");
    expect(headline).toContain(bull.label);
  });

  it("neutral verdict leaning bearish (score < 50) names bearish, not the bullish default", () => {
    const headline = buildHeadline("neutral", 47, 55, false, bull, bear);
    expect(headline).toContain("bearish");
    expect(headline).toContain(bear.label);
  });

  it("exact tie (score === 50) is the one case honestly worded as even, not a vague dodge", () => {
    const headline = buildHeadline("neutral", 50, 50, false, bull, bear);
    expect(headline).toContain("evenly weighted");
    expect(headline.toLowerCase()).not.toContain("mixed");
  });

  it("directional verdict still names the leading metric", () => {
    const headline = buildHeadline("bullish", 68, 70, false, bull, bear);
    expect(headline).toContain("bullish");
    expect(headline).toContain(bull.label);
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

describe("agreement, opportunity and counter-risk", () => {
  it("reports full agreement when every weighted metric points the same way", () => {
    const bias = build([metric("funding", "bullish"), metric("basis", "bullish")])!;
    expect(bias.agreement).toBe(100);
  });

  it("reports zero agreement on an even split", () => {
    const bias = build([metric("funding", "bullish"), metric("squeezeRisk", "bearish")])!;
    expect(bias.agreement).toBe(0);
  });

  it("keeps agreement distinct from confidence — unanimous but thin scores high then low", () => {
    // The case the two-number split exists to expose: everything agrees, but
    // nothing behind it is well-evidenced.
    const bias = build([metric("funding", "bullish", 10), metric("basis", "bullish", 10)])!;
    expect(bias.agreement).toBe(100);
    expect(bias.confidence).toBeLessThan(20);
  });

  it("excludes permanently-neutral liquidations from agreement", () => {
    // Weight 0, and it can never take a side — counting it would dilute
    // every reading identically and tell the reader nothing.
    const withLiq = build([metric("funding", "bullish"), metric("liquidations", "neutral")])!;
    expect(withLiq.agreement).toBe(100);
  });

  it("surfaces the best-supported aligned metric as the opportunity", () => {
    const bias = build([
      metric("coinbasePremium", "bullish", 90), // lightest weight
      metric("funding", "bullish", 90), // heaviest weight
      metric("basis", "bearish", 50),
    ])!;
    expect(bias.verdict).toBe("bullish");
    expect(bias.opportunity?.id).toBe("funding");
  });

  it("surfaces the best-supported opposing metric as the counter-risk", () => {
    // Bullish side needs enough weight to clear the +/-6 neutral band —
    // funding alone against squeezeRisk lands near 50, which is correctly
    // still neutral; etfFlows (its own unanimous leadingDrivers category)
    // pushes the combined read clearly bullish.
    const bias = build([
      metric("funding", "bullish", 95),
      metric("etfFlows", "bullish", 95),
      metric("squeezeRisk", "bearish", 80),
    ])!;
    expect(bias.verdict).toBe("bullish");
    expect(bias.counterRisk?.id).toBe("squeezeRisk");
  });

  it("has neither opportunity nor counter-risk when the read is neutral", () => {
    // Nothing to support or oppose — claiming otherwise would invent a thesis.
    const bias = build([metric("funding", "bullish"), metric("funding", "bearish")])!;
    expect(bias.verdict).toBe("neutral");
    expect(bias.opportunity).toBeNull();
    expect(bias.counterRisk).toBeNull();
  });
});

describe("watchNext", () => {
  const withTrigger = (id: string, v: Verdict): MetricVerdict => ({
    ...metric(id, v),
    nextTrigger: `${id} would flip at some level`,
  });

  it("only includes metrics that can actually name a flip level", () => {
    const bias = build([withTrigger("funding", "bullish"), metric("basis", "bullish")])!;
    expect(bias.watchNext.map((m) => m.id)).toEqual(["funding"]);
  });

  it("ranks by weight, so the metrics that would move the read most come first", () => {
    const bias = build([
      withTrigger("coinbasePremium", "bullish"),
      withTrigger("funding", "bullish"),
    ])!;
    expect(bias.watchNext[0].id).toBe("funding");
  });

  it("caps the list at four", () => {
    const ids = ["funding", "squeezeRisk", "technicals", "orderFlow", "openInterest", "basis"];
    const bias = build(ids.map((id) => withTrigger(id, "bullish")))!;
    expect(bias.watchNext).toHaveLength(4);
  });

  it("excludes zero-weight metrics, which cannot change the overall read", () => {
    const bias = build([withTrigger("funding", "bullish"), withTrigger("liquidations", "neutral")])!;
    expect(bias.watchNext.map((m) => m.id)).toEqual(["funding"]);
  });
});

describe("category rollup fields", () => {
  it("attaches the category breakdown that produced the score", () => {
    // funding is positioning-only and technicals is marketStructure-only in
    // the V2 taxonomy (funding's old dual-membership was dropped), so the
    // two produce exactly these two categories, not three.
    const bias = build([metric("funding", "bullish", 90), metric("technicals", "bullish", 90)])!;
    expect(bias.categories.map((c) => c.category).sort()).toEqual(["marketStructure", "positioning"]);
  });

  it("computes the overall score BY combining categories, not the old flat per-metric sum", () => {
    // openInterest+longShort (both positioning-only, weights
    // 0.09+0.08=0.17) at full weight vs. etfFlows (leadingDrivers-only,
    // weight 0.08) at full weight: under FLAT per-metric weighting a lone
    // 0.08 would barely dent a combined 0.17 bullish weight (score >75).
    // Under CATEGORY weighting leadingDrivers gets its full 20% category
    // weight to fight positioning's 35%, a much closer contest —
    // hand-computed: positioning scores 100 (w 0.35), leadingDrivers 0
    // (w 0.20), combined pull (0.35-0.20)/0.55 = 0.273 → score 64.
    const bias = build([
      metric("openInterest", "bullish", 100),
      metric("longShort", "bullish", 100),
      metric("etfFlows", "bearish", 100),
    ])!;
    expect(bias.verdict).toBe("bullish");
    expect(bias.score).toBeLessThan(90);
  });

  it("provides a trend strength bucket when technicals are available", () => {
    const bias = buildMarketBias({
      asset: "BTC",
      metrics: [metric("funding", "bullish")],
      technicals: {
        direction: "bullish",
        strength: 65,
        summary: "",
        rsi: 60,
        macdHistogram: 1,
        emaAlignment: "above-all",
        adx: 30,
        atrPct: 2,
        volumeRatio: 1,
        vwapPosition: "above",
        trendStructure: "higher-highs",
    bollingerBandwidthPct: null,
    bollingerPosition: null,
    stochasticK: null,
    obvTrend: null,
    supertrendDirection: null,
    parabolicSarDirection: null,
    ichimokuPosition: null,
    fibonacciNearestLevel: null,
    rsiDivergence: null,
    macdDivergence: null,
      },
      squeezeScore: null,
      previous: null,
      now: 0,
    })!;
    expect(bias.trendStrength).toEqual({ label: "Strong", value: 65 });
  });

  it("has no trend strength without a technical read", () => {
    const bias = build([metric("funding", "bullish")])!;
    expect(bias.trendStrength).toBeNull();
  });
});
