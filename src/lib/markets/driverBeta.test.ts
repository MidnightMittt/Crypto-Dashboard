import { describe, expect, it } from "vitest";
import { Bar } from "@/lib/research/types";
import { buildDriverRead, describeDriver, fitDriver, MIN_DRIVER_OBSERVATIONS } from "./driverBeta";

const DAY = 86_400_000;
/** 2024-01-01 was a Monday, so index 0 of a weekday series is a Monday. */
const MONDAY = Date.parse("2024-01-01T00:00:00Z");

const bar = (t: number, close: number): Bar => ({
  t,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

/** Weekday-only series (skips Sat/Sun), like a US listing. */
function weekdaySeries(closes: number[], start = MONDAY): Bar[] {
  const bars: Bar[] = [];
  let t = start;
  for (const c of closes) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    bars.push(bar(t, c));
    t += DAY;
  }
  return bars;
}

/** Every-calendar-day series, like BTC. */
function dailySeries(closes: number[], start = MONDAY): Bar[] {
  return closes.map((c, i) => bar(start + i * DAY, c));
}

/**
 * A repeating cycle of VARYING daily returns.
 *
 * Deliberately not a constant rate: constant returns have zero variance, and
 * a correlation over a zero-variance series is undefined — `fitDriver`
 * correctly returns null for it, so a constant-rate fixture would test
 * nothing but the refusal path. The cycle sums to zero, so its mean is
 * exactly zero for any whole number of repetitions, which keeps the
 * hand-computed covariance arithmetic below exact.
 */
const RETURN_CYCLE = [0.1, -0.1, 0.2, -0.2];

function cycleReturns(n: number, scale = 1): number[] {
  return Array.from({ length: n }, (_, i) => RETURN_CYCLE[i % RETURN_CYCLE.length] * scale);
}

/** Closes implied by a return series, starting at 100. */
function closesFrom(returns: number[], start = 100): number[] {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1] * (1 + r));
  return out;
}

/** n+1 closes whose returns are the cycle scaled by `scale`. */
function scaled(n: number, scale: number): number[] {
  return closesFrom(cycleReturns(n, scale));
}

describe("fitDriver", () => {
  it("computes a hand-verified rho and beta", () => {
    /*
     * Worked by hand over one cycle (the pattern repeats, and repetition
     * scales cov, varX and varY by the same factor, so the ratios below hold
     * for any whole number of cycles):
     *
     *   industry y: +10%, -10%, +20%, -20%  (mean 0)
     *   driver   x:  +5%,  -5%, +10%, -10%  (mean 0, y scaled by 1/2)
     *   cov  = .10*.05 + (-.10)(-.05) + .20*.10 + (-.20)(-.10) = .05
     *   varX = .0025 + .0025 + .01 + .01 = .025
     *   varY = .01 + .01 + .04 + .04 = .10
     *   beta = cov / varX  = .05 / .025 = 2
     *   rho  = cov / sqrt(varY * varX) = .05 / .05 = 1
     */
    const n = 48; // 12 whole cycles, comfortably past the minimum sample
    const industry = weekdaySeries(scaled(n, 1));
    const driver = weekdaySeries(scaled(n, 0.5));
    const fit = fitDriver(industry, driver)!;

    expect(fit.n).toBe(n);
    expect(fit.beta).toBeCloseTo(2, 10);
    expect(fit.rho).toBeCloseTo(1, 10);
  });

  it("returns rho -1 for an inverse relationship", () => {
    const industry = weekdaySeries(scaled(48, 1));
    const driver = weekdaySeries(scaled(48, -0.5));
    const fit = fitDriver(industry, driver)!;
    expect(fit.rho).toBeCloseTo(-1, 10);
    expect(fit.beta).toBeCloseTo(-2, 10);
  });

  it("refuses a sample below the minimum rather than printing a confident decimal", () => {
    const short = MIN_DRIVER_OBSERVATIONS - 5;
    const industry = weekdaySeries(scaled(short, 1));
    const driver = weekdaySeries(scaled(short, 0.5));
    expect(fitDriver(industry, driver)).toBeNull();
  });

  it("returns null for a flat series — a constant is neither correlated nor uncorrelated", () => {
    const industry = weekdaySeries(new Array(80).fill(100));
    const driver = weekdaySeries(scaled(79, 0.5));
    expect(fitDriver(industry, driver)).toBeNull();
  });

  it("honours the window: only the most recent N sessions are fitted", () => {
    const industry = weekdaySeries(scaled(200, 1));
    const driver = weekdaySeries(scaled(200, 0.5));
    expect(fitDriver(industry, driver, 50)!.n).toBe(50);
  });
});

describe("weekend alignment — the trap this module exists to avoid", () => {
  /*
   * THE CASE THAT BREAKS A NAIVE JOIN.
   *
   * The driver trades all seven days; the equity trades weekdays. All of the
   * driver's movement here happens over WEEKENDS — every weekday it is flat.
   * A correlation built from the driver's own consecutive bars, or from
   * same-date closes only, sees a driver that never moves on days the equity
   * trades and reports nothing. Spanning Friday→Monday, which is what the
   * equity's Monday return actually covers, recovers the relationship.
   */
  function weekendOnlyDriver(weeks: number): Bar[] {
    const closes: number[] = [];
    let price = 100;
    for (let d = 0; d < weeks * 7; d++) {
      const day = new Date(MONDAY + d * DAY).getUTCDay();
      // Price steps up across Saturday and Sunday only.
      if (day === 6 || day === 0) price *= 1.01;
      closes.push(price);
    }
    return dailySeries(closes);
  }

  it("captures weekend driver moves in the following session's return", () => {
    const weeks = 14;
    const driver = weekendOnlyDriver(weeks);

    // The equity mirrors the weekend move in its Monday return and is flat
    // otherwise — exactly the miner-gap pattern.
    const industryCloses: number[] = [];
    let p = 100;
    for (let d = 0; d < weeks * 7; d++) {
      const day = new Date(MONDAY + d * DAY).getUTCDay();
      if (day === 1) p *= 1.0201; // Monday absorbs both weekend steps.
      if (day !== 0 && day !== 6) industryCloses.push(p);
    }
    const industry = weekdaySeries(industryCloses);

    const fit = fitDriver(industry, driver)!;
    // Both series move only on Mondays, by matching amounts -> near-perfect fit.
    expect(fit.rho).toBeGreaterThan(0.99);
    expect(fit.beta).toBeCloseTo(1, 2);
  });

  it("a same-date-only join would have found nothing — proving the span matters", () => {
    /*
     * Guard against a future refactor quietly reverting to naive alignment.
     * Same-DATE closes of a weekend-only driver are identical Mon..Fri, so
     * its within-week returns are all zero: zero variance, no fit. If this
     * ever stops being null, the alignment has been broken.
     */
    const weeks = 14;
    const driver = weekendOnlyDriver(weeks);
    const weekdayOnlyDriver = driver.filter((b) => ![0, 6].includes(new Date(b.t).getUTCDay()));

    // Re-index the weekday-only driver onto consecutive weekday slots, which
    // is what a naive same-calendar join effectively produces.
    const naive = weekdaySeries(weekdayOnlyDriver.map((b) => b.close));
    const industry = weekdaySeries(scaled(naive.length - 1, 1));

    // Flat within every week -> the driver's own weekday returns are mostly
    // zero and carry none of the weekend information.
    const naiveFit = fitDriver(industry, naive);
    expect(naiveFit === null || Math.abs(naiveFit.rho) < 0.5).toBe(true);
  });

  it("drops a span when the driver is missing an endpoint instead of inventing a flat day", () => {
    const industry = weekdaySeries(scaled(80, 1));
    const full = weekdaySeries(scaled(80, 0.5));
    // Remove 5 driver bars: each missing close invalidates the spans on both
    // sides of it, so the paired count must fall by more than zero.
    const holey = full.filter((_, i) => ![10, 20, 30, 40, 50].includes(i));

    const complete = fitDriver(industry, full)!;
    const gapped = fitDriver(industry, holey)!;
    expect(gapped.n).toBeLessThan(complete.n);
    // The surviving relationship is unchanged — dropped, not fabricated.
    expect(gapped.beta).toBeCloseTo(2, 6);
  });
});

describe("buildDriverRead", () => {
  const industry = weekdaySeries(scaled(150, 1));
  const driverBars = weekdaySeries(scaled(150, 0.5));
  const sectorBars = weekdaySeries(scaled(150, 0.25));
  const driver = { symbol: "BTC", label: "Bitcoin" };

  it("fits driver and sector so the two can be compared", () => {
    const read = buildDriverRead({
      industryBars: industry, driverBars, sectorBars, driver, sectorSymbol: "XLK",
    })!;
    expect(read.driver!.beta).toBeCloseTo(2, 6);
    expect(read.sector!.beta).toBeCloseTo(4, 6);
    expect(read.symbol).toBe("BTC");
  });

  it("keeps a partial read when a series is missing rather than suppressing everything", () => {
    const read = buildDriverRead({
      industryBars: industry, driverBars, sectorBars: null, driver, sectorSymbol: "XLK",
    })!;
    expect(read.driver).not.toBeNull();
    expect(read.sector).toBeNull();
  });

  it("returns null only when the industry itself has no bars", () => {
    expect(
      buildDriverRead({ industryBars: [], driverBars, sectorBars, driver, sectorSymbol: "XLK" })
    ).toBeNull();
  });
});

describe("describeDriver", () => {
  const mk = (rho: number, beta: number, sectorRho: number | null) => ({
    symbol: "BTC",
    label: "Bitcoin",
    driver: { rho, beta, n: 120 },
    sector: sectorRho === null ? null : { rho: sectorRho, beta: 1, n: 120 },
    sectorSymbol: "XLK",
    windowSessions: 126,
  });

  it("names the leverage when the driver dominates", () => {
    const text = describeDriver(mk(0.82, 2.1, 0.35), "AI Datacenter & Mining");
    expect(text).toContain("tracks Bitcoin closely");
    expect(text).toContain("AMPLIFIES");
    expect(text).toContain("leveraged Bitcoin position");
  });

  it("says so plainly when the industry has decoupled from its declared driver", () => {
    const text = describeDriver(mk(0.12, 0.3, 0.55), "AI Datacenter & Mining");
    expect(text).toContain("DECOUPLED");
  });

  it("reports the sector winning when it explains the moves better", () => {
    const text = describeDriver(mk(0.4, 1.0, 0.75), "AI Datacenter & Mining");
    expect(text).toContain("XLK");
    expect(text).toContain("opposite of this group's usual behaviour");
  });

  it("asserts no relationship when the fit could not be measured", () => {
    const read = { ...mk(0, 0, null), driver: null };
    expect(describeDriver(read, "Gold Miners")).toContain("Not enough overlapping history");
  });
});
