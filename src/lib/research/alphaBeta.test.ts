import { describe, expect, it } from "vitest";
import { alignOnDate, regress, regressOnMarket } from "./alphaBeta";

/**
 * The worked example is hand-computed so the implementation is checked
 * against arithmetic rather than against itself:
 *
 *   x = [-2,-1,0,1,2]   y = [0,2,3,4,6]
 *   xbar 0, ybar 3, Sxx 10, Sxy 14
 *   beta  = 14/10 = 1.4
 *   alpha = 3 - 1.4*0 = 3
 *   residuals [-0.2, 0.4, 0, -0.4, 0.2] -> SSE 0.4, s2 = 0.4/3
 *   SE(beta)  = sqrt(s2/10)       = 0.115470
 *   SE(alpha) = sqrt(s2 * 1/5)    = 0.163299
 *   SST 20 -> R2 = 1 - 0.4/20 = 0.98
 */
describe("regress — checked against hand arithmetic", () => {
  const x = [-2, -1, 0, 1, 2];
  const y = [0, 2, 3, 4, 6];

  it("recovers the slope and intercept", () => {
    const r = regress(y, x)!;
    expect(r.beta).toBeCloseTo(1.4, 10);
    expect(r.alphaBp).toBeCloseTo(3, 10);
    expect(r.n).toBe(5);
  });

  it("recovers the standard errors and R-squared", () => {
    const r = regress(y, x)!;
    expect(r.alphaSeBp).toBeCloseTo(0.163299, 6);
    expect(r.betaSeBp).toBeCloseTo(0.11547, 5);
    expect(r.rSquared).toBeCloseTo(0.98, 10);
    expect(r.alphaT).toBeCloseTo(3 / 0.163299, 4);
  });

  /* The power line, on the same footing as every other test here. */
  it("reports the minimum alpha it could have detected at t=3", () => {
    const r = regress(y, x)!;
    expect(r.detectableAlphaAtT3Bp).toBeCloseTo(3 * r.alphaSeBp, 10);
  });

  /*
   * A perfect fit has zero residual variance and an infinite t. It cannot
   * happen with returns, but an Infinity sorted to the top of an alpha
   * ranking would be the loudest false positive available.
   */
  it("refuses a perfect fit rather than returning an infinite t", () => {
    expect(regress([1, 2, 3, 4], [1, 2, 3, 4])).toBeNull();
  });

  /*
   * With no dispersion in the market series the slope is unidentifiable.
   * Reporting beta 0 and handing the whole mean to alpha would credit the
   * name with an alpha that is really a failed regression.
   */
  it("refuses when the market series never moves", () => {
    expect(regress([1, 2, 3, 4, 5], [7, 7, 7, 7, 7])).toBeNull();
  });

  it("refuses a sample too small to estimate two parameters and an error", () => {
    expect(regress([1, 2], [1, 2])).toBeNull();
  });

  /*
   * THE CASE THIS MODULE EXISTS FOR. A name that is purely a levered version
   * of the market has beta above one and alpha of nothing — its whole
   * premium is the market's, multiplied.
   */
  it("finds zero alpha in a name that is only levered market exposure", () => {
    const market = [12, -30, 45, -8, 22, 5, -17, 31, -25, 9, 14, -3];
    const levered = market.map((m) => m * 2.5);
    const r = regress(levered, market)!;
    expect(r.beta).toBeCloseTo(2.5, 8);
    expect(Math.abs(r.alphaBp)).toBeLessThan(1e-8);
  });
});

describe("alignOnDate — an inner join, deliberately", () => {
  it("uses only nights both series priced", () => {
    const a = alignOnDate(
      [
        { date: "2026-08-12", netBp: 10 },
        { date: "2026-08-13", netBp: 20 },
        { date: "2026-08-14", netBp: 30 },
      ],
      [
        { date: "2026-08-12", netBp: 1 },
        { date: "2026-08-14", netBp: 3 },
      ]
    );
    expect(a.dates).toEqual(["2026-08-12", "2026-08-14"]);
    expect(a.y).toEqual([10, 30]);
    expect(a.x).toEqual([1, 3]);
  });

  /*
   * A missing market night is UNKNOWN, not flat. Filling it with zero would
   * assert the market did not move and hand the name's whole move to alpha.
   */
  it("drops an unmatched night rather than treating the market as flat", () => {
    const a = alignOnDate(
      [{ date: "2026-08-12", netBp: 500 }],
      [{ date: "2026-08-13", netBp: 1 }]
    );
    expect(a.y).toHaveLength(0);
  });

  it("sorts by date, so the pairing is a time series", () => {
    const a = alignOnDate(
      [
        { date: "2026-08-14", netBp: 3 },
        { date: "2026-08-12", netBp: 1 },
      ],
      [
        { date: "2026-08-12", netBp: 10 },
        { date: "2026-08-14", netBp: 30 },
      ]
    );
    expect(a.dates).toEqual(["2026-08-12", "2026-08-14"]);
  });

  it("returns null from regressOnMarket when nothing overlaps", () => {
    expect(
      regressOnMarket([{ date: "a", netBp: 1 }], [{ date: "b", netBp: 1 }])
    ).toBeNull();
  });
});
