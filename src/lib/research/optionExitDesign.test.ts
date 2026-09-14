import { describe, expect, it } from "vitest";
import {
  CROSSCHECK_TOLERANCE_SESSIONS,
  DEFAULT_PREMIUM_MULTIPLES,
  OptionExitDesign,
  designOptionExit,
} from "./optionExitDesign";
import { pTouchDown, pTouchUp, trailingSigmaAnnualized } from "./gbmTouch";
import { tradingSessionsBetween } from "./marketCalendar";
import { REACH_HORIZON_SESSIONS } from "./forwardReach";
import type { EquityExecutionSnapshot } from "../dossier/equityExpectations";
import type { Bar } from "./types";

/**
 * What these tests defend: the rung LEVELS are arithmetic identities (no
 * Greeks, no model), the clock is the contract's own, and every refusal
 * the calibration makes flows through instead of being papered over.
 */

const TODAY = "2026-09-14";
const EXPIRY = "2026-10-16";

/**
 * Bars with a controlled trailing sigma: alternating +/-r log returns give
 * an annualised sigma of about r * sqrt(252). Range straddles close by 1.
 */
function barsWithSigma(annualSigma: number, n = 80, start = 100): Bar[] {
  const r = annualSigma / Math.sqrt(252);
  const out: Bar[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    close = close * Math.exp(i % 2 === 0 ? r : -r);
    out.push({
      t: Date.UTC(2026, 0, 1) + i * 86_400_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

function snapshot(): EquityExecutionSnapshot {
  const cell = (distanceAtrMax: number, reachRatePct: number, attempts: number) => ({
    source: "zone" as const,
    distanceAtrMax,
    touchesMin: 0,
    kind: "all" as const,
    attempts,
    reached: Math.round((attempts * reachRatePct) / 100),
    reachRatePct,
    medianSessionsToReach: 3,
  });
  return {
    generatedAt: 1_760_000_000_000,
    method: { engine: "test", lookbackYears: 1, maxHoldSessions: 10, costBpsRoundTrip: 0, barsPerYear: 252 },
    coverage: {
      symbols: 1,
      firstDate: "2025-09-14",
      lastDate: TODAY,
      sessionsEvaluated: 252,
      plansPrinted: 0,
      reachRatePct: 0,
      trades: 0,
    },
    cells: {},
    reach: [cell(0.5, 87.8, 4000), cell(1, 70.7, 3800), cell(2, 48.7, 3600), cell(3, 25.5, 3400)],
    caveats: [],
  };
}

function design(overrides: Record<string, unknown> = {}): OptionExitDesign {
  const bars = (overrides.bars as Bar[]) ?? barsWithSigma(1.1);
  const spot = bars[bars.length - 1].close;
  const out = designOptionExit({
    right: "call",
    strike: Math.round(spot),
    expiry: EXPIRY,
    premium: 1.5,
    today: TODAY,
    spot,
    bars,
    snapshot: snapshot(),
    ...overrides,
  } as Parameters<typeof designOptionExit>[0]);
  if ("error" in out) throw new Error(out.error);
  return out;
}

describe("gbmTouch", () => {
  it("touches a vanishing barrier almost surely and a huge one almost never", () => {
    const sigma = 1, T = 10 / 252, mu = -0.5;
    expect(pTouchUp(1e-6, sigma, T, mu)).toBeGreaterThan(0.999);
    expect(pTouchUp(3, sigma, T, mu)).toBeLessThan(1e-6);
  });

  it("flips the drift on the down side rather than reusing the up formula", () => {
    // With mu = -sigma^2/2 the down side is FAVOURED; identical barriers
    // must not give identical probabilities, which is the reproduction
    // script's documented error.
    const sigma = 1, T = 21 / 252, mu = -0.5;
    const b = 0.09531; // ln(1.10)
    expect(pTouchDown(b, sigma, T, mu)).toBeGreaterThan(pTouchUp(b, sigma, T, mu));
  });
});

describe("designOptionExit — levels are arithmetic, not model output", () => {
  it("places call rungs at strike + multiple x premium", () => {
    const d = design({ strike: 100, premium: 2 });
    expect(d.rungs.map((r) => r.multiple)).toEqual([...DEFAULT_PREMIUM_MULTIPLES]);
    expect(d.rungs.map((r) => r.underlying_level)).toEqual([103, 104, 106]);
    for (const r of d.rungs) expect(r.guarantee).toContain("intrinsic");
  });

  it("places put rungs at strike - multiple x premium, measured downward", () => {
    const bars = barsWithSigma(1.1);
    const spot = bars[bars.length - 1].close;
    const d = design({ right: "put", strike: Math.round(spot), premium: 2, bars });
    const k = Math.round(spot);
    expect(d.rungs.map((r) => r.underlying_level)).toEqual([k - 3, k - 4, k - 6]);
    // A put's rung is below spot, so the move is positive in the paying direction.
    for (const r of d.rungs) expect(r.move_pct).toBeGreaterThan(0);
  });

  it("marks a level behind spot as already met and refuses to compute a reach for it", () => {
    // Deep ITM call: strike far below spot makes the 1.5x level intrinsic already.
    const bars = barsWithSigma(1.1);
    const spot = bars[bars.length - 1].close;
    const d = design({ strike: Math.round(spot - 20), premium: 1, bars });
    expect(d.rungs[0].already_met).toBe(true);
    expect(d.rungs[0].touch).toBeNull();
    expect(d.rungs[0].guarantee).toContain("already intrinsic");
  });
});

describe("designOptionExit — the contract's own clock", () => {
  it("derives the tenor from the holiday-aware calendar, not a default", () => {
    const d = design();
    expect(d.tenor_sessions).toBe(tradingSessionsBetween(TODAY, EXPIRY));
    expect(d.tenor_note).toContain(String(d.tenor_sessions));
  });

  it("refuses the 10-session cross-check when the tenor is off that clock, naming the defect", () => {
    const d = design(); // ~23 sessions to Oct 16 — far from 10
    expect(Math.abs(d.tenor_sessions - REACH_HORIZON_SESSIONS)).toBeGreaterThan(
      CROSSCHECK_TOLERANCE_SESSIONS
    );
    for (const r of d.rungs) {
      expect("refused" in r.forward_validated_crosscheck).toBe(true);
      if ("refused" in r.forward_validated_crosscheck) {
        expect(r.forward_validated_crosscheck.refused).toContain("clock-mismatch");
      }
    }
  });

  it("serves the validated bucket when the tenor is close enough to its clock", () => {
    // ~9 sessions ahead of TODAY (Mon 09-14 -> Fri 09-25).
    const d = design({ expiry: "2026-09-25", strike: 100, premium: 1 });
    expect(Math.abs(d.tenor_sessions - REACH_HORIZON_SESSIONS)).toBeLessThanOrEqual(
      CROSSCHECK_TOLERANCE_SESSIONS
    );
    const served = d.rungs.filter((r) => !("refused" in r.forward_validated_crosscheck));
    expect(served.length).toBeGreaterThan(0);
    for (const r of served) {
      const c = r.forward_validated_crosscheck as { reach_pct: number; clock_sessions: number };
      expect(c.clock_sessions).toBe(REACH_HORIZON_SESSIONS);
      expect(c.reach_pct).toBeGreaterThan(0);
    }
  });

  it("refuses an expiry that is not in the future", () => {
    const bars = barsWithSigma(1.1);
    const out = designOptionExit({
      right: "call",
      strike: 100,
      expiry: TODAY,
      premium: 1,
      today: TODAY,
      spot: 100,
      bars,
    });
    expect("error" in out).toBe(true);
  });
});

describe("designOptionExit — the calibration's refusals flow through", () => {
  it("uses the high band for a sigma-1.1 name and applies its negative bias", () => {
    const d = design({ strike: 100, premium: 2 });
    expect(d.trailing_sigma).toBeGreaterThan(0.8);
    for (const r of d.rungs) {
      if (r.touch === null) continue;
      expect(r.touch.sigma_band).toBe(">0.8");
      if (r.touch.corrected_pct !== null) {
        // The measured high-band bias is negative everywhere on the current
        // grid, so the corrected figure must sit below the raw formula.
        expect(r.touch.corrected_pct).toBeLessThan(r.touch.gbm_pct);
        expect(r.touch.blocks).toBeGreaterThan(0);
        expect(r.touch.effective_blocks).toBeGreaterThan(0);
      }
    }
  });

  it("passes the mid-band refusal through instead of quoting the pooled figure", () => {
    const d = design({ bars: barsWithSigma(0.65), strike: 100, premium: 2 });
    expect(d.trailing_sigma).toBeGreaterThan(0.5);
    expect(d.trailing_sigma).toBeLessThanOrEqual(0.8);
    for (const r of d.rungs) {
      if (r.touch === null) continue;
      expect(r.touch.corrected_pct).toBeNull();
      expect(r.touch.bias_pp).toBeNull();
      expect(r.touch.calibration_note).toContain("no bias figure is offered");
    }
  });

  it("refuses probabilities entirely when the history cannot produce a sigma", () => {
    const d = design({ bars: barsWithSigma(1.1, 30) });
    expect(d.trailing_sigma).toBeNull();
    for (const r of d.rungs) expect(r.touch).toBeNull();
    expect(d.sigma_note).toContain("refused");
  });
});

describe("designOptionExit — the stop", () => {
  it("states the defined-risk bound whether or not a stop is declared", () => {
    const d = design();
    expect(d.stop.defined_risk).toContain("premium paid");
    expect(d.stop.defined_risk).toContain("cannot be gapped through");
  });

  it("refuses to map a premium-value stop to an underlying level", () => {
    const d = design();
    expect(d.stop.underlying_stop_pct).toBeNull();
    expect(d.stop.touch).toBeNull();
    expect(d.stop.note).toContain("time-value model");
  });

  it("expresses a declared underlying stop as a touch probability, opposite side", () => {
    const d = design({ stopPct: 8, strike: 100, premium: 2 });
    expect(d.stop.underlying_stop_pct).toBe(8);
    expect(d.stop.touch).not.toBeNull();
    // A call's stop is below entry; the note says which way was measured.
    expect(d.stop.note).toContain("below");
    expect(d.stop.note).toContain("TESTED");
  });
});

describe("fixture sanity", () => {
  it("barsWithSigma actually produces the sigma it claims", () => {
    const s = trailingSigmaAnnualized(barsWithSigma(1.1));
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0.95);
    expect(s!).toBeLessThan(1.25);
  });
});
