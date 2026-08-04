import { describe, expect, it } from "vitest";
import { benjaminiHochberg } from "./multipleTesting";

describe("benjaminiHochberg", () => {
  /**
   * Hand-worked reference case, computed before writing the assertions:
   * p-values [0.01, 0.04, 0.03, 0.005, 0.20], m=5, q=0.05.
   * Sorted ascending: 0.005(rank1), 0.01(rank2), 0.03(rank3), 0.04(rank4), 0.20(rank5).
   * BH thresholds: rank1: (1/5)*0.05=0.01; rank2: (2/5)*0.05=0.02;
   *                rank3: (3/5)*0.05=0.03; rank4: (4/5)*0.05=0.04; rank5: 0.05.
   * Compare: 0.005<=0.01 yes; 0.01<=0.02 yes; 0.03<=0.03 yes (tie counts);
   *          0.04<=0.04 yes (tie counts); 0.20<=0.05 NO.
   * Largest passing rank = 4, so ranks 1-4 are significant, rank 5 is not —
   * i.e. every original p-value except 0.20 is significant.
   */
  it("matches a hand-worked 5-p-value example", () => {
    const pValues = [0.01, 0.04, 0.03, 0.005, 0.20];
    const results = benjaminiHochberg(pValues);

    expect(results[0]).toMatchObject({ pValue: 0.01, rank: 2, significant: true });
    expect(results[1]).toMatchObject({ pValue: 0.04, rank: 4, significant: true });
    expect(results[2]).toMatchObject({ pValue: 0.03, rank: 3, significant: true });
    expect(results[3]).toMatchObject({ pValue: 0.005, rank: 1, significant: true });
    expect(results[4]).toMatchObject({ pValue: 0.2, rank: 5, significant: false });
  });

  it("flags nothing significant when every p-value is large", () => {
    const results = benjaminiHochberg([0.5, 0.6, 0.7, 0.9]);
    expect(results.every((r) => !r.significant)).toBe(true);
  });

  it("flags everything significant when every p-value is tiny", () => {
    const results = benjaminiHochberg([0.0001, 0.0002, 0.0003]);
    expect(results.every((r) => r.significant)).toBe(true);
  });

  it("reduces to the raw threshold at m=1 (BH with one test is just p <= q)", () => {
    expect(benjaminiHochberg([0.04])[0].significant).toBe(true);
    expect(benjaminiHochberg([0.06])[0].significant).toBe(false);
  });

  it("handles an empty input", () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });

  it("assigns ranks matching sorted order, not input order", () => {
    const results = benjaminiHochberg([0.3, 0.01, 0.2]);
    expect(results[1].rank).toBe(1); // 0.01 is smallest
    expect(results[2].rank).toBe(2); // 0.2 is middle
    expect(results[0].rank).toBe(3); // 0.3 is largest
  });
});
