import { describe, it, expect } from "vitest";
import { summarizeLiquidations } from "./liquidations";
import { VenueLiquidations } from "@/lib/providers/coinalyze";

const HOUR = 3_600_000;

describe("summarizeLiquidations", () => {
  it("returns null when no venue reported anything - a genuine 'unknown', not a zero", () => {
    expect(summarizeLiquidations([])).toBeNull();
  });

  it("returns a real zero-total summary (not null) when venues reported but nothing was liquidated", () => {
    // A quiet market is a meaningful, honest reading - distinct from having
    // no data source at all.
    const result = summarizeLiquidations([
      { venueId: "binance", points: [{ t: Date.now(), longUsd: 0, shortUsd: 0 }] },
    ]);
    expect(result).not.toBeNull();
    expect(result!.totalLongUsd).toBe(0);
    expect(result!.totalShortUsd).toBe(0);
    expect(result!.dominantSide).toBe("balanced");
  });

  it("sums volume across multiple venues into shared hourly buckets", () => {
    const now = 10 * HOUR; // arbitrary fixed epoch, hour-aligned
    const venues: VenueLiquidations[] = [
      { venueId: "binance", points: [{ t: now, longUsd: 100, shortUsd: 50 }] },
      { venueId: "bybit", points: [{ t: now, longUsd: 200, shortUsd: 25 }] },
    ];
    const result = summarizeLiquidations(venues);
    expect(result!.history).toHaveLength(1);
    expect(result!.history[0].longUsd).toBe(300);
    expect(result!.history[0].shortUsd).toBe(75);
    expect(result!.totalLongUsd).toBe(300);
    expect(result!.totalShortUsd).toBe(75);
  });

  it("merges points from different venues that fall in the same hour, even with minor timestamp jitter", () => {
    const hourStart = 10 * HOUR;
    const venues: VenueLiquidations[] = [
      { venueId: "binance", points: [{ t: hourStart, longUsd: 100, shortUsd: 0 }] },
      // 5 minutes into the same hour - must land in the same bucket as above.
      { venueId: "bybit", points: [{ t: hourStart + 5 * 60_000, longUsd: 50, shortUsd: 0 }] },
    ];
    const result = summarizeLiquidations(venues);
    expect(result!.history).toHaveLength(1);
    expect(result!.history[0].longUsd).toBe(150);
  });

  it("keeps points from different hours in separate buckets, sorted oldest first", () => {
    const venues: VenueLiquidations[] = [
      {
        venueId: "binance",
        points: [
          { t: 12 * HOUR, longUsd: 10, shortUsd: 0 }, // out of order on purpose
          { t: 10 * HOUR, longUsd: 20, shortUsd: 0 },
          { t: 11 * HOUR, longUsd: 30, shortUsd: 0 },
        ],
      },
    ];
    const result = summarizeLiquidations(venues);
    expect(result!.history.map((b) => b.t)).toEqual([10 * HOUR, 11 * HOUR, 12 * HOUR]);
  });

  it("reports 'long' dominant when longs make up 65% or more of total volume", () => {
    const result = summarizeLiquidations([
      { venueId: "binance", points: [{ t: 0, longUsd: 65, shortUsd: 35 }] },
    ]);
    expect(result!.dominantSide).toBe("long");
    expect(result!.longSharePct).toBeCloseTo(65, 6);
  });

  it("reports 'short' dominant when longs make up 35% or less of total volume", () => {
    const result = summarizeLiquidations([
      { venueId: "binance", points: [{ t: 0, longUsd: 35, shortUsd: 65 }] },
    ]);
    expect(result!.dominantSide).toBe("short");
  });

  it("reports 'balanced' inside the 35-65% band, matching LONG_SHORT_BANDS' own neutral zone", () => {
    const result = summarizeLiquidations([
      { venueId: "binance", points: [{ t: 0, longUsd: 50, shortUsd: 50 }] },
    ]);
    expect(result!.dominantSide).toBe("balanced");
  });

  it("does not flip to a confident 'long' label off noise - exact boundary is inclusive at 65", () => {
    const justUnder = summarizeLiquidations([
      { venueId: "binance", points: [{ t: 0, longUsd: 649, shortUsd: 351 }] }, // 64.9%
    ]);
    expect(justUnder!.dominantSide).toBe("balanced");

    const atBoundary = summarizeLiquidations([
      { venueId: "binance", points: [{ t: 0, longUsd: 650, shortUsd: 350 }] }, // exactly 65%
    ]);
    expect(atBoundary!.dominantSide).toBe("long");
  });

  it("deduplicates venue ids in the venues list even if a venue contributes multiple points", () => {
    const result = summarizeLiquidations([
      {
        venueId: "binance",
        points: [
          { t: 0, longUsd: 1, shortUsd: 0 },
          { t: HOUR, longUsd: 1, shortUsd: 0 },
        ],
      },
    ]);
    expect(result!.venues).toEqual(["binance"]);
  });

  it("computes windowHours as the actual span of returned buckets, not a hardcoded target", () => {
    const venues: VenueLiquidations[] = [
      {
        venueId: "binance",
        points: [
          { t: 0, longUsd: 1, shortUsd: 0 },
          { t: 5 * HOUR, longUsd: 1, shortUsd: 0 },
        ],
      },
    ];
    const result = summarizeLiquidations(venues);
    expect(result!.windowHours).toBeCloseTo(5, 6);
  });

  it("reports windowHours of 0 with only a single bucket - a point is not a span", () => {
    const result = summarizeLiquidations([
      { venueId: "binance", points: [{ t: 0, longUsd: 1, shortUsd: 0 }] },
    ]);
    expect(result!.windowHours).toBe(0);
  });
});
