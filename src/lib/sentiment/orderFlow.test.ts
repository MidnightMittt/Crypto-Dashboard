import { describe, it, expect } from "vitest";
import { summarizeOrderFlow } from "./orderFlow";
import { RawBookDepth, RawCvdPoint } from "@/lib/providers/okxOrderFlow";

const HOUR = 3_600_000;

describe("summarizeOrderFlow", () => {
  it("returns null when neither book depth nor taker volume is available - a genuine unknown", () => {
    expect(summarizeOrderFlow(null, [])).toBeNull();
  });

  it("returns a summary from book depth alone, with an empty CVD history", () => {
    const book: RawBookDepth = { bidUsd: 100, askUsd: 100, depthLevels: 20, bids: [], asks: [] };
    const result = summarizeOrderFlow(book, []);
    expect(result).not.toBeNull();
    expect(result!.bookImbalance).not.toBeNull();
    expect(result!.cvdHistory).toEqual([]);
  });

  it("returns a summary from taker volume alone, with no book imbalance", () => {
    const result = summarizeOrderFlow(null, [{ t: 0, buyUsd: 100, sellUsd: 50 }]);
    expect(result).not.toBeNull();
    expect(result!.bookImbalance).toBeNull();
    expect(result!.totalBuyUsd).toBe(100);
  });

  describe("book imbalance", () => {
    it("computes a zero imbalance when bid and ask depth are equal", () => {
      const result = summarizeOrderFlow({ bidUsd: 500, askUsd: 500, depthLevels: 20, bids: [], asks: [] }, []);
      expect(result!.bookImbalance!.imbalancePct).toBeCloseTo(0, 6);
    });

    it("computes a positive imbalance when bid depth exceeds ask depth", () => {
      const result = summarizeOrderFlow({ bidUsd: 750, askUsd: 250, depthLevels: 20, bids: [], asks: [] }, []);
      // (750-250)/(750+250)*100 = 50
      expect(result!.bookImbalance!.imbalancePct).toBeCloseTo(50, 6);
    });

    it("computes a negative imbalance when ask depth exceeds bid depth", () => {
      const result = summarizeOrderFlow({ bidUsd: 250, askUsd: 750, depthLevels: 20, bids: [], asks: [] }, []);
      expect(result!.bookImbalance!.imbalancePct).toBeCloseTo(-50, 6);
    });

    it("does not divide by zero when both sides of the book are empty", () => {
      const result = summarizeOrderFlow({ bidUsd: 0, askUsd: 0, depthLevels: 20, bids: [], asks: [] }, []);
      expect(result!.bookImbalance!.imbalancePct).toBe(0);
    });

    it("preserves the raw bid/ask USD figures alongside the derived percentage", () => {
      const result = summarizeOrderFlow({ bidUsd: 123, askUsd: 456, depthLevels: 20, bids: [], asks: [] }, []);
      expect(result!.bookImbalance!.bid.usd).toBe(123);
      expect(result!.bookImbalance!.ask.usd).toBe(456);
      expect(result!.bookImbalance!.depthLevels).toBe(20);
    });
  });

  describe("CVD history", () => {
    it("computes a running cumulative (buy - sell) total across buckets", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 100, sellUsd: 40 }, // delta +60, cumulative 60
        { t: HOUR, buyUsd: 20, sellUsd: 50 }, // delta -30, cumulative 30
        { t: 2 * HOUR, buyUsd: 10, sellUsd: 10 }, // delta 0, cumulative 30
      ];
      const result = summarizeOrderFlow(null, rows);
      expect(result!.cvdHistory.map((p) => p.cumulativeUsd)).toEqual([60, 30, 30]);
    });

    it("preserves input order (caller is responsible for oldest-first ordering)", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 1, sellUsd: 0 },
        { t: HOUR, buyUsd: 2, sellUsd: 0 },
      ];
      const result = summarizeOrderFlow(null, rows);
      expect(result!.cvdHistory.map((p) => p.t)).toEqual([0, HOUR]);
    });

    it("sums total buy and sell volume across all buckets", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 100, sellUsd: 40 },
        { t: HOUR, buyUsd: 20, sellUsd: 50 },
      ];
      const result = summarizeOrderFlow(null, rows);
      expect(result!.totalBuyUsd).toBe(120);
      expect(result!.totalSellUsd).toBe(90);
    });
  });

  describe("dominantFlow classification", () => {
    it("reports 'buyers' when buy volume is 65% or more of the total", () => {
      const result = summarizeOrderFlow(null, [{ t: 0, buyUsd: 65, sellUsd: 35 }]);
      expect(result!.dominantFlow).toBe("buyers");
      expect(result!.buyerSharePct).toBeCloseTo(65, 6);
    });

    it("reports 'sellers' when buy volume is 35% or less of the total", () => {
      const result = summarizeOrderFlow(null, [{ t: 0, buyUsd: 35, sellUsd: 65 }]);
      expect(result!.dominantFlow).toBe("sellers");
    });

    it("reports 'balanced' inside the 35-65% band, matching the liquidations/LONG_SHORT_BANDS convention", () => {
      const result = summarizeOrderFlow(null, [{ t: 0, buyUsd: 50, sellUsd: 50 }]);
      expect(result!.dominantFlow).toBe("balanced");
    });

    it("reports 'balanced' when total volume is zero, rather than an artifact of 0/0", () => {
      const result = summarizeOrderFlow({ bidUsd: 1, askUsd: 1, depthLevels: 20, bids: [], asks: [] }, [
        { t: 0, buyUsd: 0, sellUsd: 0 },
      ]);
      expect(result!.dominantFlow).toBe("balanced");
      expect(result!.totalBuyUsd).toBe(0);
    });

    it("is inclusive at exactly the 65% boundary", () => {
      const justUnder = summarizeOrderFlow(null, [{ t: 0, buyUsd: 649, sellUsd: 351 }]);
      expect(justUnder!.dominantFlow).toBe("balanced");

      const atBoundary = summarizeOrderFlow(null, [{ t: 0, buyUsd: 650, sellUsd: 350 }]);
      expect(atBoundary!.dominantFlow).toBe("buyers");
    });
  });

  describe("windowHours", () => {
    it("computes the actual span of the CVD history, not a hardcoded target", () => {
      const rows: RawCvdPoint[] = [
        { t: 0, buyUsd: 1, sellUsd: 0 },
        { t: 23 * HOUR, buyUsd: 1, sellUsd: 0 },
      ];
      const result = summarizeOrderFlow(null, rows);
      expect(result!.windowHours).toBeCloseTo(23, 6);
    });

    it("reports 0 with fewer than two points - a point is not a span", () => {
      const result = summarizeOrderFlow(null, [{ t: 0, buyUsd: 1, sellUsd: 0 }]);
      expect(result!.windowHours).toBe(0);
    });
  });

  it("always identifies the venue as OKX, the only source this feature has", () => {
    const result = summarizeOrderFlow({ bidUsd: 1, askUsd: 1, depthLevels: 20, bids: [], asks: [] }, []);
    expect(result!.venue).toBe("OKX");
  });
});
