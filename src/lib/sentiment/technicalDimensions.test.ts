import { describe, expect, it } from "vitest";
import { technicalDimensions } from "./technicalDimensions";
import { TechnicalRead } from "@/types/market";
import { DivergenceResult, DivergenceKind } from "@/lib/technicals/divergence";

function read(overrides: Partial<TechnicalRead> = {}): TechnicalRead {
  return {
    direction: "neutral",
    strength: 50,
    summary: "",
    rsi: 50,
    macdHistogram: 0,
    emaAlignment: "mixed",
    adx: 20,
    atrPct: 2,
    volumeRatio: 1,
    vwapPosition: null,
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
    ...overrides,
  };
}

function divergence(kind: DivergenceKind): DivergenceResult {
  return { kind, priorIndex: 0, recentIndex: 5, pricePrior: 1, priceRecent: 2, indicatorPrior: 1, indicatorRecent: 2 };
}

const byLabel = (r: TechnicalRead, dominant: Parameters<typeof technicalDimensions>[1]) =>
  Object.fromEntries(technicalDimensions(r, dominant).map((d) => [d.label, d]));

describe("technicalDimensions", () => {
  it("always returns the six named dimensions a trader scans", () => {
    expect(technicalDimensions(read(), "bullish").map((d) => d.label)).toEqual([
      "Trend",
      "Structure",
      "RSI",
      "MACD",
      "Divergence",
      "Volume",
    ]);
  });

  it("marks a bullish indicator as CONFIRMING a bullish thesis and CONTRADICTING a bearish one", () => {
    const bullishRead = read({ emaAlignment: "above-all", trendStructure: "higher-highs", macdHistogram: 5 });

    const vsBullish = byLabel(bullishRead, "bullish");
    expect(vsBullish.Trend.stance).toBe("confirms");
    expect(vsBullish.Structure.stance).toBe("confirms");
    expect(vsBullish.MACD.stance).toBe("confirms");

    const vsBearish = byLabel(bullishRead, "bearish");
    expect(vsBearish.Trend.stance).toBe("contradicts");
    expect(vsBearish.Structure.stance).toBe("contradicts");
    expect(vsBearish.MACD.stance).toBe("contradicts");
  });

  it("reads nothing as confirming when the thesis itself is neutral", () => {
    // Nothing to agree WITH — claiming confirmation here would invent a
    // verdict the engine never reached.
    const d = byLabel(read({ emaAlignment: "above-all", trendStructure: "higher-highs" }), "neutral");
    expect(d.Trend.stance).toBe("neutral");
    expect(d.Structure.stance).toBe("neutral");
  });

  it("treats RSI extremes as mean-reversion, matching buildTechnicalRead's own vote order", () => {
    // Overbought is BEARISH (stretched), not bullish — the same inversion
    // the composite applies. Getting this backwards would put the grid at
    // odds with the badge above it.
    expect(byLabel(read({ rsi: 78 }), "bearish").RSI.stance).toBe("confirms");
    expect(byLabel(read({ rsi: 78 }), "bullish").RSI.stance).toBe("contradicts");
    expect(byLabel(read({ rsi: 22 }), "bullish").RSI.stance).toBe("confirms");
  });

  it("distinguishes the mild RSI lean band from the neutral band", () => {
    expect(byLabel(read({ rsi: 60 }), "bullish").RSI.stance).toBe("confirms");
    expect(byLabel(read({ rsi: 40 }), "bearish").RSI.stance).toBe("confirms");
    // 45-55 is genuinely neutral, not a weak lean.
    expect(byLabel(read({ rsi: 50 }), "bullish").RSI.stance).toBe("neutral");
    expect(byLabel(read({ rsi: 50 }), "bullish").RSI.detail).toContain("neutral");
  });

  it("names divergences in plain English rather than an abbreviation", () => {
    const d = byLabel(read({ rsiDivergence: divergence("regular-bullish") }), "bullish");
    expect(d.Divergence.detail).toBe("Bullish divergence (RSI)");
    expect(d.Divergence.stance).toBe("confirms");

    const hidden = byLabel(read({ rsiDivergence: divergence("hidden-bearish") }), "bearish");
    expect(hidden.Divergence.detail).toBe("Hidden bearish divergence (RSI)");
    // Hidden divergence signals continuation, so it CONFIRMS the prevailing bearish read.
    expect(hidden.Divergence.stance).toBe("confirms");
  });

  it("falls back to MACD divergence only when RSI shows none, and labels the source", () => {
    const macdOnly = byLabel(read({ macdDivergence: divergence("regular-bearish") }), "bearish");
    expect(macdOnly.Divergence.detail).toBe("Bearish divergence (MACD)");

    // RSI wins when both exist — showing two rows would double-count one concept.
    const both = byLabel(
      read({ rsiDivergence: divergence("regular-bullish"), macdDivergence: divergence("regular-bearish") }),
      "bullish"
    );
    expect(both.Divergence.detail).toBe("Bullish divergence (RSI)");
  });

  it("states plainly when there is no meaningful divergence", () => {
    expect(byLabel(read(), "bullish").Divergence.detail).toBe("None meaningful");
    expect(byLabel(read(), "bullish").Divergence.stance).toBe("neutral");
  });

  it("treats volume as conviction, never as a direction", () => {
    // Volume must read identically regardless of thesis direction — it
    // carries no directional information and pretending otherwise would
    // fabricate a signal.
    for (const dominant of ["bullish", "bearish"] as const) {
      expect(byLabel(read({ volumeRatio: 1.8 }), dominant).Volume.stance).toBe("confirms");
      expect(byLabel(read({ volumeRatio: 0.3 }), dominant).Volume.stance).toBe("weakens");
      expect(byLabel(read({ volumeRatio: 1.0 }), dominant).Volume.stance).toBe("neutral");
    }
  });

  it("reports unavailable rather than neutral when an indicator has no data", () => {
    // "We don't know" and "it's balanced" are different facts.
    const d = byLabel(read({ emaAlignment: null, rsi: null, macdHistogram: null, volumeRatio: null, trendStructure: null }), "bullish");
    expect(d.Trend.stance).toBe("unavailable");
    expect(d.Structure.stance).toBe("unavailable");
    expect(d.RSI.stance).toBe("unavailable");
    expect(d.MACD.stance).toBe("unavailable");
    expect(d.Volume.stance).toBe("unavailable");
  });

  it("never renders a bare number without a plain-English reading", () => {
    for (const d of technicalDimensions(read({ rsi: 63, volumeRatio: 1.4 }), "bullish")) {
      expect(d.detail.length).toBeGreaterThan(0);
      expect(/^[\d.]+$/.test(d.detail)).toBe(false);
    }
  });
});
