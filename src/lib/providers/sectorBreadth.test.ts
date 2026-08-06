import { describe, it, expect } from "vitest";
import { computeBreadthPct, SectorReading } from "./sectorBreadth";

const sector = (name: string, mcapChange24hPct: number): SectorReading => ({ name, mcapChange24hPct });

describe("computeBreadthPct", () => {
  it("hand-computed: 6 of 8 sectors positive -> 75%", () => {
    const sectors = [
      sector("A", 1.2),
      sector("B", 0.5),
      sector("C", -0.3),
      sector("D", 2.1),
      sector("E", 0.1),
      sector("F", -1.0),
      sector("G", 0.8),
      sector("H", 3.0),
    ];
    expect(computeBreadthPct(sectors)).toBeCloseTo(75, 10);
  });

  it("returns 100 when every tracked sector is positive", () => {
    expect(computeBreadthPct([sector("A", 0.1), sector("B", 5.0)])).toBe(100);
  });

  it("returns 0 when every tracked sector is negative or flat", () => {
    expect(computeBreadthPct([sector("A", -0.1), sector("B", 0)])).toBe(0);
  });

  it("treats exactly 0% change as NOT positive — flat isn't participation", () => {
    expect(computeBreadthPct([sector("A", 0), sector("B", 0), sector("C", 1)])).toBeCloseTo(100 / 3, 10);
  });

  it("returns null for an empty sector list — nothing to report, not a fabricated number", () => {
    expect(computeBreadthPct([])).toBeNull();
  });
});
