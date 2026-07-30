import { describe, it, expect } from "vitest";
import {
  bandFor,
  FUNDING_BANDS,
  OI_BANDS,
  LEVERAGE_HEAT_BANDS,
  LONG_SHORT_BANDS,
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

  it("every 0-100 scored band table (OI, heat, long/short, composite) actually spans 0 to 100", () => {
    for (const [name, bands] of [
      ["OI_BANDS", OI_BANDS],
      ["LEVERAGE_HEAT_BANDS", LEVERAGE_HEAT_BANDS],
      ["LONG_SHORT_BANDS", LONG_SHORT_BANDS],
      ["COMPOSITE_BANDS", COMPOSITE_BANDS],
    ] as const) {
      expect(bands[0].min, name).toBe(0);
      expect(bands[bands.length - 1].max, name).toBe(100);
    }
  });
});
