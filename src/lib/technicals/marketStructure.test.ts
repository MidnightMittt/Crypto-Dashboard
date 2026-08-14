import { describe, expect, it } from "vitest";
import {
  buildVolumeProfile,
  buildSupportResistanceZones,
  clusterTouches,
  zonesFromClusters,
  mergeOverlappingZones,
  scoreZoneStrength,
  classifyZoneStatus,
  SupportResistanceZone,
  ConfluenceTag,
  nearestWatchLevels,
  watchEdge,
} from "./marketStructure";
import { Candle, fibonacciRetracement } from "./indicators";

/**
 * 90-bar fixture (matching the default window): two zero-volume anchor bars
 * pin the exact high=200/low=100 range, 78 zero-volume filler bars pad out
 * the window without affecting anything (zero volume contributes nothing to
 * any bucket), and 10 bars with a concentrated [150, 152] price range carry
 * ALL the real volume (10,000 each) — the point of control must land in
 * whichever bucket contains [150, 152].
 *
 * Hand-computed bucket boundaries: bucketSize = (200-100)/24 = 4.1666...,
 * so bucket index 12 spans [100 + 12*4.1666.., 100 + 13*4.1666..] =
 * [150.0, 154.1666..] — [150, 152] sits entirely inside it.
 */
function buildConcentratedVolumeFixture(): Candle[] {
  const candles: Candle[] = [];
  candles.push({ t: 0, open: 100, high: 100, low: 100, close: 100, volumeUsd: 0 });
  candles.push({ t: 1, open: 200, high: 200, low: 200, close: 200, volumeUsd: 0 });
  for (let i = 0; i < 78; i++) {
    candles.push({ t: 2 + i, open: 145, high: 145.1, low: 145, close: 145.05, volumeUsd: 0 });
  }
  for (let i = 0; i < 10; i++) {
    candles.push({ t: 80 + i, open: 151, high: 152, low: 150, close: 151, volumeUsd: 10000 });
  }
  return candles;
}

describe("buildVolumeProfile", () => {
  it("returns null with fewer than `window` bars", () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      t: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volumeUsd: 1,
    }));
    expect(buildVolumeProfile(candles, 90)).toBeNull();
  });

  it("places the point of control in the bucket containing the concentrated volume", () => {
    const result = buildVolumeProfile(buildConcentratedVolumeFixture(), 90);
    expect(result).not.toBeNull();
    expect(result!.pointOfControl.priceLow).toBeCloseTo(150, 5);
    expect(result!.pointOfControl.priceHigh).toBeCloseTo(154.16666667, 5);
    // All 10 concentrated bars' volume (10 * 10000) lands in this one
    // bucket, since [150,152] sits entirely inside [150, 154.1666..].
    expect(result!.pointOfControl.volumeUsd).toBeCloseTo(100000, 2);
  });

  it("the value area encloses at least 70% of total volume, centered on the point of control", () => {
    const result = buildVolumeProfile(buildConcentratedVolumeFixture(), 90)!;
    const total = result.levels.reduce((s, l) => s + l.volumeUsd, 0);
    const inValueArea = result.levels
      .filter((l) => l.priceLow >= result.valueAreaLow && l.priceHigh <= result.valueAreaHigh)
      .reduce((s, l) => s + l.volumeUsd, 0);
    expect(inValueArea / total).toBeGreaterThanOrEqual(0.7);
    // With one bucket holding effectively 100% of all real volume, the
    // value area's own single bucket alone already clears 70% — confirming
    // the expansion loop doesn't needlessly grow past what's required.
    expect(result.valueAreaLow).toBeCloseTo(result.pointOfControl.priceLow, 5);
    expect(result.valueAreaHigh).toBeCloseTo(result.pointOfControl.priceHigh, 5);
  });

  it("has exactly 24 buckets spanning the window's high/low", () => {
    const result = buildVolumeProfile(buildConcentratedVolumeFixture(), 90)!;
    expect(result.levels).toHaveLength(24);
    expect(result.levels[0].priceLow).toBeCloseTo(100, 5);
    expect(result.levels[23].priceHigh).toBeCloseTo(200, 5);
  });
});

describe("clusterTouches", () => {
  it("groups touches within tolerance of the running cluster mean", () => {
    const touches = [
      { price: 100, index: 0 },
      { price: 101, index: 5 },
      { price: 102, index: 10 },
      { price: 150, index: 15 },
    ];
    const clusters = clusterTouches(touches, 2);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toHaveLength(3);
    expect(clusters[1]).toHaveLength(1);
  });

  it("splits every touch into its own cluster when tolerance is 0 and prices differ", () => {
    const touches = [
      { price: 1, index: 0 },
      { price: 5, index: 1 },
      { price: 10, index: 2 },
    ];
    expect(clusterTouches(touches, 0)).toHaveLength(3);
  });

  it("returns nothing for empty input", () => {
    expect(clusterTouches([], 5)).toEqual([]);
  });
});

describe("zonesFromClusters", () => {
  it("drops single-touch clusters — repeated reactions are the point of a zone", () => {
    const clusters = [
      [{ price: 100, index: 0 }],
      [
        { price: 200, index: 1 },
        { price: 201, index: 5 },
      ],
    ];
    const zones = zonesFromClusters(clusters, "resistance", 10);
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ priceLow: 200, priceHigh: 201, reactionCount: 2, kind: "resistance", source: "swing-cluster" });
  });

  it("computes mostRecentTouchBarsAgo from the highest index in the cluster", () => {
    const clusters = [
      [
        { price: 100, index: 2 },
        { price: 101, index: 7 },
      ],
    ];
    const zones = zonesFromClusters(clusters, "support", 10);
    // totalBars=10, most recent touch at index 7 -> 10 - 1 - 7 = 2 bars ago.
    expect(zones[0].mostRecentTouchBarsAgo).toBe(2);
  });
});

describe("mergeOverlappingZones", () => {
  const zone = (overrides: Partial<SupportResistanceZone>): SupportResistanceZone => ({
    priceLow: 0,
    priceHigh: 0,
    kind: "support",
    strength: 0,
    reactionCount: 1,
    confluence: [],
    status: "inactive",
    mostRecentTouchBarsAgo: null,
    source: "swing-cluster",
    timeframe: "1D",
    ...overrides,
  });

  it("merges same-kind zones whose ranges sit within tolerance, summing evidence", () => {
    const a = zone({ priceLow: 100, priceHigh: 102, kind: "support", reactionCount: 2, source: "swing-cluster", mostRecentTouchBarsAgo: 5 });
    const b = zone({ priceLow: 103, priceHigh: 105, kind: "support", reactionCount: 0, source: "volume-poc", mostRecentTouchBarsAgo: 2 });
    // gap between a.priceHigh (102) and b.priceLow (103) is 1, within tolerance 2.
    const merged = mergeOverlappingZones([a, b], 2);
    expect(merged).toHaveLength(1);
    expect(merged[0].priceLow).toBe(100);
    expect(merged[0].priceHigh).toBe(105);
    expect(merged[0].reactionCount).toBe(2);
    expect(merged[0].confluence).toEqual(expect.arrayContaining<ConfluenceTag>(["swing-cluster", "volume-poc"]));
    expect(merged[0].mostRecentTouchBarsAgo).toBe(2); // more recent of the two (min bars-ago)
  });

  it("never merges across kinds, even when ranges fully overlap", () => {
    const a = zone({ priceLow: 100, priceHigh: 102, kind: "support" });
    const b = zone({ priceLow: 100, priceHigh: 102, kind: "resistance" });
    expect(mergeOverlappingZones([a, b], 5)).toHaveLength(2);
  });

  it("does not merge zones farther apart than tolerance", () => {
    const a = zone({ priceLow: 100, priceHigh: 102, kind: "support" });
    const b = zone({ priceLow: 110, priceHigh: 112, kind: "support" });
    expect(mergeOverlappingZones([a, b], 2)).toHaveLength(2);
  });
});

describe("scoreZoneStrength", () => {
  const base = {
    priceLow: 0,
    priceHigh: 0,
    kind: "support" as const,
    strength: 0,
    status: "inactive" as const,
    source: "swing-cluster" as const,
    timeframe: "1D" as const,
  };

  it("scores 0 for a zone with no touches, no confluence, and no recency", () => {
    expect(scoreZoneStrength({ ...base, reactionCount: 0, confluence: [], mostRecentTouchBarsAgo: null })).toBe(0);
  });

  it("the touch component saturates at 4 reactions — a 5th doesn't matter more than the 4th", () => {
    const at4 = scoreZoneStrength({ ...base, reactionCount: 4, confluence: [], mostRecentTouchBarsAgo: null });
    const at8 = scoreZoneStrength({ ...base, reactionCount: 8, confluence: [], mostRecentTouchBarsAgo: null });
    expect(at4).toBe(at8);
    expect(at4).toBe(50); // 100 * 0.5 * clamp(4/4,0,1)
  });

  it("the confluence component saturates at 2 independent methods agreeing", () => {
    const oneTag = scoreZoneStrength({ ...base, reactionCount: 0, mostRecentTouchBarsAgo: null, confluence: ["volume-poc"] });
    const twoTags = scoreZoneStrength({ ...base, reactionCount: 0, mostRecentTouchBarsAgo: null, confluence: ["volume-poc", "value-area-edge"] });
    expect(oneTag).toBe(15); // 100 * 0.3 * 0.5
    expect(twoTags).toBe(30); // 100 * 0.3 * 1
  });

  it("the recency component decays linearly to 0 at the full recency window", () => {
    const fresh = scoreZoneStrength({ ...base, reactionCount: 0, confluence: [], mostRecentTouchBarsAgo: 0 });
    expect(fresh).toBe(20); // 100 * 0.2 * 1
    const stale = scoreZoneStrength({ ...base, reactionCount: 0, confluence: [], mostRecentTouchBarsAgo: 90 });
    expect(stale).toBe(0);
  });

  it("reaches 100 for max touches, max confluence, and zero recency", () => {
    expect(
      scoreZoneStrength({ ...base, reactionCount: 4, confluence: ["volume-poc", "value-area-edge"], mostRecentTouchBarsAgo: 0 })
    ).toBe(100);
  });
});

describe("classifyZoneStatus", () => {
  const resistance = { priceLow: 100, priceHigh: 105, kind: "resistance" as const };
  const bar = (close: number, low: number, high: number, t = 0): Candle => ({ t, open: close, high, low, close, volumeUsd: 1 });
  const atrValue = 4; // band = atrValue * 0.25 = 1

  it("returns inactive when there aren't enough bars to judge", () => {
    const short = [bar(90, 89, 91)];
    expect(classifyZoneStatus(resistance, short, atrValue)).toBe("inactive");
  });

  it("testing: the most recent bar's range overlaps the zone", () => {
    const candles = [
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(103, 102, 108), // overlaps [100,105]
    ];
    expect(classifyZoneStatus(resistance, candles, atrValue)).toBe("testing");
  });

  it("breaking: price was below (safe side) ~5 bars ago, now sustained above (broken side)", () => {
    const candles = [
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(90, 89, 91), // recentBars[0] — "prior side" = below = safe for resistance
      bar(95, 94, 96),
      bar(110, 109, 111), // above, no overlap
      bar(110, 109, 111),
      bar(112, 111, 113),
    ];
    expect(classifyZoneStatus(resistance, candles, atrValue)).toBe("breaking");
  });

  it("reclaiming: the exact mirror of breaking — was above, now sustained back below", () => {
    const candles = [
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(112, 111, 113), // recentBars[0] — prior side = above = broken for resistance
      bar(100, 99, 101),
      bar(90, 89, 91), // below, no overlap
      bar(90, 89, 91),
      bar(90, 89, 91),
    ];
    expect(classifyZoneStatus(resistance, candles, atrValue)).toBe("reclaiming");
  });

  it("rejecting: touched the zone 1-4 bars ago, has since moved back to the safe side", () => {
    const candles = [
      bar(90, 89, 91),
      bar(90, 89, 91),
      bar(90, 89, 91), // recentBars[0]
      bar(90, 89, 91), // reject-window bar, no overlap
      bar(103, 101, 104), // reject-window bar — the touch (overlaps [100,105])
      bar(95, 94, 96), // back to safe side, no overlap
      bar(90, 89, 91), // current bar — safe side
    ];
    expect(classifyZoneStatus(resistance, candles, atrValue)).toBe("rejecting");
  });

  it("approaching: gap to the zone is shrinking, still outside, no side-crossing", () => {
    const candles = [
      bar(85, 84, 86),
      bar(85, 84, 86),
      bar(90, 89, 91), // recentBars[0], below/safe throughout — never crosses
      bar(93, 92, 94),
      bar(96, 95, 97),
      bar(97.5, 96.5, 98.5), // distance to zone = 2.5
      bar(98.5, 97.5, 99.5), // distance to zone = 1.5, shrinking, still outside
    ];
    expect(classifyZoneStatus(resistance, candles, atrValue)).toBe("approaching");
  });

  it("inactive: far from the zone, not moving toward it", () => {
    const candles = Array.from({ length: 7 }, () => bar(50, 49, 51));
    expect(classifyZoneStatus(resistance, candles, atrValue)).toBe("inactive");
  });
});

describe("buildSupportResistanceZones — end to end", () => {
  it("clusters two repeated swing highs at the same price into one resistance zone", () => {
    // Two clean swing highs at 200, far apart in time, with the rest of the
    // series oscillating around 100-110 — well-separated by construction so
    // the resulting cluster is unambiguous.
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const isSwingHigh = i === 20 || i === 45;
      const close = isSwingHigh ? 200 : 100 + (i % 5);
      return { t: i, open: close, high: isSwingHigh ? 202 : close + 1, low: close - 1, close, volumeUsd: 100 };
    });
    const zones = buildSupportResistanceZones(candles, null);
    const resistanceZone = zones.find((z) => z.kind === "resistance" && z.priceHigh >= 199 && z.priceLow <= 202);
    expect(resistanceZone).toBeDefined();
    expect(resistanceZone!.reactionCount).toBeGreaterThanOrEqual(2);
    expect(resistanceZone!.source).toBe("swing-cluster");
  });

  it("drops a single, non-repeated swing — one touch isn't a zone", () => {
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const close = i === 30 ? 200 : 100 + (i % 5);
      return { t: i, open: close, high: i === 30 ? 202 : close + 1, low: close - 1, close, volumeUsd: 100 };
    });
    const zones = buildSupportResistanceZones(candles, null);
    expect(zones.find((z) => z.priceHigh >= 199 && z.priceLow <= 202)).toBeUndefined();
  });

  it("returns an empty array when ATR can't be computed", () => {
    expect(buildSupportResistanceZones([], null)).toEqual([]);
  });

  it("returns zones sorted ascending by priceLow", () => {
    const candles: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const close = i === 15 || i === 40 ? 200 : i === 20 || i === 50 ? 50 : 100 + (i % 5);
      const isPivot = i === 15 || i === 40 || i === 20 || i === 50;
      return {
        t: i,
        open: close,
        high: isPivot && close > 100 ? close + 2 : close + 1,
        low: isPivot && close < 100 ? close - 2 : close - 1,
        close,
        volumeUsd: 100,
      };
    });
    const zones = buildSupportResistanceZones(candles, null);
    const lows = zones.map((z) => z.priceLow);
    expect(lows).toEqual([...lows].sort((a, b) => a - b));
  });

  /*
   * REGRESSION: ancient history must not produce levels.
   *
   * This function used to cluster whatever series it was handed, which was
   * harmless while every caller was bounded by OKX's 300-candle cap — and
   * badly wrong the first time it was handed 8,440 bars of SPY back to 1993.
   * The clustering tolerance is a fraction of CURRENT ATR, which is enormous
   * relative to 1990s prices, so decades of levels collapsed into one "zone"
   * spanning several hundred percent of its own low.
   *
   * The fixture reproduces exactly that shape: a long-ago era around 20, a
   * recent era around 1000. If the window is ever removed, the era-20 pivots
   * come back and this fails.
   */
  it("ignores bars beyond the 300-session window — a level from a different price era is not a level", () => {
    const pivotAt = (i: number, base: number) => {
      const isHigh = i % 20 === 5;
      const isLow = i % 20 === 15;
      const close = isHigh ? base * 1.1 : isLow ? base * 0.9 : base;
      return {
        t: i,
        open: close,
        high: isHigh ? close + base * 0.02 : close + base * 0.005,
        low: isLow ? close - base * 0.02 : close - base * 0.005,
        close,
        volumeUsd: 100,
      };
    };
    // 400 ancient bars around 20, then 300 recent bars around 1000.
    const candles: Candle[] = [
      ...Array.from({ length: 400 }, (_, i) => pivotAt(i, 20)),
      ...Array.from({ length: 300 }, (_, i) => pivotAt(400 + i, 1000)),
    ];

    const zones = buildSupportResistanceZones(candles, null);

    expect(zones.length).toBeGreaterThan(0);
    // Nothing from the era the window excludes.
    expect(zones.every((z) => z.priceLow > 100)).toBe(true);
    // And no single zone spans the two eras, which is how the bug presented.
    expect(zones.every((z) => z.priceHigh / z.priceLow < 2)).toBe(true);
  });
});

describe("nearestWatchLevels — one rule, three consumers", () => {
  const zone = (kind: "support" | "resistance", lo: number, hi: number): SupportResistanceZone =>
    ({
      kind,
      priceLow: lo,
      priceHigh: hi,
      reactionCount: 2,
      timeframe: "1D",
      confluence: [],
      lastTouchBarsAgo: null,
      strength: 1,
    }) as unknown as SupportResistanceZone;

  const zones = [
    zone("support", 80, 85),
    zone("support", 90, 95), // nearest below 100
    zone("resistance", 105, 110), // nearest above 100
    zone("resistance", 120, 130),
  ];

  it("picks the closest zone on each side of price", () => {
    const n = nearestWatchLevels(zones, 100);
    expect(n.support?.priceHigh).toBe(95);
    expect(n.resistance?.priceLow).toBe(105);
  });

  /*
   * The edge is what price REACHES first: the top of a support coming down,
   * the bottom of a resistance coming up. A midpoint would overstate every
   * distance and therefore understate every published reach probability —
   * the same bias in the display, the forward record and the replay at once.
   */
  it("measures to the edge price reaches first, not the middle of the zone", () => {
    const n = nearestWatchLevels(zones, 100);
    expect(watchEdge(n.support!, "long")).toBe(95);
    expect(watchEdge(n.resistance!, "short")).toBe(105);
  });

  it("ignores zones on the wrong side of price entirely", () => {
    // Price below every support: nothing qualifies as "support below".
    const n = nearestWatchLevels(zones, 70);
    expect(n.support).toBeNull();
    expect(n.resistance?.priceLow).toBe(105);
  });

  it("returns nulls rather than throwing when there is no structure", () => {
    const n = nearestWatchLevels([], 100);
    expect(n.support).toBeNull();
    expect(n.resistance).toBeNull();
  });
});
