import { describe, expect, it } from "vitest";
import { harmonicMetric, technicalsMetric } from "./chartEvidence";
import { TechnicalRead } from "@/types/market";
import { HarmonicEvidence } from "@/lib/signals/harmonicEvidence";
import { DivergenceResult } from "@/lib/technicals/divergence";

const read = (over: Partial<TechnicalRead> = {}): TechnicalRead =>
  ({
    direction: "bullish",
    strength: 60,
    summary: "Price is above all three moving averages with expanding volume.",
    rsi: 62,
    macdHistogram: 0.4,
    emaAlignment: "above-all",
    adx: 28,
    atrPct: 2.1,
    volumeRatio: 1.3,
    vwapPosition: "above",
    trendStructure: "higher-highs",
    rsiDivergence: null,
    macdDivergence: null,
    ...over,
  }) as TechnicalRead;

const divergence = (kind: DivergenceResult["kind"]): DivergenceResult =>
  ({ kind, priorIndex: 0, recentIndex: 1, pricePrior: 1, priceRecent: 2, indicatorPrior: 1, indicatorRecent: 0.5 }) as DivergenceResult;

describe("technicalsMetric", () => {
  it("mirrors the crypto rule: below strength 20 the read is neutral regardless of direction", () => {
    expect(technicalsMetric(read({ strength: 19, direction: "bullish" }), 0).verdict).toBe("neutral");
    expect(technicalsMetric(read({ strength: 20, direction: "bullish" }), 0).verdict).toBe("bullish");
  });

  it("names a weak ADX as a conflict rather than hiding it in the confidence", () => {
    const m = technicalsMetric(read({ adx: 15 }), 0);
    expect(m.conflicts.some((c) => c.includes("ADX 15"))).toBe(true);
  });

  it("flags REGULAR divergence against the verdict as a conflict", () => {
    const m = technicalsMetric(read({ rsiDivergence: divergence("regular-bearish") }), 0);
    expect(m.conflicts.some((c) => c.includes("diverging bearishly"))).toBe(true);
  });

  it("does NOT flag hidden divergence — it is a continuation signal, not opposition", () => {
    const m = technicalsMetric(read({ rsiDivergence: divergence("hidden-bearish") }), 0);
    expect(m.conflicts.some((c) => c.includes("diverging"))).toBe(false);
  });

  it("uses the read's own summary as the explanation — never a second opinion", () => {
    const m = technicalsMetric(read(), 0);
    expect(m.explanation).toBe("Price is above all three moving averages with expanding volume.");
    expect(m.confidence).toBe(60);
  });
});

describe("harmonicMetric", () => {
  const evidence = (over: Partial<HarmonicEvidence> = {}): HarmonicEvidence =>
    ({
      pattern: "gartley",
      direction: "bullish",
      timeframe: "1D",
      status: "forming",
      geometryQuality: 0.8,
      przLow: 210,
      przHigh: 214,
      przConvergenceCount: 3,
      distanceAtr: 2.4,
      przTested: false,
      structureReaction: null,
      divergence: null,
      regimeAlignment: "aligned",
      derivatives: "unavailable",
      higherTimeframeConfluence: false,
      ...over,
    }) as HarmonicEvidence;

  it("states the completion zone as concrete prices with distance in daily ranges", () => {
    const m = harmonicMetric(evidence(), 0);
    expect(m.explanation).toContain("$210.00–$214.00");
    expect(m.explanation).toContain("2.4 average daily ranges");
  });

  it("caps confidence at geometry precision — never a win probability", () => {
    const m = harmonicMetric(evidence({ geometryQuality: 1 }), 0);
    expect(m.confidence).toBeLessThanOrEqual(60);
    expect(m.confidenceBasis).toContain("not a win probability");
  });

  it("names the counter-trend case as a conflict, because those completions fail more often", () => {
    const m = harmonicMetric(evidence({ regimeAlignment: "counter-trend" }), 0);
    expect(m.conflicts).toHaveLength(1);
    expect(m.explanation).toContain("AGAINST the prevailing trend");
  });

  it("declares in whyItMatters that the pattern does not vote", () => {
    expect(harmonicMetric(evidence(), 0).whyItMatters).toContain("do not vote");
  });
});
