import { describe, it, expect } from "vitest";
import { scoreConfidence, describeConfidence, agreementOf } from "./confidence";

describe("scoreConfidence", () => {
  it("caps an unbacktested metric below 100 even with perfect inputs", () => {
    // The whole point: nothing without historical validation should ever
    // render as fully confident.
    expect(scoreConfidence({ completeness: 1, agreement: 1 })).toBe(85);
  });

  it("allows 100 only when a real backtest covers the metric", () => {
    expect(scoreConfidence({ completeness: 1, agreement: 1, backtested: true })).toBe(100);
  });

  it("collapses when data is thin, however well the sources agree", () => {
    // Conjunctive, not averaged — one venue out of twenty is weak evidence
    // no matter how internally consistent. An average would report 55.
    expect(scoreConfidence({ completeness: 0.1, agreement: 1 })).toBeLessThan(15);
  });

  it("collapses when sources contradict, however complete the data", () => {
    expect(scoreConfidence({ completeness: 1, agreement: 0 })).toBe(0);
  });

  it("clamps out-of-range inputs rather than producing nonsense", () => {
    expect(scoreConfidence({ completeness: 5, agreement: 5 })).toBe(85);
    expect(scoreConfidence({ completeness: -3, agreement: 1 })).toBe(0);
  });

  it("never returns a value outside 0-100", () => {
    for (const c of [0, 0.3, 0.77, 1]) {
      for (const a of [0, 0.5, 1]) {
        const score = scoreConfidence({ completeness: c, agreement: a });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("agreementOf", () => {
  it("returns 1 when every directional source agrees", () => {
    expect(agreementOf(["bullish", "bullish", "bullish"])).toBe(1);
  });

  it("returns 0 on an even split", () => {
    expect(agreementOf(["bullish", "bearish"])).toBe(0);
  });

  it("ignores neutral readings instead of counting them as consensus", () => {
    // Three neutrals and one bullish is NOT strong agreement; if neutrals
    // counted, this would score far higher than the evidence warrants.
    expect(agreementOf(["bullish", "neutral", "neutral", "neutral"])).toBe(1);
    expect(agreementOf(["bullish", "bearish", "neutral", "neutral"])).toBe(0);
  });

  it("returns the neutral midpoint when nothing has a direction", () => {
    expect(agreementOf(["neutral", "neutral"])).toBe(0.5);
    expect(agreementOf([])).toBe(0.5);
  });

  it("scales a two-thirds majority between the split and unanimous ends", () => {
    const score = agreementOf(["bullish", "bullish", "bearish"]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(1 / 3, 5);
  });
});

describe("describeConfidence", () => {
  it("names the limiting factor rather than restating the score", () => {
    const text = describeConfidence({ completeness: 0.2, agreement: 0.9 });
    expect(text).toContain("thin data coverage");
  });

  it("always discloses whether a backtest covers the metric", () => {
    expect(describeConfidence({ completeness: 1, agreement: 1 })).toContain("no backtest");
    expect(describeConfidence({ completeness: 1, agreement: 1, backtested: true })).toContain("backtested");
  });
});
