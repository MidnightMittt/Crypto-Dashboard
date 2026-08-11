import { describe, expect, it } from "vitest";
import {
  detectWalls,
  classifyWallVsZones,
  executionDistanceContext,
  bookPriceRangeOf,
  LiquidityWall,
} from "./liquidityWalls";
import { SupportResistanceZone } from "./marketStructure";
import { RawBookLevel } from "@/lib/providers/okxOrderFlow";

function level(price: number, usd: number): RawBookLevel {
  return { price, usd };
}

function zone(overrides: Partial<SupportResistanceZone> = {}): SupportResistanceZone {
  return {
    priceLow: 99,
    priceHigh: 100,
    kind: "support",
    strength: 50,
    reactionCount: 2,
    confluence: [],
    status: "testing",
    mostRecentTouchBarsAgo: 1,
    source: "swing-cluster",
    timeframe: "1D",
    ...overrides,
  };
}

describe("detectWalls", () => {
  it("hand-computed: flags a genuine outlier via modified z-score, not the small neighbors", () => {
    // Mirrors the real BTC sample pulled live: one level ~100x its
    // neighbors. Sizes sorted: [10, 15, 200, 1000, 100000] -> median = 200.
    // Deviations |x-200| sorted: [0, 185, 190, 800, 99800] -> MAD = 190.
    // modified z for 100,000: 0.6745*(100000-200)/190 = 354.29 -> outlier.
    // modified z for 1,000:   0.6745*(1000-200)/190   = 2.84   -> not (< 3.5).
    const levels = [level(1, 10), level(2, 15), level(3, 100000), level(4, 200), level(5, 1000)];
    const r = detectWalls(levels, "bid");
    expect(r.reliable).toBe(true);
    expect(r.walls).toHaveLength(1);
    expect(r.walls[0].price).toBe(3);
    expect(r.walls[0].usd).toBe(100000);
    expect(r.walls[0].zScore).toBeCloseTo(354.29, 1);
  });

  it("does not flag a level that is merely small relative to neighbors", () => {
    // Only large-side outliers are walls; a thin level isn't a "negative wall".
    const levels = [level(1, 1000), level(2, 1050), level(3, 10), level(4, 980), level(5, 1020)];
    const r = detectWalls(levels, "ask");
    expect(r.walls).toHaveLength(0);
    expect(r.reliable).toBe(true);
  });

  it("reports unreliable rather than fabricating outliers on a near-flat book", () => {
    const levels = [level(1, 100), level(2, 101), level(3, 99), level(4, 100), level(5, 100)];
    const r = detectWalls(levels, "bid");
    expect(r.reliable).toBe(false);
    expect(r.walls).toHaveLength(0);
  });

  it("reports unreliable on a genuinely flat book (MAD exactly zero)", () => {
    const levels = [level(1, 50), level(2, 50), level(3, 50), level(4, 50), level(5, 50)];
    expect(detectWalls(levels, "bid").reliable).toBe(false);
  });

  it("reports unreliable below the minimum level count regardless of shape", () => {
    const levels = [level(1, 10), level(2, 100000)];
    const r = detectWalls(levels, "bid");
    expect(r.reliable).toBe(false);
    expect(r.walls).toHaveLength(0);
  });

  it("handles an empty book without throwing", () => {
    expect(detectWalls([], "ask")).toEqual({ walls: [], reliable: false });
  });

  it("can flag multiple simultaneous outliers", () => {
    const levels = [level(1, 10), level(2, 50000), level(3, 12), level(4, 48000), level(5, 11), level(6, 9)];
    const r = detectWalls(levels, "bid");
    expect(r.walls.map((w) => w.price).sort()).toEqual([2, 4]);
  });
});

describe("bookPriceRangeOf", () => {
  it("spans both sides", () => {
    const range = bookPriceRangeOf([level(99, 1), level(98, 1)], [level(101, 1), level(102, 1)]);
    expect(range).toEqual({ min: 98, max: 102 });
  });

  it("returns null when either side is empty", () => {
    expect(bookPriceRangeOf([], [level(101, 1)])).toBeNull();
    expect(bookPriceRangeOf([level(99, 1)], [])).toBeNull();
  });
});

describe("classifyWallVsZones", () => {
  const range = { min: 90, max: 110 };

  it("classifies 'backs' when a same-side wall sits inside the zone's range", () => {
    const bidWall: LiquidityWall = { side: "bid", price: 99.5, usd: 1_000_000, zScore: 10 };
    const result = classifyWallVsZones([bidWall], [], [zone({ priceLow: 99, priceHigh: 100, kind: "support" })], range);
    expect(result).toHaveLength(1);
    expect(result[0].relationship).toBe("backs");
    expect(result[0].wall).toBe(bidWall);
  });

  it("classifies 'weak' when the book reaches the zone but finds no wall there", () => {
    const result = classifyWallVsZones([], [], [zone({ priceLow: 99, priceHigh: 100, kind: "support" })], range);
    expect(result[0].relationship).toBe("weak");
    expect(result[0].wall).toBeNull();
  });

  it("classifies 'beyond' when the nearest same-side wall sits just past the zone", () => {
    // Support at 99-100; a bid wall further down at 95 is "beyond", not "backing".
    const bidWall: LiquidityWall = { side: "bid", price: 95, usd: 2_000_000, zScore: 8 };
    const result = classifyWallVsZones([bidWall], [], [zone({ priceLow: 99, priceHigh: 100, kind: "support" })], range);
    expect(result[0].relationship).toBe("beyond");
    expect(result[0].wall).toBe(bidWall);
  });

  it("uses ask walls for resistance zones, not bid walls", () => {
    const bidWall: LiquidityWall = { side: "bid", price: 100.5, usd: 1_000_000, zScore: 10 };
    const askWall: LiquidityWall = { side: "ask", price: 100.5, usd: 1_000_000, zScore: 10 };
    const zones = [zone({ priceLow: 100, priceHigh: 101, kind: "resistance" })];

    const withOnlyBid = classifyWallVsZones([bidWall], [], zones, range);
    expect(withOnlyBid[0].relationship).toBe("weak");

    const withAsk = classifyWallVsZones([], [askWall], zones, range);
    expect(withAsk[0].relationship).toBe("backs");
  });

  it("excludes a zone the visible book cannot reach at all, rather than calling it weak", () => {
    // Zone at 5000-5010 is nowhere near the 90-110 visible book.
    const result = classifyWallVsZones([], [], [zone({ priceLow: 5000, priceHigh: 5010 })], range);
    expect(result).toHaveLength(0);
  });

  it("returns nothing when the book price range is entirely unavailable", () => {
    expect(classifyWallVsZones([], [], [zone()], null)).toHaveLength(0);
  });

  it("picks the strongest wall when multiple qualify", () => {
    const weak: LiquidityWall = { side: "bid", price: 99.5, usd: 500_000, zScore: 4 };
    const strong: LiquidityWall = { side: "bid", price: 99.6, usd: 3_000_000, zScore: 12 };
    const result = classifyWallVsZones(
      [weak, strong],
      [],
      [zone({ priceLow: 99, priceHigh: 100, kind: "support" })],
      range
    );
    expect(result[0].wall).toBe(strong);
  });
});

describe("executionDistanceContext", () => {
  const range = { min: 99900, max: 100100 }; // visible book: ~0.2% span around 100,000

  it("pins the honest common case: stop/TP1/TP2 sit far outside the visible depth", () => {
    // Matches this module's own documented finding — entry alone overlaps
    // the book; ATR-scaled levels do not. Regression-pinned so a future
    // change can't silently start fabricating matches at unrealistic
    // distances.
    const points = [
      { point: "entry" as const, price: 100000 },
      { point: "stop" as const, price: 97000 }, // 3% away
      { point: "tp1" as const, price: 103000 }, // 3% away
      { point: "tp2" as const, price: 106000 }, // 6% away
    ];
    const result = executionDistanceContext(points, [], [], range);
    const byPoint = Object.fromEntries(result.map((r) => [r.point, r]));

    expect(byPoint.entry.withinVisibleDepth).toBe(true);
    expect(byPoint.stop.withinVisibleDepth).toBe(false);
    expect(byPoint.tp1.withinVisibleDepth).toBe(false);
    expect(byPoint.tp2.withinVisibleDepth).toBe(false);
    // Not just "no wall" — genuinely couldn't check.
    expect(byPoint.stop.wall).toBeNull();
  });

  it("finds a real wall sitting exactly at entry", () => {
    const bidWall: LiquidityWall = { side: "bid", price: 99998, usd: 5_000_000, zScore: 20 };
    const result = executionDistanceContext([{ point: "entry", price: 100000 }], [bidWall], [], range);
    expect(result[0].withinVisibleDepth).toBe(true);
    expect(result[0].wall).toBe(bidWall);
  });

  it("distinguishes 'checked, found nothing' from 'could not check'", () => {
    const withinButEmpty = executionDistanceContext([{ point: "entry", price: 100000 }], [], [], range);
    expect(withinButEmpty[0].withinVisibleDepth).toBe(true);
    expect(withinButEmpty[0].wall).toBeNull();

    const outside = executionDistanceContext([{ point: "stop", price: 50000 }], [], [], range);
    expect(outside[0].withinVisibleDepth).toBe(false);
    expect(outside[0].wall).toBeNull();
  });

  it("treats a null book range as every point being outside visible depth", () => {
    const result = executionDistanceContext([{ point: "entry", price: 100000 }], [], [], null);
    expect(result[0].withinVisibleDepth).toBe(false);
  });
});
