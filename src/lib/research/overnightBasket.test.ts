import { describe, expect, it } from "vitest";
import {
  BasketObservation,
  dailyBasketSeries,
  detectableEffectBp,
  testBasket,
} from "./overnightBasket";

const day = (n: number) => `2026-0${Math.floor(n / 28) + 1}-${String((n % 28) + 1).padStart(2, "0")}`;

/** Perfectly correlated names: every name gets the same shock each date. */
const correlated = (dates: number, names: number, shocks: number[]): BasketObservation[] => {
  const out: BasketObservation[] = [];
  for (let d = 0; d < dates; d++) {
    for (let s = 0; s < names; s++) {
      out.push({ date: day(d), symbol: `S${s}`, netBp: shocks[d % shocks.length] });
    }
  }
  return out;
};

describe("dailyBasketSeries", () => {
  it("averages across the names priced on each date", () => {
    const series = dailyBasketSeries([
      { date: "2026-08-12", symbol: "A", netBp: 10 },
      { date: "2026-08-12", symbol: "B", netBp: 30 },
      { date: "2026-08-13", symbol: "A", netBp: -5 },
    ]);
    expect(series).toEqual([
      { date: "2026-08-12", meanBp: 20, names: 2 },
      { date: "2026-08-13", meanBp: -5, names: 1 },
    ]);
  });

  it("returns dates in order, so the series is a time series", () => {
    const series = dailyBasketSeries([
      { date: "2026-08-14", symbol: "A", netBp: 1 },
      { date: "2026-08-12", symbol: "A", netBp: 2 },
    ]);
    expect(series.map((d) => d.date)).toEqual(["2026-08-12", "2026-08-14"]);
  });
});

describe("detectableEffectBp — the power line", () => {
  /*
   * The number that stops a null being read as evidence of absence. APLD's
   * best row is 51.0bp net at t=2.17, implying SE near 23.5bp — so t=3 would
   * have required roughly 70bp. An effect of 40bp could be entirely real and
   * this test could never have called it.
   */
  it("reproduces the worked example from the review", () => {
    const se = 51.0 / 2.17;
    const sd = se * Math.sqrt(120);
    expect(detectableEffectBp(sd, 120)).toBeCloseTo(3 * se, 6);
    expect(detectableEffectBp(sd, 120)!).toBeCloseTo(70.5, 0);
  });

  it("falls as the sample grows, at the square root", () => {
    const a = detectableEffectBp(100, 100)!;
    const b = detectableEffectBp(100, 400)!;
    expect(a / b).toBeCloseTo(2, 6);
  });

  it("refuses rather than dividing by nothing", () => {
    expect(detectableEffectBp(0, 100)).toBeNull();
    expect(detectableEffectBp(100, 1)).toBeNull();
  });
});

describe("testBasket — clustering versus pooling", () => {
  /*
   * THE WHOLE POINT. Twelve names that move together are one trade wearing
   * twelve tickers. Pooling name-days multiplies the apparent sample by the
   * number of names without adding any information, and t rises by roughly
   * its square root. With PERFECTLY correlated names the daily mean is the
   * shock itself, so the clustered t is the truth and the pooled t is pure
   * inflation — here by sqrt(12) = 3.46.
   */
  it("catches the inflation that pooling correlated names produces", () => {
    const shocks = [40, -10, 25, 5, -20, 60, 15, -5, 30, 10];
    const r = testBasket("all", 120, correlated(40, 12, shocks));

    expect(r.dates).toBe(40);
    expect(r.nameDays).toBe(480);
    expect(r.meanNamesPerDate).toBe(12);

    // Same mean either way — pooling does not bias the effect, only its error.
    expect(r.pooled!.meanBp).toBeCloseTo(r.clustered!.meanBp, 8);
    /*
     * sqrt(12) = 3.464 is the asymptotic answer; the measured 3.505 is that
     * times sqrt((479 x 40) / (480 x 39)) = 1.0117, which is the Bessel
     * correction acting on two different sample sizes. The excess is real
     * arithmetic, not slack in the test.
     */
    expect(r.inflationRatio!).toBeCloseTo(Math.sqrt(12) * Math.sqrt((479 * 40) / (480 * 39)), 6);
    expect(r.inflationRatio!).toBeCloseTo(3.505, 2);
    expect(Math.abs(r.pooled!.tStat)).toBeGreaterThan(Math.abs(r.clustered!.tStat));
  });

  /*
   * The honest opposite case: names that are genuinely independent lose much
   * less to clustering, because averaging them cancels idiosyncratic noise
   * and the daily series is genuinely tighter. The correction is not a flat
   * penalty — it is a measurement.
   */
  it("costs little when the names really are independent", () => {
    const out: BasketObservation[] = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 200;
    for (let d = 0; d < 60; d++) {
      for (let s = 0; s < 8; s++) out.push({ date: day(d), symbol: `S${s}`, netBp: 20 + rand() });
    }
    const r = testBasket("independent", 120, out);
    // Nothing like sqrt(8) = 2.83; averaging genuinely helps here.
    expect(r.inflationRatio!).toBeLessThan(1.6);
  });

  it("reports the members so a row can be checked", () => {
    const r = testBasket("pair", 120, [
      { date: "2026-08-12", symbol: "B", netBp: 1 },
      { date: "2026-08-12", symbol: "A", netBp: 2 },
    ]);
    expect(r.symbols).toEqual(["A", "B"]);
  });

  /* An undefined ratio is not a large one. */
  it("returns a null inflation ratio rather than dividing by a zero t", () => {
    const flat = Array.from({ length: 30 }, (_, d) => ({
      date: day(d),
      symbol: "A",
      netBp: 0,
    }));
    expect(testBasket("flat", 120, flat).inflationRatio).toBeNull();
  });

  it("survives an empty basket without inventing statistics", () => {
    const r = testBasket("none", 120, []);
    expect(r.dates).toBe(0);
    expect(r.clustered).toBeNull();
    expect(r.detectableAtT3Bp).toBeNull();
    expect(r.meanNamesPerDate).toBeNull();
  });
});
