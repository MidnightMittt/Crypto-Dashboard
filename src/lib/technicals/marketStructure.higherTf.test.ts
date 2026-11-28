import { describe, it, expect } from "vitest";
import {
  zoneTier,
  tagHigherTimeframeConfluence,
  buildMultiTimeframeStructure,
  buildSupportResistanceZones,
  buildVolumeProfile,
  mergeTimeframeZones,
  SupportResistanceZone,
} from "./marketStructure";
import { Candle } from "./indicators";

const DAY = 86_400_000;
const T0 = Date.parse("2024-01-01T00:00:00Z"); // a Monday

/**
 * A synthetic daily series that oscillates between two bands, so swing highs
 * and lows genuinely cluster and real zones can form. Deterministic — no
 * Math.random, so a failure is reproducible.
 */
function oscillating(n: number, lo = 100, hi = 140): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const phase = Math.sin((i / 11) * Math.PI * 2);
    const mid = (lo + hi) / 2 + ((hi - lo) / 2) * phase;
    return {
      t: T0 + i * DAY,
      open: mid - 1,
      high: mid + 2 + (i % 3),
      low: mid - 2 - (i % 3),
      close: mid,
      volumeUsd: 1_000_000 + (i % 7) * 50_000,
    };
  });
}

function zone(partial: Partial<SupportResistanceZone>): SupportResistanceZone {
  return {
    priceLow: 100, priceHigh: 102, kind: "support", strength: 40, reactionCount: 2,
    confluence: [], status: "inactive", mostRecentTouchBarsAgo: 5,
    source: "swing-cluster", timeframe: "1D", ...partial,
  };
}

describe("zoneTier", () => {
  it("ranks monthly as major, weekly as intermediate, the rest as minor", () => {
    expect(zoneTier("1M")).toBe("major");
    expect(zoneTier("1W")).toBe("intermediate");
    expect(zoneTier("1D")).toBe("minor");
    expect(zoneTier("4H")).toBe("minor");
    expect(zoneTier("both")).toBe("minor");
  });
});

describe("tagHigherTimeframeConfluence", () => {
  it("tags a base zone that overlaps a higher-timeframe zone of the same kind", () => {
    const base = [zone({ priceLow: 100, priceHigh: 104 })];
    const higher = [zone({ priceLow: 103, priceHigh: 110, timeframe: "1W" })];
    const out = tagHigherTimeframeConfluence(base, higher);
    expect(out[0].confluence).toContain("multi-timeframe");
  });

  it("does NOT tag when the zones are opposite kinds at the same price", () => {
    const base = [zone({ priceLow: 100, priceHigh: 104, kind: "support" })];
    const higher = [zone({ priceLow: 100, priceHigh: 104, kind: "resistance", timeframe: "1W" })];
    expect(tagHigherTimeframeConfluence(base, higher)[0].confluence).not.toContain("multi-timeframe");
  });

  it("does NOT tag when they do not overlap", () => {
    const base = [zone({ priceLow: 100, priceHigh: 104 })];
    const higher = [zone({ priceLow: 200, priceHigh: 210, timeframe: "1W" })];
    expect(tagHigherTimeframeConfluence(base, higher)[0].confluence).not.toContain("multi-timeframe");
  });

  it("adds the tag AT MOST ONCE even when both weekly and monthly overlap", () => {
    // Two higher timeframes agreeing is ONE kind of agreement, not two. Counting
    // it twice would inflate strength for substantially the same observation.
    const base = [zone({ priceLow: 100, priceHigh: 104 })];
    const higher = [
      zone({ priceLow: 99, priceHigh: 105, timeframe: "1W" }),
      zone({ priceLow: 98, priceHigh: 106, timeframe: "1M" }),
    ];
    const out = tagHigherTimeframeConfluence(base, higher);
    expect(out[0].confluence.filter((t) => t === "multi-timeframe")).toHaveLength(1);
  });

  it("never widens the base zone — tagging is not merging", () => {
    const base = [zone({ priceLow: 100, priceHigh: 104 })];
    const higher = [zone({ priceLow: 60, priceHigh: 180, timeframe: "1M" })]; // enormously wider
    const out = tagHigherTimeframeConfluence(base, higher);
    expect(out[0].priceLow).toBe(100);
    expect(out[0].priceHigh).toBe(104);
  });

  it("is a no-op when there are no higher-timeframe zones", () => {
    const base = [zone({})];
    expect(tagHigherTimeframeConfluence(base, [])).toBe(base);
  });
});

describe("buildMultiTimeframeStructure", () => {
  it("REGRESSION GUARD: with no higher series, output matches the existing daily+4H path exactly", () => {
    const daily = oscillating(320);
    const fourH = oscillating(300, 101, 139);
    const expected = mergeTimeframeZones(
      buildSupportResistanceZones(daily, buildVolumeProfile(daily), "1D"),
      buildSupportResistanceZones(fourH, null, "4H"),
      daily
    ).sort((a, b) => a.priceLow - b.priceLow);

    const got = buildMultiTimeframeStructure({ daily, fourH }).zones;
    expect(got).toEqual(expected);
  });

  it("produces zones tagged with the timeframe that generated them", () => {
    const daily = oscillating(400);
    const weekly = oscillating(120, 90, 150);
    const monthly = oscillating(40, 80, 170);
    const { zones } = buildMultiTimeframeStructure({ daily, weekly, monthly });
    const tfs = new Set(zones.map((z) => z.timeframe));
    expect(tfs.has("1W")).toBe(true);
    expect(tfs.has("1M")).toBe(true);
    // every zone carries an origin — none left undefined
    expect(zones.every((z) => z.timeframe !== undefined)).toBe(true);
  });

  it("skips a series too short to produce a pivot rather than inventing zones", () => {
    const daily = oscillating(320);
    const { counts } = buildMultiTimeframeStructure({ daily, weekly: oscillating(3) });
    expect(counts["1W"]).toBe(0);
  });

  it("handles missing higher series without throwing", () => {
    const daily = oscillating(320);
    expect(() => buildMultiTimeframeStructure({ daily })).not.toThrow();
    expect(buildMultiTimeframeStructure({ daily }).zones.length).toBeGreaterThan(0);
  });

  it("returns empty for an empty daily series", () => {
    expect(buildMultiTimeframeStructure({ daily: [] }).zones).toHaveLength(0);
  });

  it("keeps major levels visible after price moves far away from them", () => {
    // Build structure in a 100-140 band, then append a run up to ~300.
    // A monthly level at the old band must still be reported — that is the
    // entire point of multi-year structure.
    const base = oscillating(300);
    const rally = Array.from({ length: 60 }, (_, i) => {
      const p = 140 + i * 2.7;
      return { t: T0 + (300 + i) * DAY, open: p - 1, high: p + 2, low: p - 2, close: p, volumeUsd: 1_000_000 };
    });
    const daily = [...base, ...rally];
    const monthly = oscillating(40, 100, 140); // the old band, as monthly structure
    const { zones } = buildMultiTimeframeStructure({ daily, monthly });
    const oldBandZones = zones.filter((z) => z.timeframe === "1M" && z.priceHigh < 160);
    expect(oldBandZones.length).toBeGreaterThan(0);
  });
});
