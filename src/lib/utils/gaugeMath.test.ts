import { describe, it, expect } from "vitest";
import {
  valueToAngle,
  polarToCartesian,
  describeArc,
  buildColorBands,
  ARC_START_DEG,
  ARC_SWEEP_DEG,
} from "./gaugeMath";

describe("valueToAngle", () => {
  it("places the minimum value at the arc's start angle", () => {
    expect(valueToAngle(0, 0, 100)).toBe(ARC_START_DEG);
  });

  it("places the maximum value at the arc's end angle", () => {
    expect(valueToAngle(100, 0, 100)).toBe(ARC_START_DEG + ARC_SWEEP_DEG);
  });

  it("places the midpoint value halfway around the sweep", () => {
    expect(valueToAngle(50, 0, 100)).toBe(ARC_START_DEG + ARC_SWEEP_DEG / 2);
  });

  it("clamps a value below the minimum to the start angle rather than extrapolating past it", () => {
    // A needle must never swing past its physical dial limits, even if the
    // underlying metric goes out of the gauge's configured range.
    expect(valueToAngle(-50, 0, 100)).toBe(ARC_START_DEG);
  });

  it("clamps a value above the maximum to the end angle", () => {
    expect(valueToAngle(500, 0, 100)).toBe(ARC_START_DEG + ARC_SWEEP_DEG);
  });

  it("handles a negative-to-positive range correctly (e.g. the funding gauge's -0.3 to 0.3)", () => {
    expect(valueToAngle(0, -0.3, 0.3)).toBe(ARC_START_DEG + ARC_SWEEP_DEG / 2);
    expect(valueToAngle(0.3, -0.3, 0.3)).toBe(ARC_START_DEG + ARC_SWEEP_DEG);
    expect(valueToAngle(-0.3, -0.3, 0.3)).toBe(ARC_START_DEG);
  });

  it("does not divide by zero when min equals max", () => {
    expect(valueToAngle(5, 10, 10)).toBe(ARC_START_DEG);
  });
});

describe("polarToCartesian", () => {
  it("places 12 o'clock (0 deg) directly above the center", () => {
    const p = polarToCartesian(100, 100, 50, 0);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(50, 6); // above center means smaller y in SVG coords
  });

  it("places 3 o'clock (90 deg) directly to the right of the center", () => {
    const p = polarToCartesian(100, 100, 50, 90);
    expect(p.x).toBeCloseTo(150, 6);
    expect(p.y).toBeCloseTo(100, 6);
  });

  it("places 6 o'clock (180 deg) directly below the center", () => {
    const p = polarToCartesian(100, 100, 50, 180);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(150, 6);
  });

  it("places 9 o'clock (270 deg) directly to the left of the center", () => {
    const p = polarToCartesian(100, 100, 50, 270);
    expect(p.x).toBeCloseTo(50, 6);
    expect(p.y).toBeCloseTo(100, 6);
  });

  it("returns the center point itself when radius is 0", () => {
    const p = polarToCartesian(42, 42, 0, 137);
    expect(p.x).toBeCloseTo(42, 6);
    expect(p.y).toBeCloseTo(42, 6);
  });
});

describe("buildColorBands", () => {
  it("splits the full sweep into equal sub-arcs, one per color", () => {
    const bands = buildColorBands(["red", "yellow", "green"]);
    expect(bands).toHaveLength(3);
    expect(bands[0].start).toBe(ARC_START_DEG);
    expect(bands[bands.length - 1].end).toBe(ARC_START_DEG + ARC_SWEEP_DEG);
  });

  it("produces contiguous sub-arcs with no gaps or overlaps", () => {
    const bands = buildColorBands(["a", "b", "c", "d"]);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].start).toBe(bands[i - 1].end);
    }
  });

  it("assigns each color to its corresponding band in order", () => {
    const bands = buildColorBands(["red", "green", "blue"]);
    expect(bands.map((b) => b.color)).toEqual(["red", "green", "blue"]);
  });
});

describe("describeArc", () => {
  it("produces a well-formed SVG arc path string starting with M and containing an A command", () => {
    const path = describeArc(130, 138, 98, ARC_START_DEG, ARC_START_DEG + ARC_SWEEP_DEG);
    expect(path.startsWith("M ")).toBe(true);
    expect(path).toContain(" A ");
  });

  it("sets the large-arc-flag to 1 for the full 270-degree gauge sweep", () => {
    // Any sweep over 180 degrees needs largeArcFlag=1, or SVG will render the
    // short way around instead of the intended long way.
    const path = describeArc(130, 138, 98, ARC_START_DEG, ARC_START_DEG + ARC_SWEEP_DEG);
    // Path shape: M x y A r r 0 <largeArcFlag> 1 x y
    const flag = path.split(" ")[7];
    expect(flag).toBe("1");
  });

  it("sets the large-arc-flag to 0 for a sweep under 180 degrees", () => {
    const path = describeArc(130, 138, 98, 0, 90);
    const flag = path.split(" ")[7];
    expect(flag).toBe("0");
  });

  it("always sweeps clockwise (sweep flag = 1)", () => {
    const path = describeArc(130, 138, 98, 0, 90);
    const sweepFlag = path.split(" ")[8];
    expect(sweepFlag).toBe("1");
  });
});
