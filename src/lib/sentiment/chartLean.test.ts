import { describe, it, expect } from "vitest";
import { classifyChartLean } from "./chartLean";

const FLAT = 0.3; // a representative flat-zone threshold, matching a mid timeframe

describe("classifyChartLean", () => {
  it("returns null with fewer than 2 points - a point is not a direction", () => {
    expect(classifyChartLean([{ price: 100, funding: 0.01 }], FLAT)).toBeNull();
  });

  it("returns null with zero points", () => {
    expect(classifyChartLean([], FLAT)).toBeNull();
  });

  it("returns null when every funding reading in the window is null", () => {
    const points = [
      { price: 100, funding: null },
      { price: 105, funding: null },
    ];
    expect(classifyChartLean(points, FLAT)).toBeNull();
  });

  it("returns null when the first price is not positive (would divide by zero/garbage)", () => {
    const points = [
      { price: 0, funding: 0.01 },
      { price: 100, funding: 0.01 },
    ];
    expect(classifyChartLean(points, FLAT)).toBeNull();
  });

  describe("price direction", () => {
    it("classifies 'up' when the net change exceeds the flat threshold", () => {
      const points = [
        { price: 100, funding: 0 },
        { price: 100.5, funding: 0 }, // +0.5%, above 0.3 threshold
      ];
      expect(classifyChartLean(points, FLAT)!.priceDirection).toBe("up");
    });

    it("classifies 'down' when the net change falls below the negative flat threshold", () => {
      const points = [
        { price: 100, funding: 0 },
        { price: 99.5, funding: 0 }, // -0.5%
      ];
      expect(classifyChartLean(points, FLAT)!.priceDirection).toBe("down");
    });

    it("classifies 'flat' when the net change sits inside the threshold band", () => {
      const points = [
        { price: 100, funding: 0 },
        { price: 100.1, funding: 0 }, // +0.1%, under 0.3 threshold
      ];
      expect(classifyChartLean(points, FLAT)!.priceDirection).toBe("flat");
    });

    it("uses first-to-last price change, not min-to-max range", () => {
      // Spikes up to 110 and back down to 100.2 - net change is tiny even
      // though the range within the window is large.
      const points = [
        { price: 100, funding: 0 },
        { price: 110, funding: 0 },
        { price: 100.2, funding: 0 },
      ];
      const result = classifyChartLean(points, FLAT)!;
      expect(result.priceDirection).toBe("flat");
      expect(result.priceChangePct).toBeCloseTo(0.2, 6);
    });

    it("is inclusive/exclusive consistently at the exact threshold boundary", () => {
      // Exactly at the threshold does not exceed it - "flat" wins ties.
      const atThreshold = classifyChartLean(
        [
          { price: 100, funding: 0 },
          { price: 100.3, funding: 0 },
        ],
        0.3
      )!;
      expect(atThreshold.priceDirection).toBe("flat");

      const justOver = classifyChartLean(
        [
          { price: 100, funding: 0 },
          { price: 100.30001, funding: 0 },
        ],
        0.3
      )!;
      expect(justOver.priceDirection).toBe("up");
    });
  });

  describe("funding sign", () => {
    it("classifies 'positive' above the FUNDING_BANDS neutral ceiling (0.04)", () => {
      const points = [
        { price: 100, funding: 0.05 },
        { price: 100, funding: 0.05 },
      ];
      expect(classifyChartLean(points, FLAT)!.fundingSign).toBe("positive");
    });

    it("classifies 'negative' below the FUNDING_BANDS neutral floor (-0.04)", () => {
      const points = [
        { price: 100, funding: -0.05 },
        { price: 100, funding: -0.05 },
      ];
      expect(classifyChartLean(points, FLAT)!.fundingSign).toBe("negative");
    });

    it("classifies 'neutral' inside the FUNDING_BANDS band", () => {
      const points = [
        { price: 100, funding: 0.01 },
        { price: 100, funding: -0.01 },
      ];
      expect(classifyChartLean(points, FLAT)!.fundingSign).toBe("neutral");
    });

    it("averages ONLY the non-null funding readings, skipping gaps", () => {
      const points = [
        { price: 100, funding: 0.1 },
        { price: 100, funding: null },
        { price: 100, funding: null },
        { price: 100, funding: 0.1 },
      ];
      // If nulls counted as zero, the average would be 0.05 (neutral).
      // Skipping them correctly gives 0.1 (positive).
      const result = classifyChartLean(points, FLAT)!;
      expect(result.avgFundingPct).toBeCloseTo(0.1, 6);
      expect(result.fundingSign).toBe("positive");
    });
  });

  describe("lean classification", () => {
    it("is 'bullish' whenever price direction is up, regardless of funding sign", () => {
      for (const funding of [0.1, 0, -0.1]) {
        const points = [
          { price: 100, funding },
          { price: 101, funding }, // clearly up
        ];
        expect(classifyChartLean(points, FLAT)!.lean).toBe("bullish");
      }
    });

    it("is 'bearish' whenever price direction is down, regardless of funding sign", () => {
      for (const funding of [0.1, 0, -0.1]) {
        const points = [
          { price: 100, funding },
          { price: 99, funding }, // clearly down
        ];
        expect(classifyChartLean(points, FLAT)!.lean).toBe("bearish");
      }
    });

    it("is 'coiling' when price is flat but funding is skewed positive", () => {
      const points = [
        { price: 100, funding: 0.1 },
        { price: 100.05, funding: 0.1 }, // flat
      ];
      expect(classifyChartLean(points, FLAT)!.lean).toBe("coiling");
    });

    it("is 'coiling' when price is flat but funding is skewed negative", () => {
      const points = [
        { price: 100, funding: -0.1 },
        { price: 100.05, funding: -0.1 },
      ];
      expect(classifyChartLean(points, FLAT)!.lean).toBe("coiling");
    });

    it("is 'neutral' only when BOTH price and funding are flat/neutral", () => {
      const points = [
        { price: 100, funding: 0.01 },
        { price: 100.05, funding: 0.01 },
      ];
      expect(classifyChartLean(points, FLAT)!.lean).toBe("neutral");
    });
  });
});
