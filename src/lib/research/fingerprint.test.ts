import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH,
  DIMENSIONS,
  FINGERPRINT_VERSION,
  MarketFingerprint,
  findNeighbours,
  fingerprintDistance,
  summariseIndependence,
} from "./fingerprint";

const fp = (symbol: string, date: string, values: Record<string, number> = {}): MarketFingerprint => ({
  symbol,
  date,
  version: FINGERPRINT_VERSION,
  // Default to a fully-populated neutral vector so tests vary one thing at a time.
  values: { ...Object.fromEntries(DIMENSIONS.map((d) => [d.id, 0])), ...values },
});

describe("the fingerprint definition", () => {
  it("is fixed, ordered, and carries a version", () => {
    // The definition is the contract. Changing it must be a deliberate edit
    // here, and must bump the version so old vectors are never compared
    // against new ones with different dimensions.
    expect(DIMENSIONS.map((d) => d.id)).toEqual([
      "trend",
      "volatility",
      "technicalStructure",
      "relativeStrength",
      "riskRegime",
      "breadth",
      "macroBackdrop",
      "sectorLeadership",
      "volumeProfile",
      "industryLeadership",
      "harmonics",
    ]);
    expect(FINGERPRINT_VERSION).toBe(1);
  });

  it("keeps weights positive and roughly normalised", () => {
    expect(DIMENSIONS.every((d) => d.weight > 0)).toBe(true);
    const total = DIMENSIONS.reduce((s, d) => s + d.weight, 0);
    expect(total).toBeCloseTo(1, 1);
  });
});

describe("fingerprintDistance", () => {
  it("is zero for identical environments and grows with the gap", () => {
    expect(fingerprintDistance(fp("A", "2020-01-01"), fp("B", "2015-06-01"))).toBe(0);
    const near = fingerprintDistance(fp("A", "2020-01-01"), fp("B", "2015-06-01", { trend: 0.5 }));
    const far = fingerprintDistance(fp("A", "2020-01-01"), fp("B", "2015-06-01", { trend: 2 }));
    expect(far).toBeGreaterThan(near);
  });

  it("weights a heavy dimension more than a light one", () => {
    const heavy = fingerprintDistance(fp("A", "2020-01-01"), fp("B", "2015-06-01", { trend: 1 }));
    const light = fingerprintDistance(fp("A", "2020-01-01"), fp("B", "2015-06-01", { harmonics: 1 }));
    expect(heavy).toBeGreaterThan(light);
  });

  /*
   * A day missing a dimension must not be scored as if it measured zero.
   * Zero is a claim ("perfectly average"); absence is the lack of one.
   */
  it("compares the shared dimensions rather than treating absence as average", () => {
    const full = fp("A", "2020-01-01", { harmonics: 3 });
    const partial: MarketFingerprint = { ...fp("B", "2015-06-01"), values: { ...fp("B", "2015-06-01").values } };
    delete partial.values.harmonics;
    // The 3-sigma harmonic reading is simply not compared, so these are identical.
    expect(fingerprintDistance(full, partial)).toBe(0);
  });

  it("refuses to compare vectors with too little in common", () => {
    const thin: MarketFingerprint = { symbol: "B", date: "2015-06-01", version: FINGERPRINT_VERSION, values: { trend: 0 } };
    expect(fingerprintDistance(fp("A", "2020-01-01"), thin)).toBe(Infinity);
  });

  it("refuses to compare across versions", () => {
    const other = { ...fp("B", "2015-06-01"), version: 2 };
    expect(fingerprintDistance(fp("A", "2020-01-01"), other)).toBe(Infinity);
  });
});

describe("findNeighbours", () => {
  const lib = (rows: Array<[string, string, number]>) =>
    rows.map(([symbol, date, trend]) => ({ fingerprint: fp(symbol, date, { trend }), outcome: { r: trend } }));

  it("returns the closest environments first", () => {
    const out = findNeighbours(fp("X", "2026-01-01"), lib([
      ["A", "2010-01-01", 2],
      ["B", "2011-01-01", 0.1],
      ["C", "2012-01-01", 1],
    ]));
    expect(out.map((n) => n.fingerprint.symbol)).toEqual(["B", "C", "A"]);
  });

  /*
   * THE POINT OF THE DE-CLUSTERING. A single instrument sitting in one
   * regime for a month produces twenty near-identical days. Without this,
   * "20 similar environments" is one environment counted twice a day for a
   * month.
   */
  it("takes one day per instrument per window, not a whole month of the same regime", () => {
    const month: Array<[string, string, number]> = [];
    for (let d = 1; d <= 20; d++) month.push(["AAA", `2010-03-${String(d).padStart(2, "0")}`, 0.01 * d]);
    const out = findNeighbours(fp("X", "2026-01-01"), lib(month));
    expect(out).toHaveLength(1);
    expect(out[0].fingerprint.symbol).toBe("AAA");
  });

  it("still accepts the same instrument from a genuinely separate episode", () => {
    const out = findNeighbours(fp("X", "2026-01-01"), lib([
      ["AAA", "2010-03-01", 0.1],
      ["AAA", "2010-03-02", 0.1], // same episode — excluded
      ["AAA", "2014-09-01", 0.1], // years later — a real second observation
    ]));
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.fingerprint.date)).toEqual(["2010-03-01", "2014-09-01"]);
  });

  it("never matches a target against its own recent past", () => {
    const out = findNeighbours(fp("X", "2026-01-01"), lib([
      ["X", "2025-12-28", 0], // 4 days earlier — the same environment, trivially
      ["Y", "2010-01-01", 0],
    ]));
    expect(out.map((n) => n.fingerprint.symbol)).toEqual(["Y"]);
  });

  it("returns nothing rather than a stretched match when the environment is novel", () => {
    const out = findNeighbours(
      fp("X", "2026-01-01"),
      lib([["A", "2010-01-01", 99]]),
      { ...DEFAULT_SEARCH, maxDistance: 0.5 }
    );
    expect(out).toEqual([]);
  });

  it("honours k", () => {
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 30; i++) rows.push([`S${i}`, "2010-01-01", 0.01 * i]);
    expect(findNeighbours(fp("X", "2026-01-01"), lib(rows), { ...DEFAULT_SEARCH, k: 10 })).toHaveLength(10);
  });
});

describe("summariseIndependence", () => {
  /*
   * THE NUMBER THAT STOPS THE LIE. Forty correlated names in one week is not
   * forty observations. At the panel's measured rho this is worth close to
   * one, and the summary has to say so in the same breath as the count.
   */
  it("charges for correlation when every match is the same week", () => {
    const dates = Array(40).fill("2020-03-16");
    const symbols = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const out = summariseIndependence(dates, symbols, 0.82, 21, 10);
    expect(out.matches).toBe(40);
    expect(out.episodes).toBe(1);
    expect(out.effectiveN).toBeLessThan(2);
    expect(out.line).toContain("move together");
    expect(out.line).toContain("40");
  });

  it("leaves a genuinely spread sample close to its face value", () => {
    const dates = Array.from({ length: 12 }, (_, i) => `20${String(10 + i).padStart(2, "0")}-06-01`);
    const symbols = dates.map((_, i) => `S${i}`);
    const out = summariseIndependence(dates, symbols, 0.82, 21, 10);
    expect(out.episodes).toBe(12);
    expect(out.effectiveN).toBeGreaterThan(9);
    expect(out.line).toContain("close to");
  });

  it("says so plainly when nothing matched", () => {
    const out = summariseIndependence([], [], 0.82, 21, 10);
    expect(out.effectiveN).toBe(0);
    expect(out.line).toContain("No comparable historical environment");
  });

  it("is independent of the order the dates arrive in", () => {
    const dates = ["2020-03-16", "2014-01-02", "2020-03-18", "2014-01-03"];
    const symbols = ["A", "B", "C", "D"];
    const fwd = summariseIndependence(dates, symbols, 0.82, 21, 10);
    const back = summariseIndependence([...dates].reverse(), [...symbols].reverse(), 0.82, 21, 10);
    expect(back.episodes).toBe(fwd.episodes);
    expect(back.effectiveN).toBeCloseTo(fwd.effectiveN, 10);
  });
});
