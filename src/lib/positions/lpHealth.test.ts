import { describe, expect, it } from "vitest";
import {
  ImplausibleMagnitude,
  PositionRead,
  assertPlausible,
  coverage,
  evaluateThesis,
  feeYieldDailyPct,
  lpKeepFraction,
  yieldReading,
} from "./lpHealth";
import { Thesis } from "./book";

describe("magnitude assertions — the 766x and 40-digit scars", () => {
  it("refuses a coverage of 766 (the stablecoin-sigma unit error)", () => {
    // sigma measured on a USD leg of a stable pair → tiny → coverage explodes.
    expect(() => coverage({ yieldDailyPct: 2.4, sigmaDaily: 0.005 })).toThrow(ImplausibleMagnitude);
  });

  it("refuses an implausible sigma rather than computing with it", () => {
    expect(() => coverage({ yieldDailyPct: 1, sigmaDaily: 5.0 })).toThrow(ImplausibleMagnitude);
  });

  it("passes plausible values through unchanged", () => {
    expect(assertPlausible("sigmaDaily", 0.55)).toBe(0.55);
  });
});

describe("feeYieldDailyPct", () => {
  it("reproduces the PRIORS arithmetic: ~12%/day on the 6h window", () => {
    // Verified live 2026-10-02: vol6h $39,351, reserve $10,837, 1% tier, keep 5/6.
    const y = feeYieldDailyPct({ volumeUsd: 39351, windowHours: 6, feePips: 10000, lpKeep: 5 / 6, reserveUsd: 10837 });
    expect(y).toBeCloseTo(12.1, 0);
  });

  it("returns null rather than a rate on an empty window or reserve", () => {
    expect(feeYieldDailyPct({ volumeUsd: 100, windowHours: 0, feePips: 10000, lpKeep: 1, reserveUsd: 1000 })).toBeNull();
    expect(feeYieldDailyPct({ volumeUsd: 100, windowHours: 6, feePips: 10000, lpKeep: 1, reserveUsd: 0 })).toBeNull();
  });
});

describe("lpKeepFraction", () => {
  it("decodes 102 (6|6) as keep 5/6 — LPs keep 0.8333% of a 1% tier", () => {
    expect(lpKeepFraction(102)).toBeCloseTo(5 / 6, 10);
  });
  it("decodes 0 as no protocol take", () => {
    expect(lpKeepFraction(0)).toBe(1);
  });
});

describe("yieldReading — the 69x decay lesson", () => {
  it("computes both windows and their ratio", () => {
    const r = yieldReading({ vol6hUsd: 1000, vol24hUsd: 8000, feePips: 10000, lpKeep: 1, reserveUsd: 10000 });
    // y6: 1000*(24/6)=4000 daily vol x 1% fee / 10000 reserve = 0.4%/day; y24 = 0.8%/day.
    expect(r.y6DailyPct).toBeCloseTo(0.4, 6);
    expect(r.y24DailyPct).toBeCloseTo(0.8, 6);
    expect(r.decay).toBeCloseTo(0.5, 6);
    expect(r.windows).toEqual({ fast: "6h", slow: "24h" });
  });

  it("carries nulls through rather than inventing a window", () => {
    const r = yieldReading({ vol6hUsd: null, vol24hUsd: 8000, feePips: 10000, lpKeep: 1, reserveUsd: 10000 });
    expect(r.y6DailyPct).toBeNull();
    expect(r.decay).toBeNull();
  });
});

describe("coverage", () => {
  it("reproduces the two real positions' opposite verdicts", () => {
    // PRIORS: ~12%/day yield, sigma ~57%/day → LVR 4.06%/day → ~3-4x.
    const priors = coverage({ yieldDailyPct: 12.1, sigmaDaily: 0.57 });
    expect(priors).toBeGreaterThan(1.5);
    // SEND: earning nothing out of range → yield ~0 → coverage ~0.
    const send = coverage({ yieldDailyPct: 0.3, sigmaDaily: 0.55 });
    expect(send).toBeLessThan(1);
  });
});

const COVERAGE_THESIS: Thesis = {
  reason: "fees cover LVR",
  metric: "coverage",
  op: ">=",
  threshold: 1.0,
  consecutiveReads: 2,
};

const read = (ts: string, cov: number | null): PositionRead => ({
  ts,
  id: "x",
  metrics: { coverage: cov },
});

describe("evaluateThesis — two consecutive reads, never one", () => {
  it("is ok while the rule holds", () => {
    const v = evaluateThesis(COVERAGE_THESIS, [read("t1", 4.2), read("t2", 4.3)]);
    expect(v.state).toBe("ok");
  });

  /* The scar: one stale API read produced a false signal. One bad read = breaking, not broken. */
  it("marks a single violating read as BREAKING, not broken", () => {
    const v = evaluateThesis(COVERAGE_THESIS, [read("t1", 4.2), read("t2", 0.3)]);
    expect(v.state).toBe("breaking");
    expect(v.brokenSince).toBeNull();
  });

  it("confirms BROKEN on the second consecutive violation", () => {
    const v = evaluateThesis(COVERAGE_THESIS, [read("t1", 4.2), read("t2", 0.3), read("t3", 0.29)]);
    expect(v.state).toBe("broken");
    expect(v.brokenSince).toBe("t2");
  });

  /* "BROKEN since 09-29" is the actionable fact — the streak start, not the confirmation. */
  it("walks brokenSince back to the start of the streak", () => {
    const v = evaluateThesis(COVERAGE_THESIS, [
      read("09-28", 1.4),
      read("09-29a", 0.9),
      read("09-29b", 0.7),
      read("09-30", 0.5),
      read("10-01", 0.29),
    ]);
    expect(v.state).toBe("broken");
    expect(v.brokenSince).toBe("09-29a");
  });

  it("a recovery resets the streak — ok, then a fresh violation is breaking again", () => {
    const v = evaluateThesis(COVERAGE_THESIS, [read("t1", 0.3), read("t2", 1.5), read("t3", 0.4)]);
    expect(v.state).toBe("breaking");
  });

  it("reports unmeasured rather than treating a null as a pass or a break", () => {
    const v = evaluateThesis(COVERAGE_THESIS, [read("t1", 0.3), read("t2", null)]);
    expect(v.state).toBe("unmeasured");
  });

  it("handles <= rules (out-of-range hours)", () => {
    const t: Thesis = { reason: "", metric: "out_of_range_hours", op: "<=", threshold: 12, consecutiveReads: 2 };
    const mk = (ts: string, h: number): PositionRead => ({ ts, id: "x", metrics: { out_of_range_hours: h } });
    expect(evaluateThesis(t, [mk("a", 3), mk("b", 8)]).state).toBe("ok");
    expect(evaluateThesis(t, [mk("a", 8), mk("b", 14)]).state).toBe("breaking");
    expect(evaluateThesis(t, [mk("a", 14), mk("b", 20)]).state).toBe("broken");
  });
});
