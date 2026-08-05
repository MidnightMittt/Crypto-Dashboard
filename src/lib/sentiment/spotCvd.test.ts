import { describe, it, expect } from "vitest";
import { summarizeSpotCvd } from "./spotCvd";
import { RawCvdPoint } from "@/lib/providers/okxOrderFlow";

const HOUR = 3_600_000;

describe("summarizeSpotCvd", () => {
  it("returns null when there is no taker volume at all - a genuine unknown", () => {
    expect(summarizeSpotCvd([])).toBeNull();
  });

  describe("CVD history", () => {
    it("computes a running cumulative (buy - sell) total across buckets", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 100, sellUsd: 40 }, // delta +60, cumulative 60
        { t: HOUR, buyUsd: 20, sellUsd: 50 }, // delta -30, cumulative 30
        { t: 2 * HOUR, buyUsd: 10, sellUsd: 10 }, // delta 0, cumulative 30
      ];
      const result = summarizeSpotCvd(rows);
      expect(result!.cvdHistory.map((p) => p.cumulativeUsd)).toEqual([60, 30, 30]);
    });

    it("preserves input order (caller is responsible for oldest-first ordering)", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 1, sellUsd: 0 },
        { t: HOUR, buyUsd: 2, sellUsd: 0 },
      ];
      const result = summarizeSpotCvd(rows);
      expect(result!.cvdHistory.map((p) => p.t)).toEqual([0, HOUR]);
    });

    it("sums total buy and sell volume across all buckets", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 100, sellUsd: 40 },
        { t: HOUR, buyUsd: 20, sellUsd: 50 },
      ];
      const result = summarizeSpotCvd(rows);
      expect(result!.totalBuyUsd).toBe(120);
      expect(result!.totalSellUsd).toBe(90);
    });
  });

  describe("dominantSide classification", () => {
    it("reports 'buyers' when buy volume is 65% or more of the total", () => {
      const result = summarizeSpotCvd([{ t: 0, buyUsd: 65, sellUsd: 35 }]);
      expect(result!.dominantSide).toBe("buyers");
      expect(result!.buyerSharePct).toBeCloseTo(65, 6);
    });

    it("reports 'sellers' when buy volume is 35% or less of the total", () => {
      const result = summarizeSpotCvd([{ t: 0, buyUsd: 35, sellUsd: 65 }]);
      expect(result!.dominantSide).toBe("sellers");
    });

    it("reports 'balanced' inside the 35-65% band, matching orderFlow's own DOMINANT_SHARE bands", () => {
      const result = summarizeSpotCvd([{ t: 0, buyUsd: 50, sellUsd: 50 }]);
      expect(result!.dominantSide).toBe("balanced");
    });

    it("reports 'balanced' when total volume is zero, rather than an artifact of 0/0", () => {
      const result = summarizeSpotCvd([{ t: 0, buyUsd: 0, sellUsd: 0 }]);
      expect(result!.dominantSide).toBe("balanced");
      expect(result!.buyerSharePct).toBe(50);
    });

    it("is inclusive at exactly the 65% boundary", () => {
      const justUnder = summarizeSpotCvd([{ t: 0, buyUsd: 649, sellUsd: 351 }]);
      expect(justUnder!.dominantSide).toBe("balanced");

      const atBoundary = summarizeSpotCvd([{ t: 0, buyUsd: 650, sellUsd: 350 }]);
      expect(atBoundary!.dominantSide).toBe("buyers");
    });
  });

  describe("windowHours", () => {
    it("computes the actual span of the CVD history, not a hardcoded target", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 1, sellUsd: 0 },
        { t: 23 * HOUR, buyUsd: 1, sellUsd: 0 },
      ];
      const result = summarizeSpotCvd(rows);
      expect(result!.windowHours).toBeCloseTo(23, 6);
    });

    it("reports 0 with fewer than two points - a point is not a span", () => {
      const result = summarizeSpotCvd([{ t: 0, buyUsd: 1, sellUsd: 0 }]);
      expect(result!.windowHours).toBe(0);
    });
  });

  it("always identifies the venue as OKX, the only source this feature has", () => {
    const result = summarizeSpotCvd([{ t: 0, buyUsd: 1, sellUsd: 1 }]);
    expect(result!.venue).toBe("OKX");
  });
});
