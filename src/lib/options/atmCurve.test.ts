import { describe, expect, it } from "vitest";
import { ChainRow, atmCurve } from "./atmCurve";

const NOW = Date.UTC(2026, 7, 21);
/** `d` days out from NOW, as an expiry date string. */
const out = (d: number) => new Date(NOW + d * 86_400_000).toISOString().slice(0, 10);

const row = (expiry: string, strike: number, iv: number): ChainRow => ({ expiry, strike, iv });

describe("atmCurve", () => {
  it("returns one point per expiry, oldest first, in percent", () => {
    const rows = [
      row(out(21), 100, 0.8),
      row(out(7), 100, 1.1),
    ];
    const c = atmCurve(rows, 100, NOW);
    expect(c.map((p) => p.dte)).toEqual([7, 21]);
    expect(c[0].ivPct).toBeCloseTo(110, 6);
    expect(c[1].ivPct).toBeCloseTo(80, 6);
  });

  /* Averaging the band smooths call/put asymmetry without a skew model. */
  it("averages every usable strike inside the band", () => {
    const rows = [row(out(7), 98, 1.0), row(out(7), 100, 1.2), row(out(7), 102, 1.4)];
    expect(atmCurve(rows, 100, NOW)[0].ivPct).toBeCloseTo(120, 6);
  });

  /* 5% band, matching the CBOE provider so the series and the page agree. */
  it("excludes strikes outside the 5% band", () => {
    const rows = [row(out(7), 100, 1.0), row(out(7), 130, 9.0)];
    // The far strike would drag a mean from 100% to 500% if admitted.
    expect(atmCurve(rows, 100, NOW)[0].ivPct).toBeCloseTo(100, 6);
  });

  /*
   * Expiry-day vol is pinning and gamma, not a view on the future. Letting it
   * anchor the near end would drag every interpolation toward it.
   */
  it("drops the 0DTE expiry", () => {
    const rows = [row(out(0), 100, 3.0), row(out(7), 100, 1.0)];
    const c = atmCurve(rows, 100, NOW);
    expect(c).toHaveLength(1);
    expect(c[0].dte).toBe(7);
  });

  it("ignores rows with no usable quote rather than treating zero as a vol", () => {
    const rows = [row(out(7), 100, 0), row(out(7), 101, 1.0)];
    expect(atmCurve(rows, 100, NOW)[0].ivPct).toBeCloseTo(100, 6);
  });

  /*
   * An expiry with nothing inside the band is OMITTED, not filled. A missing
   * rung is a real gap, and ivAtDte refuses to interpolate across a range it
   * cannot see rather than inventing the shape.
   */
  it("omits an expiry with no quote inside the band", () => {
    const rows = [row(out(7), 100, 1.0), row(out(21), 140, 0.9)];
    expect(atmCurve(rows, 100, NOW).map((p) => p.dte)).toEqual([7]);
  });

  it("returns nothing without a usable spot", () => {
    expect(atmCurve([row(out(7), 100, 1)], 0, NOW)).toEqual([]);
    expect(atmCurve([row(out(7), 100, 1)], Number.NaN, NOW)).toEqual([]);
  });

  /*
   * THE UNIT IS DECLARED, NOT INFERRED. A magnitude guess once reported 3%
   * for a stock implying 335%, in the direction that makes options look free.
   */
  it("scales a high decimal vol correctly rather than guessing it was already percent", () => {
    expect(atmCurve([row(out(7), 100, 3.345)], 100, NOW)[0].ivPct).toBeCloseTo(334.5, 6);
  });
});
