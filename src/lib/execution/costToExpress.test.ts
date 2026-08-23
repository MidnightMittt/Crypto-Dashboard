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
  thetaPerDay: -0.0207,
  carryDays: 5,
};
const spot: CandidateInput = {
  kind: "spot",
  label: "STX/USD spot",
  venue: "kraken",
  quote: { bid: 0.2212, ask: 0.2214 },
  distribution: null,
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
    // Execution alone: 4.86 / 0.0904 = 53.8x — the module's founding claim,
    // still true, and now the smaller half of the story.
    const [o, s] = c.candidates;
    expect(o.breakeven_underlying_move_pct! / s.breakeven_underlying_move_pct!).toBeCloseTo(53.8, 0);
    expect(o.breakeven_underlying_move_pct! / s.breakeven_underlying_move_pct!).toBeLessThan(100); // never the 354x figure
    // Ranked all-in, five days of decay make it dearer still.
    expect(c.spread_of_spreads!).toBeGreaterThan(53.8);
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
    const c = compareCostToExpress([{ kind: "spot", label: "X", venue: "kraken", quote: null, distribution: null }]);
    expect(c.candidates[0].refused).toContain("not a spread");
  });

  it("prices a put through |delta|, since direction is not cost", () => {
    const c = compareCostToExpress([{ ...option, label: "put", delta: -0.724 }]);
    expect(c.candidates[0].breakeven_underlying_move_pct).toBeCloseTo(4.86, 2);
  });
});

/**
 * CARRY — the cost that decides a dated trade, and that this endpoint used
 * to omit in silence.
 *
 * The fixture is the real decision of 2026-08-24: MARA shares against the
 * Sep-18 $12 call, quoted 0.83/0.86, delta 0.456, spot 11.26, theta 0.0207
 * over 26 calendar days. Execution on that call is 355bp — 3% of premium —
 * and decay over the contract's life is 64% of it. Printing the first
 * without the second told the reader the option was cheap to hold.
 */
const maraCall: CandidateInput = {
  kind: "option",
  label: "MARA 2026-09-18 12C",
  quote: { bid: 0.83, ask: 0.86 },
  delta: 0.456,
  multiplier: 100,
  underlyingPrice: 11.26,
  thetaPerDay: -0.0207,
  carryDays: 26,
};
const maraShares: CandidateInput = {
  kind: "equity",
  label: "MARA equity",
  measuredRoundTripBp: 27.83,
  quote: null,
};

describe("carry — decay priced on the same axis as execution", () => {
  it("converts theta into the underlying move that offsets it", () => {
    const [o] = compareCostToExpress([maraCall]).candidates;
    // 0.0207 x 26 = 0.5382 of premium; / (0.456 x 11.26) = 10.48% of underlying.
    expect(o.carry!.days).toBe(26);
    expect(o.carry!.total_premium).toBeCloseTo(0.5382, 4);
    expect(o.carry!.pct_of_premium).toBeCloseTo(63.7, 1);
    expect(o.carry!.move_pct).toBeCloseTo(10.4819, 3);
  });

  /*
   * The three lines stay separate — one is paid on entry, one for holding,
   * and a single figure would hide which — but the TOTAL is what the
   * decision runs on, so it is computed and it is what the ranking uses.
   */
  it("keeps execution and carry separate AND reports their sum", () => {
    const [o] = compareCostToExpress([maraCall]).candidates;
    expect(o.breakeven_underlying_move_pct).toBeCloseTo(0.5843, 4); // entry, once
    expect(o.carry!.move_pct).toBeCloseTo(10.4819, 3); // holding, 26 days
    expect(o.breakeven_move_pct_all_in).toBeCloseTo(11.0662, 3); // what must happen
  });

  /*
   * THE BUG THIS FIXES. On execution alone the call reads 2.1x dearer than
   * the shares, and a reader carries away "about twice". All-in it is ~40x.
   * The endpoint was never wrong; the number it led with was the wrong one.
   */
  it("ranks all-in, which changes the answer from 2.1x to ~40x", () => {
    const c = compareCostToExpress([maraShares, maraCall]);
    const [eq, call] = c.candidates;
    const executionOnlyRatio =
      call.breakeven_underlying_move_pct! / eq.breakeven_underlying_move_pct!;
    expect(executionOnlyRatio).toBeCloseTo(2.1, 1);
    expect(c.cheapest).toBe("MARA equity");
    expect(c.spread_of_spreads).toBeCloseTo(39.8, 0);
    expect(c.interpretation).toContain("decay over 26 days of holding");
  });

  it("never calls decay a loss, because theta buys the convexity", () => {
    const c = compareCostToExpress([maraShares, maraCall]);
    expect(c.interpretation).toContain("NOT a loss already taken");
    expect(c.candidates[1].carry!.basis).toContain("price of the convexity");
    expect(c.candidates[1].carry!.basis).toContain("ACCELERATES");
  });

  /*
   * Option (b) from the brief, kept as the fallback for option (a): a
   * stated exclusion beats a silent one. Crucially it is also held OUT of
   * the ranking — admitting it at its execution-only figure is exactly how
   * the flattering number would reach the page.
   */
  it("states the exclusion by name when theta is missing, and refuses to rank it", () => {
    const c = compareCostToExpress([maraShares, { ...maraCall, thetaPerDay: null }]);
    const call = c.candidates[1];
    expect(call.breakeven_underlying_move_pct).toBeCloseTo(0.5843, 4); // still priced
    expect(call.carry).toBeNull();
    expect(call.carry_excluded).toContain("26 days of decay, not priced here");
    expect(call.breakeven_move_pct_all_in).toBeNull();
    expect(c.cheapest).toBe("MARA equity");
    expect(c.spread_of_spreads).toBeNull(); // one ranked candidate is not a comparison
    expect(c.interpretation).toContain("NOT RANKED: MARA 2026-09-18 12C");
  });

  it("asks for a horizon when theta arrives without one", () => {
    const [o] = compareCostToExpress([{ ...maraCall, carryDays: null }]).candidates;
    expect(o.carry_excluded).toContain("decay without a horizon is not a quantity");
  });

  /*
   * Linear theta extrapolates past the whole premium near expiry. Value
   * cannot decay below zero, so the figure is capped and the basis says the
   * cap bound — a silently clipped number would read as a measurement.
   */
  it("caps decay at the premium and admits the cap in the basis", () => {
    const [o] = compareCostToExpress([{ ...maraCall, thetaPerDay: -0.5 }]).candidates;
    expect(o.carry!.total_premium).toBeCloseTo(0.845, 3); // the mid, not 13.00
    expect(o.carry!.pct_of_premium).toBeCloseTo(100, 1);
    expect(o.carry!.basis).toContain("capped at the 0.84 premium");
  });

  /*
   * An undated instrument has no decay, and "not priced" about a cost that
   * does not exist is the same false alarm pointing the other way.
   */
  it("gives an undated instrument no carry and no exclusion note", () => {
    const [eq] = compareCostToExpress([maraShares]).candidates;
    expect(eq.carry).toBeNull();
    expect(eq.carry_excluded).toBeNull();
    expect(eq.breakeven_move_pct_all_in).toBe(eq.breakeven_underlying_move_pct);
  });

  it("says nothing about carry on an option it already refused for a missing delta", () => {
    const [o] = compareCostToExpress([{ ...maraCall, delta: 0 }]).candidates;
    expect(o.refused).toContain("delta");
    expect(o.carry).toBeNull();
    expect(o.carry_excluded).toBeNull();
  });
});
