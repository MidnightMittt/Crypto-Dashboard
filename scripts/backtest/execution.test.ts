import { describe, it, expect } from "vitest";
import { resolveTrade, HourBar, TradePlan } from "./execution";

/**
 * Every case below is hand-computed against a constructed bar sequence
 * before being asserted — the same discipline metrics.test.ts and
 * multipleTesting.test.ts follow. The point isn't coverage; it's that the
 * numbers this file produces get shown to someone sizing a position, so
 * each rule (especially the intrabar stop-wins convention) is pinned to an
 * example a human can check by eye.
 */

const HOUR = 3_600_000;
const SEVEN_DAYS = 7 * 24 * HOUR;

/** Entry at t=0 so every asserted `hours*` value reads directly as the bar index. */
function bar(hourIndex: number, high: number, low: number, close: number): HourBar {
  return { t: hourIndex * HOUR, high, low, close };
}

const LONG: TradePlan = {
  side: "long",
  entryPrice: 100,
  stopPrice: 95,
  targetPrice: 110,
  target2Price: 120,
  entryT: 0,
};

const SHORT: TradePlan = {
  side: "short",
  entryPrice: 100,
  stopPrice: 105,
  targetPrice: 90,
  target2Price: 80,
  entryT: 0,
};

describe("resolveTrade — long", () => {
  it("exits at TP1 on first touch, with excursions measured to that exit", () => {
    // h1 stays inside the levels; h2 trades up through 110.
    const bars = [bar(1, 105, 99, 104), bar(2, 112, 104, 111)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("target");
    expect(r.exitPrice).toBe(110);
    expect(r.grossReturnPct).toBeCloseTo(10, 10); // (110-100)/100
    expect(r.hoursToTarget).toBe(2);
    expect(r.hoursToStop).toBeNull();
    expect(r.hoursHeld).toBe(2);
    expect(r.mfePct).toBeCloseTo(12, 10); // best high 112
    expect(r.maePct).toBeCloseTo(-1, 10); // worst low 99
    expect(r.tp2ReachedBeforeStop).toBe(false); // never reached 120
    expect(r.ambiguousBar).toBe(false);
  });

  it("exits at the stop when price breaks down first", () => {
    const bars = [bar(1, 102, 94, 96)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("stop");
    expect(r.exitPrice).toBe(95);
    expect(r.grossReturnPct).toBeCloseTo(-5, 10);
    expect(r.hoursToStop).toBe(1);
    expect(r.hoursToTarget).toBeNull();
    expect(r.mfePct).toBeCloseTo(2, 10);
    expect(r.maePct).toBeCloseTo(-6, 10); // the wick to 94, not the 95 stop
  });

  it("resolves a bar spanning BOTH levels as the stop, and flags it", () => {
    // The whole pessimistic-convention rule, in one bar: 94 low and 111
    // high. Hourly data cannot order them; the stop is assumed to win.
    const bars = [bar(1, 111, 94, 108)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.ambiguousBar).toBe(true);
    expect(r.outcome).toBe("stop");
    expect(r.exitPrice).toBe(95);
    expect(r.grossReturnPct).toBeCloseTo(-5, 10);
  });

  it("closes at the last bar's close when neither level is touched", () => {
    const bars = [bar(1, 103, 98, 101), bar(2, 104, 99, 102)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("timeout");
    expect(r.exitPrice).toBe(102);
    expect(r.grossReturnPct).toBeCloseTo(2, 10);
    expect(r.hoursHeld).toBe(2);
    expect(r.hoursToTarget).toBeNull();
    expect(r.hoursToStop).toBeNull();
  });

  it("reports a NEGATIVE mfe when price never once traded above entry", () => {
    // Deliberately not clamped to zero — "it never worked for a moment" is
    // information, and clamping would make this look like a flat trade.
    const bars = [bar(1, 99, 96, 97)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.mfePct).toBeCloseTo(-1, 10);
    expect(r.maePct).toBeCloseTo(-4, 10);
    expect(r.outcome).toBe("timeout");
  });
});

describe("resolveTrade — short", () => {
  it("signs return, mfe and mae in the trade's own direction", () => {
    // Price falls to 88: good for a short. High of 101 is the adverse side.
    const bars = [bar(1, 101, 88, 91)];
    const r = resolveTrade(SHORT, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("target");
    expect(r.exitPrice).toBe(90);
    expect(r.grossReturnPct).toBeCloseTo(10, 10); // profitable short reads POSITIVE
    expect(r.mfePct).toBeCloseTo(12, 10); // low of 88
    expect(r.maePct).toBeCloseTo(-1, 10); // high of 101
  });

  it("stops out when price rallies through the stop above entry", () => {
    const bars = [bar(1, 106, 99, 105)];
    const r = resolveTrade(SHORT, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("stop");
    expect(r.exitPrice).toBe(105);
    expect(r.grossReturnPct).toBeCloseTo(-5, 10);
  });
});

describe("resolveTrade — tp2 scan is independent of the TP1 exit", () => {
  it("credits TP2 reached in a LATER bar than the TP1 exit", () => {
    // The trade itself closes at TP1 in h1. The runner question — would it
    // have made TP2 before the stop — is about the whole window, so this
    // must still be true even though the main loop stopped at h1.
    const bars = [bar(1, 111, 99, 110), bar(2, 121, 109, 120)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("target");
    expect(r.hoursToTarget).toBe(1);
    expect(r.tp2ReachedBeforeStop).toBe(true);
  });

  it("does NOT credit TP2 when the stop is touched first", () => {
    const bars = [bar(1, 105, 94, 96), bar(2, 125, 120, 124)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("stop");
    expect(r.tp2ReachedBeforeStop).toBe(false);
  });

  it("does NOT credit TP2 on a bar that also touches the stop", () => {
    const bars = [bar(1, 125, 94, 120)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.tp2ReachedBeforeStop).toBe(false);
  });
});

describe("resolveTrade — window bounds", () => {
  it("ignores the entry bar itself and anything past the hold limit", () => {
    // h0 and h3 would both hit TP1; only h1 is inside a 2-hour window, and
    // it touches nothing — so this must time out, not report a target.
    const bars = [bar(0, 200, 90, 150), bar(1, 103, 98, 101), bar(3, 200, 150, 190)];
    const r = resolveTrade(LONG, bars, 2 * HOUR)!;

    expect(r.outcome).toBe("timeout");
    expect(r.exitPrice).toBe(101);
    expect(r.hoursHeld).toBe(1);
  });

  it("returns null when no bar falls inside the window", () => {
    // Dropped rather than counted as a timeout — a non-observation must not
    // pad the sample.
    expect(resolveTrade(LONG, [bar(99, 110, 90, 100)], 2 * HOUR)).toBeNull();
    expect(resolveTrade(LONG, [], SEVEN_DAYS)).toBeNull();
  });

  it("returns null for a nonsensical entry price rather than dividing by zero", () => {
    expect(resolveTrade({ ...LONG, entryPrice: 0 }, [bar(1, 110, 90, 100)], SEVEN_DAYS)).toBeNull();
  });

  it("sorts unordered bars before walking them", () => {
    // Same two bars as the TP1 case, supplied backwards. The stop is never
    // touched, so order only affects WHICH bar reports the target — getting
    // this wrong would report hoursToTarget: 1 instead of 2.
    const bars = [bar(2, 112, 104, 111), bar(1, 105, 99, 104)];
    const r = resolveTrade(LONG, bars, SEVEN_DAYS)!;

    expect(r.outcome).toBe("target");
    expect(r.hoursToTarget).toBe(2);
  });
});
