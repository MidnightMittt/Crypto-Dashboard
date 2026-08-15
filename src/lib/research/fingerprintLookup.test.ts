import { describe, expect, it } from "vitest";
import { FingerprintLibrary, lookupNeighbourhood } from "./fingerprintLookup";
import { DIMENSIONS, FINGERPRINT_VERSION, MarketFingerprint } from "./fingerprint";

const values = (over: Record<string, number> = {}) => ({
  ...Object.fromEntries(DIMENSIONS.map((d) => [d.id, 0])),
  ...over,
});

const today = (over: Record<string, number> = {}): MarketFingerprint => ({
  symbol: "NVDA",
  date: "2026-08-14",
  version: FINGERPRINT_VERSION,
  values: values(over),
});

/** Builds the columnar on-disk shape from readable test input. */
const library = (
  rows: Array<{ symbol: string; date: string; v?: Record<string, number>; ret?: number }>,
  over: Partial<FingerprintLibrary> = {}
): FingerprintLibrary => {
  const symbols = [...new Set(rows.map((r) => r.symbol))].sort();
  const dimensions = DIMENSIONS.map((d) => d.id);
  return {
    version: FINGERPRINT_VERSION,
    horizonSessions: 20,
    strideSessions: 10,
    baselineReturnPct: 0.5,
    instruments: symbols.length,
    symbols,
    dimensions,
    moments: {},
    rows: rows.map((r) => {
      const v = values(r.v);
      return [
        symbols.indexOf(r.symbol),
        r.date,
        dimensions.map((d) => v[d] ?? null),
        r.ret ?? 3,
        -2,
        6,
      ] as [number, string, Array<number | null>, number, number, number];
    }),
    notes: [],
    ...over,
  };
};

describe("lookupNeighbourhood", () => {
  /*
   * A library built under a different definition carries different
   * dimensions. `fingerprintDistance` already refuses per pair, but failing
   * here means the page can say WHY rather than reporting "no similar
   * environments found" — which would look like a market fact rather than a
   * stale artefact.
   */
  it("refuses a library built under a different definition", () => {
    const stale = library([{ symbol: "A", date: "2015-01-01" }], { version: FINGERPRINT_VERSION + 1 });
    expect(lookupNeighbourhood(today(), stale)).toBeNull();
  });

  it("returns null rather than an empty shell when nothing is close enough", () => {
    const far = library([{ symbol: "A", date: "2015-01-01", v: { trend: 4, volatility: -4, breadth: 4 } }]);
    expect(lookupNeighbourhood(today(), far)).toBeNull();
  });

  it("finds genuinely similar environments and reports what they did", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`,
      date: `20${String(10 + i).padStart(2, "0")}-06-01`,
      v: { trend: 0.05 },
      ret: 7,
    }));
    const s = lookupNeighbourhood(today(), library(rows))!;
    expect(s.matches).toBe(12);
    expect(s.medianReturnPct).toBeCloseTo(7, 5);
    expect(s.edgeVsBaselinePct).toBeCloseTo(6.5, 5);
  });

  /*
   * The library is sampled from the same panel the reader is looking at, so
   * the instrument's own recent past is in there. Matching against it would
   * be the page telling itself what it already believes.
   */
  it("never matches the instrument against its own immediate past", () => {
    const rows = [
      { symbol: "NVDA", date: "2026-08-10", v: { trend: 0 } },
      { symbol: "AMD", date: "2013-04-02", v: { trend: 0 } },
    ];
    const s = lookupNeighbourhood(today(), library(rows))!;
    expect(s.matches).toBe(1);
    expect(s.instruments).toBe(1);
  });

  /*
   * The number this whole phase exists to replace. Sampled from a real
   * panel, the nearest matches cluster into a handful of weeks across many
   * correlated names — and reporting the raw count is how "71,585 times
   * seen" happened.
   */
  it("charges for correlation instead of reporting the raw count", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      symbol: `S${i}`,
      date: "2020-03-16",
      v: { trend: 0.01 },
      ret: 8,
    }));
    const s = lookupNeighbourhood(today(), library(rows))!;
    expect(s.matches).toBe(30);
    expect(s.effectiveN).toBeLessThan(3);
    expect(s.summary).toContain("too thin to quote a probability");
  });

  it("carries the library's own baseline rather than assuming zero", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`,
      date: `20${String(10 + i).padStart(2, "0")}-06-01`,
      ret: 4,
    }));
    const s = lookupNeighbourhood(today(), library(rows, { baselineReturnPct: 4 }))!;
    expect(s.baselineReturnPct).toBe(4);
    expect(s.summary).toContain("did not, historically, change the odds");
  });
});
