import { describe, expect, it } from "vitest";
import {
  CONSTANT_MATURITY_DAYS,
  IvPoint,
  MIN_IV_HISTORY,
  constantMaturityIv,
  ivAtDte,
  ivRichness,
} from "./ivTermStructure";

const ok = <T extends { ok: boolean }>(r: T) => (r.ok ? (r as Extract<T, { ok: true }>) : null);
const bad = <T extends { ok: boolean }>(r: T) => (!r.ok ? (r as Extract<T, { ok: false }>) : null);

const curve: IvPoint[] = [
  { dte: 3, ivPct: 120 },
  { dte: 24, ivPct: 80 },
];

describe("ivAtDte", () => {
  it("returns a quoted expiry untouched", () => {
    const r = ok(ivAtDte(curve, 24))!;
    expect(r.ivPct).toBe(80);
    expect(r.method).toBe("exact");
  });

  /*
   * HAND-COMPUTED, and the reason this module exists.
   *
   * Total variance is additive in time; IV is not. At 3 DTE, sigma=1.2 gives
   * v = 1.44 * 3/365 = 0.0118356. At 24 DTE, sigma=0.8 gives
   * v = 0.64 * 24/365 = 0.0420822. Interpolating to 14 DTE:
   *   w = (14-3)/(24-3) = 11/21 = 0.5238095
   *   v = 0.0118356 + 0.5238095 * (0.0420822 - 0.0118356) = 0.0276803
   *   sigma = sqrt(0.0276803 / (14/365)) = sqrt(0.7216...) = 0.84949
   * so ~84.95%.
   *
   * Linear-in-IV would have said 120 + 0.5238*(80-120) = 99.05% — over
   * FOURTEEN vol points higher. That gap is the defect this convention
   * avoids, and it is widest exactly where the curve is steep.
   */
  it("interpolates in total variance, not in IV", () => {
    const r = ok(ivAtDte(curve, 14))!;
    expect(r.ivPct).toBeCloseTo(84.95, 1);
    expect(r.method).toBe("interpolated");
    expect(r.fromDte).toBe(3);
    expect(r.toDte).toBe(24);

    const naiveLinearInIv = 120 + ((14 - 3) / (24 - 3)) * (80 - 120);
    expect(naiveLinearInIv).toBeCloseTo(99.05, 1);
    expect(Math.abs(r.ivPct - naiveLinearInIv)).toBeGreaterThan(10);
  });

  /* A flat curve must interpolate flat, whichever space the maths uses. */
  it("returns the same vol everywhere on a flat curve", () => {
    const flat: IvPoint[] = [
      { dte: 5, ivPct: 45 },
      { dte: 40, ivPct: 45 },
    ];
    expect(ok(ivAtDte(flat, 30))!.ivPct).toBeCloseTo(45, 6);
  });

  /*
   * THE REFUSAL. Past the listed expiries the curve's shape is unknown, and
   * a vol produced by extending a two-point line would look exactly like a
   * quoted one to any consumer.
   */
  it("refuses to extrapolate beyond the quoted range, and says what is supported", () => {
    const past = bad(ivAtDte(curve, 60))!;
    expect(past.reason).toContain("outside the quoted range (3-24 DTE)");
    expect(past.reason).toContain("Refusing to extrapolate");

    const before = bad(ivAtDte(curve, 1))!;
    expect(before.reason).toContain("outside the quoted range");
  });

  it("refuses nonsense inputs rather than returning a number", () => {
    expect(bad(ivAtDte([], 30))!.reason).toContain("no usable implied-vol quotes");
    expect(bad(ivAtDte(curve, 0))!.reason).toContain("positive number");
    // Zero and negative vols are not quotes; they must not become the curve.
    expect(bad(ivAtDte([{ dte: 10, ivPct: 0 }], 10))!.reason).toContain("no usable");
  });

  it("holds the declared constant maturity", () => {
    // Bracketing the declared maturity, as the live chain does (7d and 21d).
    const wide: IvPoint[] = [
      { dte: 7, ivPct: 100 },
      { dte: 45, ivPct: 70 },
    ];
    const r = ok(constantMaturityIv(wide))!;
    expect(CONSTANT_MATURITY_DAYS).toBe(21);
    // Between the two quotes, and below the near-tenor vol on a downward curve.
    expect(r.ivPct).toBeLessThan(100);
    expect(r.ivPct).toBeGreaterThan(70);
  });
});

describe("ivRichness", () => {
  const history = (n: number, from = 20, to = 80) =>
    Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

  it("ranks a reading against its own history and says which side it argues for", () => {
    const r = ok(ivRichness(78, history(40)))!;
    expect(r.percentile).toBeGreaterThan(80);
    expect(r.n).toBe(40);
    expect(r.maturityDays).toBe(CONSTANT_MATURITY_DAYS);
    expect(r.sentence).toContain("favours selling premium");
  });

  it("calls a low reading cheap and points the other way", () => {
    const r = ok(ivRichness(22, history(40)))!;
    expect(r.percentile).toBeLessThan(20);
    expect(r.sentence).toContain("favours buying premium");
  });

  it("refuses to draw a side from a middling reading", () => {
    const r = ok(ivRichness(50, history(40)))!;
    expect(r.sentence).toContain("unremarkable");
    expect(r.sentence).toContain("neither the reason to take the trade");
  });

  /*
   * A rank over a handful of sessions is arithmetic wearing the costume of
   * evidence — at n=5 every reading lands in one of six buckets.
   */
  it("withholds a percentile until the history can support one", () => {
    const r = bad(ivRichness(50, history(MIN_IV_HISTORY - 1)))!;
    expect(r.reason).toContain(`${MIN_IV_HISTORY - 1} of the ${MIN_IV_HISTORY} sessions`);
    expect(r.reason).toContain("constant maturity");
  });

  /* Zero-variance history: the mid-rank convention reads 50, not 0 or 100. */
  it("reads the middle when every past session was identical", () => {
    const r = ok(ivRichness(40, Array(40).fill(40)))!;
    expect(r.percentile).toBe(50);
  });

  it("has nothing to rank without a current reading", () => {
    expect(bad(ivRichness(0, history(40)))!.reason).toContain("no current implied vol");
  });

  /* The tenor travels with the claim — a percentile without it is unitless. */
  it("names the maturity in its own sentence", () => {
    const r = ok(ivRichness(78, history(40)))!;
    expect(r.sentence).toContain(`${CONSTANT_MATURITY_DAYS}-day constant maturity`);
  });
});

/*
 * Both branches must hand back the same SHAPE of number. Unrounded, the
 * exact-match path surfaced 101.55000000000001 from a live chain while the
 * interpolated path gave 109.32 — one field, two formats, depending on
 * whether an expiry happened to land on the requested tenor.
 */
describe("output shape", () => {
  it("rounds to two decimals on the exact path as well as the interpolated one", () => {
    const exact = ok(ivAtDte([{ dte: 21, ivPct: 101.55000000000001 }], 21))!;
    expect(exact.ivPct).toBe(101.55);
    const interp = ok(ivAtDte(curve, 14))!;
    expect(Number.isInteger(interp.ivPct * 100)).toBe(true);
  });
});
