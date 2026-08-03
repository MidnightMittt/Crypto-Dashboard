import { describe, it, expect } from "vitest";
import {
  bandFor,
  bandPosition,
  bandTrigger,
  FUNDING_BANDS,
  OI_BANDS,
  LEVERAGE_HEAT_BANDS,
  LONG_SHORT_BANDS,
  DOMINANCE_ROTATION_BANDS,
  COMPOSITE_BANDS,
} from "./bands";
import { SentimentBand } from "@/types/market";

describe("bandFor", () => {
  const bands: SentimentBand[] = [
    { min: 0, max: 10, label: "Low", description: "" },
    { min: 10, max: 20, label: "Mid", description: "" },
    { min: 20, max: 30, label: "High", description: "" },
  ];

  it("selects the band containing a mid-range value", () => {
    expect(bandFor(15, bands).label).toBe("Mid");
  });

  it("at an exact shared boundary, the first matching band wins (array order), covering the point twice by design", () => {
    // Both "Low" (max: 10) and "Mid" (min: 10) match value=10 since both
    // bounds are inclusive. Array.find returns the first match.
    expect(bandFor(10, bands).label).toBe("Low");
  });

  it("falls back to the last band for a value beyond every range's maximum", () => {
    expect(bandFor(1000, bands).label).toBe("High");
  });

  it("falls back to the last band for a value below every range's minimum too (no band matches, so .find returns undefined -> fallback)", () => {
    expect(bandFor(-1000, bands).label).toBe("High");
  });
});

/**
 * Real band tables: verify they're gapless and internally ordered, since a
 * gap would silently fall through to the wrong label for values in it.
 */
function assertNoGaps(bands: SentimentBand[], name: string) {
  for (let i = 1; i < bands.length; i++) {
    expect(bands[i].min, `${name}[${i}].min should equal ${name}[${i - 1}].max`).toBe(
      bands[i - 1].max
    );
  }
}

describe("band table integrity", () => {
  it("FUNDING_BANDS has no gaps between consecutive ranges", () => {
    assertNoGaps(FUNDING_BANDS, "FUNDING_BANDS");
  });
  it("OI_BANDS has no gaps between consecutive ranges", () => {
    assertNoGaps(OI_BANDS, "OI_BANDS");
  });
  it("LEVERAGE_HEAT_BANDS has no gaps between consecutive ranges", () => {
    assertNoGaps(LEVERAGE_HEAT_BANDS, "LEVERAGE_HEAT_BANDS");
  });
  it("LONG_SHORT_BANDS has no gaps between consecutive ranges", () => {
    assertNoGaps(LONG_SHORT_BANDS, "LONG_SHORT_BANDS");
  });
  it("COMPOSITE_BANDS has no gaps between consecutive ranges", () => {
    assertNoGaps(COMPOSITE_BANDS, "COMPOSITE_BANDS");
  });
  it("DOMINANCE_ROTATION_BANDS has no gaps between consecutive ranges", () => {
    assertNoGaps(DOMINANCE_ROTATION_BANDS, "DOMINANCE_ROTATION_BANDS");
  });

  it("every 0-100 scored band table (OI, heat, long/short, composite, dominance rotation) actually spans 0 to 100", () => {
    for (const [name, bands] of [
      ["OI_BANDS", OI_BANDS],
      ["LEVERAGE_HEAT_BANDS", LEVERAGE_HEAT_BANDS],
      ["LONG_SHORT_BANDS", LONG_SHORT_BANDS],
      ["COMPOSITE_BANDS", COMPOSITE_BANDS],
      ["DOMINANCE_ROTATION_BANDS", DOMINANCE_ROTATION_BANDS],
    ] as const) {
      expect(bands[0].min, name).toBe(0);
      expect(bands[bands.length - 1].max, name).toBe(100);
    }
  });

  it("DOMINANCE_ROTATION_BANDS' 25/75 split matches blockchaincenter.net's real Altcoin Season Index definition", () => {
    expect(DOMINANCE_ROTATION_BANDS[0].max).toBe(25);
    expect(DOMINANCE_ROTATION_BANDS[DOMINANCE_ROTATION_BANDS.length - 1].min).toBe(75);
  });
});

describe("bandPosition", () => {
  const bands: SentimentBand[] = [
    { min: 0, max: 20, label: "Low", description: "" },
    { min: 20, max: 40, label: "Mid-Low", description: "" },
    { min: 40, max: 60, label: "Mid", description: "" },
    { min: 60, max: 80, label: "Mid-High", description: "" },
    { min: 80, max: 100, label: "High", description: "" },
  ];

  it("places the first band at position 0 and the last at position 100", () => {
    expect(bandPosition(10, bands).position).toBe(0);
    expect(bandPosition(90, bands).position).toBe(100);
  });

  it("spaces middle bands evenly by INDEX, not by where the value sits within its own band's range", () => {
    // 21 sits near the very start of "Mid-Low"'s 20-40 range, but position
    // is by band index (1 of 4 gaps -> 25), not by how far into that
    // specific band the value happens to be.
    expect(bandPosition(21, bands).position).toBe(25);
    expect(bandPosition(39, bands).position).toBe(25);
    expect(bandPosition(50, bands).position).toBe(50);
    expect(bandPosition(70, bands).position).toBe(75);
  });

  it("returns the matching band's label and index together with the position", () => {
    const result = bandPosition(45, bands);
    expect(result.label).toBe("Mid");
    expect(result.index).toBe(2);
  });

  it("falls back to the last band (and position 100) for an out-of-range value, matching bandFor's own fallback", () => {
    const result = bandPosition(1000, bands);
    expect(result.label).toBe("High");
    expect(result.position).toBe(100);
  });

  it("returns position 50 for a single-band table rather than dividing by zero", () => {
    const single: SentimentBand[] = [{ min: 0, max: 100, label: "Only", description: "" }];
    expect(bandPosition(50, single).position).toBe(50);
  });

  it("matches bandFor's chosen label for every real band table at a representative value from each tier", () => {
    for (const bands of [FUNDING_BANDS, OI_BANDS, LEVERAGE_HEAT_BANDS, LONG_SHORT_BANDS, DOMINANCE_ROTATION_BANDS]) {
      for (const b of bands) {
        const midpoint = (b.min + b.max) / 2;
        expect(bandPosition(midpoint, bands).label).toBe(bandFor(midpoint, bands).label);
      }
    }
  });
});

describe("bandTrigger", () => {
  /*
   * These tests deliberately assert against the BAND TABLES THEMSELVES
   * rather than against hard-coded numbers. The whole point of bandTrigger
   * is that a "watch this level" sentence on the dashboard cannot drift
   * from the threshold that actually produces the verdict — so if a band
   * moves, these must follow it automatically rather than fail.
   */
  const TABLES: Array<[string, SentimentBand[]]> = [
    ["FUNDING_BANDS", FUNDING_BANDS],
    ["OI_BANDS", OI_BANDS],
    ["LEVERAGE_HEAT_BANDS", LEVERAGE_HEAT_BANDS],
    ["LONG_SHORT_BANDS", LONG_SHORT_BANDS],
    ["DOMINANCE_ROTATION_BANDS", DOMINANCE_ROTATION_BANDS],
    ["COMPOSITE_BANDS", COMPOSITE_BANDS],
  ];

  it("names the exact boundary of the band a value sits in", () => {
    // Neutral funding: the trigger must be the real ±0.04 edge of that band.
    const neutral = FUNDING_BANDS.find((b) => b.label === "Neutral")!;
    const t = bandTrigger(0, FUNDING_BANDS);
    expect(t.current.label).toBe("Neutral");
    expect(t.above!.threshold).toBe(neutral.max);
    expect(t.below!.threshold).toBe(neutral.min);
  });

  it("names the band waiting on the other side of each boundary", () => {
    const t = bandTrigger(0, FUNDING_BANDS);
    expect(t.above!.label).toBe("Bullish");
    expect(t.below!.label).toBe("Bearish");
  });

  it("reports distance to each boundary from the current value", () => {
    const t = bandTrigger(0.01, FUNDING_BANDS);
    expect(t.above!.distance).toBeCloseTo(0.03, 10);
    expect(t.below!.distance).toBeCloseTo(0.05, 10);
  });

  it("returns null on the outer side rather than quoting a sentinel bound", () => {
    // -100/+100 are placeholders, not levels any market reaches. Surfacing
    // them as something to "watch" would be nonsense.
    const top = bandTrigger(50, FUNDING_BANDS);
    expect(top.current.label).toBe("Crowded Longs");
    expect(top.above).toBeNull();
    expect(top.below).not.toBeNull();

    const bottom = bandTrigger(-50, FUNDING_BANDS);
    expect(bottom.current.label).toBe("Extreme Shorts");
    expect(bottom.below).toBeNull();
    expect(bottom.above).not.toBeNull();
  });

  for (const [name, bands] of TABLES) {
    it(`stays consistent with bandFor across ${name}`, () => {
      for (const band of bands) {
        const mid = (Math.max(band.min, -50) + Math.min(band.max, 150)) / 2;
        const t = bandTrigger(mid, bands);
        expect(t.current.label).toBe(bandFor(mid, bands).label);
      }
    });

    it(`quotes only real boundaries in ${name}`, () => {
      const valid = new Set<number>();
      bands.forEach((b, i) => {
        if (i > 0) valid.add(b.min);
        if (i < bands.length - 1) valid.add(b.max);
      });
      for (const band of bands) {
        const mid = (Math.max(band.min, -50) + Math.min(band.max, 150)) / 2;
        const t = bandTrigger(mid, bands);
        if (t.above) expect(valid.has(t.above.threshold)).toBe(true);
        if (t.below) expect(valid.has(t.below.threshold)).toBe(true);
      }
    });
  }
});
