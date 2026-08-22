import { describe, expect, it } from "vitest";
import { CandidateInput, compareCostToExpress } from "./costToExpress";

/**
 * Hand-computed on the real quotes that motivated this module:
 *   BTDR 2026-08-28 10.50C   1.05 / 1.45, delta 0.724, spot 11.37
 *   STX/USD spot             0.2212 / 0.2214
 */
const option: CandidateInput = {
  kind: "option",
  label: "BTDR 10.50C",
  quote: { bid: 1.05, ask: 1.45 },
  delta: 0.724,
  multiplier: 100,
  underlyingPrice: 11.37,
};
const spot: CandidateInput = {
  kind: "spot",
  label: "STX/USD spot",
  venue: "kraken",
  quote: { bid: 0.2212, ask: 0.2214 },
};

describe("compareCostToExpress — one axis across instruments", () => {
  it("converts a premium spread into the underlying move that pays for it", () => {
    const { candidates } = compareCostToExpress([option]);
    const o = candidates[0];
    // (1.45 - 1.05) / (0.724 x 11.37) = 4.86%
    expect(o.breakeven_underlying_move_pct).toBeCloseTo(4.86, 2);
    // The raw premium spread is still reported — honest, just not comparable.
    expect(o.spread_bp_of_own_price).toBeCloseTo(3200, 0);
    // $125 of premium controls 0.724 x 100 x 11.37 = $823 of exposure.
    expect(o.exposure_per_dollar).toBeCloseTo(6.59, 2);
    expect(o.downside_capped).toBe(true);
  });

  it("prices spot on the same axis, where the two are directly comparable", () => {
    const { candidates } = compareCostToExpress([spot]);
    expect(candidates[0].breakeven_underlying_move_pct).toBeCloseTo(0.09, 2);
    expect(candidates[0].exposure_per_dollar).toBe(1);
    expect(candidates[0].downside_capped).toBe(false);
  });

  /*
   * THE POINT OF THE MODULE. Ranking by raw spread says 354x and charges a
   * levered instrument's cost against an unlevered notional — the same
   * category error that once understated this book's exposure 140x.
   */
  it("reports the honest ratio, not the raw-spread one", () => {
    const c = compareCostToExpress([option, spot]);
    expect(c.cheapest).toBe("STX/USD spot");
    expect(c.spread_of_spreads).toBeCloseTo(53.8, 0);
    expect(c.spread_of_spreads!).toBeLessThan(100); // never the 354x figure
  });

  it("refuses to call the cheapest one best, and says why", () => {
    const c = compareCostToExpress([option, spot]);
    expect(c.interpretation).toContain("CHEAPEST IS NOT BEST");
    expect(c.interpretation).toContain("6.586x");
    expect(c.interpretation).toContain("Rule 63");
  });

  it("prefers measured spread history over a live equity snapshot, and says which", () => {
    const c = compareCostToExpress([
      { kind: "equity", label: "BTDR equity", measuredRoundTripBp: 52.3, quote: { bid: 11.3, ask: 11.4 } },
    ]);
    // 52.3bp round trip = 0.523% of underlying move.
    expect(c.candidates[0].breakeven_underlying_move_pct).toBeCloseTo(0.523, 3);
    expect(c.candidates[0].source).toContain("measured spread history");
  });

  it("falls back to a quote only when no history exists, and labels the fallback", () => {
    const c = compareCostToExpress([
      { kind: "equity", label: "PURR equity", measuredRoundTripBp: null, quote: { bid: 9.9, ask: 10.1 } },
    ]);
    expect(c.candidates[0].breakeven_underlying_move_pct).toBeCloseTo(2.0, 2);
    expect(c.candidates[0].source).toContain("one snapshot");
  });

  it("refuses an unpriceable candidate by name rather than modelling a spread", () => {
    const c = compareCostToExpress([
      { kind: "equity", label: "NOHIST", measuredRoundTripBp: null, quote: null },
    ]);
    expect(c.candidates[0].breakeven_underlying_move_pct).toBeNull();
    expect(c.candidates[0].refused).toContain("Corwin-Schultz");
    expect(c.cheapest).toBeNull();
  });

  it("refuses an option missing the delta that makes it comparable", () => {
    const c = compareCostToExpress([{ ...option, delta: 0 }]);
    expect(c.candidates[0].refused).toContain("delta");
    expect(c.candidates[0].breakeven_underlying_move_pct).toBeNull();
  });

  it("refuses a one-sided book instead of halving a missing side", () => {
    const c = compareCostToExpress([{ kind: "spot", label: "X", venue: "kraken", quote: null }]);
    expect(c.candidates[0].refused).toContain("not a spread");
  });

  it("prices a put through |delta|, since direction is not cost", () => {
    const c = compareCostToExpress([{ ...option, label: "put", delta: -0.724 }]);
    expect(c.candidates[0].breakeven_underlying_move_pct).toBeCloseTo(4.86, 2);
  });
});
