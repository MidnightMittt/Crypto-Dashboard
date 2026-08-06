import { describe, it, expect } from "vitest";
import { classifyLiquidityRegime, classifyRiskRegime } from "./macroLiquidity";

describe("classifyLiquidityRegime", () => {
  it("hand-computed: -60B combined change -> expanding (sinks draining past threshold)", () => {
    expect(classifyLiquidityRegime(-60)).toBe("expanding");
  });

  it("hand-computed: +60B combined change -> contracting (sinks filling past threshold)", () => {
    expect(classifyLiquidityRegime(60)).toBe("contracting");
  });

  it("hand-computed: +20B combined change -> neutral (inside the ±50B band)", () => {
    expect(classifyLiquidityRegime(20)).toBe("neutral");
  });

  it("boundary: exactly -50B -> expanding (threshold is inclusive)", () => {
    expect(classifyLiquidityRegime(-50)).toBe("expanding");
  });

  it("boundary: exactly +50B -> contracting (threshold is inclusive)", () => {
    expect(classifyLiquidityRegime(50)).toBe("contracting");
  });

  it("returns null when no data is available", () => {
    expect(classifyLiquidityRegime(null)).toBeNull();
  });
});

describe("classifyRiskRegime", () => {
  it("hand-computed: loose conditions + normal curve -> risk-on", () => {
    expect(classifyRiskRegime(-0.3, 0.5)).toBe("risk-on");
  });

  it("hand-computed: tight conditions + normal curve -> risk-off", () => {
    expect(classifyRiskRegime(0.3, 0.5)).toBe("risk-off");
  });

  it("hand-computed: loose conditions but an inverted curve -> risk-off (inversion overrides)", () => {
    expect(classifyRiskRegime(-0.3, -0.2)).toBe("risk-off");
  });

  it("hand-computed: NFCI inside the neutral band, normal curve -> neutral", () => {
    expect(classifyRiskRegime(0.05, 0.5)).toBe("neutral");
  });

  it("an inverted curve alone is enough for risk-off, even with NFCI missing", () => {
    expect(classifyRiskRegime(null, -0.1)).toBe("risk-off");
  });

  it("returns null when both inputs are missing", () => {
    expect(classifyRiskRegime(null, null)).toBeNull();
  });
});
