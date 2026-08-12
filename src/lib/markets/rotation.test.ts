import { describe, expect, it } from "vitest";
import { buildRotation, stateOf, RotationInput, ROTATION_LONG_SESSIONS } from "./rotation";
import { Bar } from "@/lib/research/types";

/**
 * The quadrant decides what a user is told to buy. Every case below is
 * hand-constructed so the expected state can be reasoned about from the two
 * relative numbers alone.
 */

const DAY = 86_400_000;

/** A series that ends at `end` having started at `start`, linearly. */
function series(start: number, end: number, n = ROTATION_LONG_SESSIONS + 5): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + ((end - start) * i) / (n - 1);
    return { t: i * DAY, open: c, high: c, low: c, close: c, volume: 1000 };
  });
}

describe("stateOf", () => {
  it("names the four quadrants from the two relative numbers", () => {
    expect(stateOf(5, 5)).toBe("leading");
    expect(stateOf(-5, 5)).toBe("improving");
    expect(stateOf(5, -5)).toBe("weakening");
    expect(stateOf(-5, -5)).toBe("lagging");
  });

  it("treats exactly zero as in-line-or-better, so no sector falls through the cracks", () => {
    // Zero is the benchmark itself. It has to belong somewhere, and the
    // non-negative side is the only choice that keeps the four states total.
    expect(stateOf(0, 0)).toBe("leading");
    expect(stateOf(-1, 0)).toBe("improving");
  });
});

describe("buildRotation", () => {
  const bench: RotationInput = { symbol: "SPY", name: "S&P 500", bars: series(100, 110) };

  it("measures sectors RELATIVE to the benchmark, not on their own return", () => {
    // Both sectors rose. Only one beat the benchmark's +10%.
    const read = buildRotation(
      [
        { symbol: "UP", name: "Outperformer", bars: series(100, 120) },
        { symbol: "MEH", name: "Underperformer", bars: series(100, 105) },
      ],
      bench
    )!;
    expect(read.sectors.map((s) => s.symbol)).toEqual(["UP", "MEH"]);
    expect(read.sectors[0].longRelPct).toBeGreaterThan(0);
    // Rose 5% while the market rose 10% — a gain, and still a laggard.
    expect(read.sectors[1].shortAbsPct).toBeGreaterThan(0);
    expect(read.sectors[1].longRelPct).toBeLessThan(0);
  });

  it("OMITS a sector without enough history rather than defaulting it to zero", () => {
    // Zero would read as "exactly in line with the market", which is a claim
    // about a sector we cannot measure.
    const read = buildRotation(
      [
        { symbol: "OK", name: "Long enough", bars: series(100, 120) },
        { symbol: "NEW", name: "Just listed", bars: series(100, 120, 10) },
      ],
      bench
    )!;
    expect(read.sectors.map((s) => s.symbol)).toEqual(["OK"]);
  });

  it("returns null when the benchmark itself is too short", () => {
    // A relative measure with nothing to be relative to is not a degraded
    // answer, it is a meaningless one.
    expect(
      buildRotation([{ symbol: "A", name: "A", bars: series(100, 120) }], {
        symbol: "SPY",
        name: "S&P 500",
        bars: series(100, 110, 10),
      })
    ).toBeNull();
  });

  it("reports dispersion as the best-to-worst spread — the number that says whether rotation is worth trading", () => {
    const read = buildRotation(
      [
        { symbol: "HOT", name: "Hot", bars: series(100, 130) },
        { symbol: "COLD", name: "Cold", bars: series(100, 100) },
      ],
      bench
    )!;
    expect(read.dispersionPct).toBeCloseTo(read.sectors[0].shortRelPct - read.sectors[1].shortRelPct, 6);
    expect(read.dispersionPct).toBeGreaterThan(0);
  });

  it("is stable: identical inputs in a different order produce the same ranking", () => {
    const inputs: RotationInput[] = [
      { symbol: "A", name: "A", bars: series(100, 120) },
      { symbol: "B", name: "B", bars: series(100, 115) },
      { symbol: "C", name: "C", bars: series(100, 105) },
    ];
    const forward = buildRotation(inputs, bench)!.sectors.map((s) => s.symbol);
    const reversed = buildRotation([...inputs].reverse(), bench)!.sectors.map((s) => s.symbol);
    expect(reversed).toEqual(forward);
  });
});
