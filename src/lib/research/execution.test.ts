import { describe, expect, it } from "vitest";
import { resolvePosition, Position } from "./execution";
import { Bar, CONTINUOUS_SESSION, US_EQUITY_SESSION } from "./types";

function bar(t: number, open: number, high: number, low: number, close: number): Bar {
  return { t, open, high, low, close, volume: 1000 };
}

const DAY = 86_400_000;

/** Long from 100, stop 95, target 110. */
const LONG: Position = { side: "long", entryT: 0, entryPrice: 100, stopPrice: 95, targetPrice: 110 };
/** Short from 100, stop 105, target 90. */
const SHORT: Position = { side: "short", entryT: 0, entryPrice: 100, stopPrice: 105, targetPrice: 90 };

describe("continuous markets — intrabar fills are legitimate", () => {
  it("fills a long stop at the stop price when the bar trades through it", () => {
    const bars = [bar(DAY, 99, 101, 94, 96)];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    expect(r.reason).toBe("stop");
    expect(r.exitPrice).toBe(95);
    expect(r.gapped).toBe(false);
    expect(r.returnPct).toBeCloseTo(-5, 10);
  });

  it("fills a long target at the target price", () => {
    const bars = [bar(DAY, 101, 112, 100, 111)];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    expect(r.reason).toBe("target");
    expect(r.exitPrice).toBe(110);
    expect(r.returnPct).toBeCloseTo(10, 10);
  });

  it("does NOT treat a gapped open as a gap when the market cannot gap", () => {
    // Same bar as the equity gap test below; under a continuous model the
    // open is irrelevant and the stop is honoured at its level.
    const bars = [bar(DAY, 88, 90, 86, 89)];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    expect(r.exitPrice).toBe(95);
    expect(r.gapped).toBe(false);
    expect(r.gapSlippage).toBe(0);
  });
});

describe("session markets — gaps must be honoured", () => {
  it("fills a long stop at the OPEN when price gaps below it overnight", () => {
    // Opens at 88, far below the 95 stop. The 95 fill was never available.
    const bars = [bar(DAY, 88, 90, 86, 89)];
    const r = resolvePosition(LONG, bars, US_EQUITY_SESSION, 10);
    expect(r.reason).toBe("stop");
    expect(r.exitPrice).toBe(88);
    expect(r.gapped).toBe(true);
    expect(r.gapSlippage).toBeCloseTo(-7, 10); // 88 - 95, worse than intended
    expect(r.returnPct).toBeCloseTo(-12, 10);
  });

  it("fills a short stop at the OPEN when price gaps above it", () => {
    const bars = [bar(DAY, 115, 118, 113, 117)];
    const r = resolvePosition(SHORT, bars, US_EQUITY_SESSION, 10);
    expect(r.reason).toBe("stop");
    expect(r.exitPrice).toBe(115);
    expect(r.gapped).toBe(true);
    expect(r.gapSlippage).toBeCloseTo(-10, 10); // 105 - 115
    expect(r.returnPct).toBeCloseTo(-15, 10);
  });

  it("credits a FAVOURABLE gap through the target at the open", () => {
    // Gaps up to 118 past a 110 target — the trader really does get 118.
    const bars = [bar(DAY, 118, 120, 117, 119)];
    const r = resolvePosition(LONG, bars, US_EQUITY_SESSION, 10);
    expect(r.reason).toBe("target");
    expect(r.exitPrice).toBe(118);
    expect(r.gapped).toBe(true);
    expect(r.gapSlippage).toBeCloseTo(8, 10); // positive: better than intended
    expect(r.returnPct).toBeCloseTo(18, 10);
  });

  it("checks the stop gap BEFORE the target gap when a bar is wild enough to contain both", () => {
    // Opens at 88 (through the stop) then rallies past the target. The
    // position was already out at the open; the later rally is irrelevant.
    const bars = [bar(DAY, 88, 130, 87, 129)];
    const r = resolvePosition(LONG, bars, US_EQUITY_SESSION, 10);
    expect(r.reason).toBe("stop");
    expect(r.exitPrice).toBe(88);
  });

  it("still fills at the level when the open is inside the range (no gap)", () => {
    const bars = [bar(DAY, 99, 101, 94, 96)];
    const r = resolvePosition(LONG, bars, US_EQUITY_SESSION, 10);
    expect(r.exitPrice).toBe(95);
    expect(r.gapped).toBe(false);
  });
});

describe("the comparison that justifies this module existing", () => {
  /*
   * Identical bars, identical position, only the session model differs.
   * If these two ever agree, the gap logic has stopped working and every
   * equity statistic downstream is quietly overstated.
   */
  it("the same gap-down bar is materially worse under a session model than a continuous one", () => {
    const bars = [bar(DAY, 88, 90, 86, 89)];
    const continuous = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    const session = resolvePosition(LONG, bars, US_EQUITY_SESSION, 10);

    expect(continuous.returnPct).toBeCloseTo(-5, 10);
    expect(session.returnPct).toBeCloseTo(-12, 10);
    expect(session.returnPct).toBeLessThan(continuous.returnPct);
    // The difference is exactly the gap slippage.
    expect(continuous.returnPct - session.returnPct).toBeCloseTo(7, 10);
  });

  it("across a run of gapping trades the continuous model overstates every one", () => {
    const gapDowns = [bar(DAY, 90, 92, 89, 91)];
    for (const pos of [LONG, SHORT]) {
      const bars = pos.side === "long" ? gapDowns : [bar(DAY, 110, 111, 108, 109)];
      const c = resolvePosition(pos, bars, CONTINUOUS_SESSION, 10);
      const s = resolvePosition(pos, bars, US_EQUITY_SESSION, 10);
      expect(s.returnPct).toBeLessThanOrEqual(c.returnPct);
    }
  });
});

describe("ambiguity and edges", () => {
  it("resolves a bar containing BOTH stop and target as a stop, and flags it", () => {
    const bars = [bar(DAY, 100, 112, 94, 105)];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    expect(r.reason).toBe("stop");
    expect(r.ambiguousBar).toBe(true);
  });

  it("times out at the last bar's close when neither level is reached", () => {
    const bars = [bar(DAY, 100, 102, 98, 101), bar(2 * DAY, 101, 103, 99, 102)];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    expect(r.reason).toBe("timeout");
    expect(r.exitPrice).toBe(102);
    expect(r.barsHeld).toBe(2);
  });

  it("honours maxBars, timing out even if a later bar would have resolved it", () => {
    const bars = [
      bar(DAY, 100, 102, 98, 101),
      bar(2 * DAY, 101, 103, 99, 102),
      bar(3 * DAY, 102, 115, 101, 114), // would hit target, but beyond maxBars
    ];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 2);
    expect(r.reason).toBe("timeout");
    expect(r.barsHeld).toBe(2);
  });

  it("reports unresolved rather than a fabricated flat outcome when no forward bars exist", () => {
    const r = resolvePosition(LONG, [], CONTINUOUS_SESSION, 10);
    expect(r.reason).toBe("unresolved");
    expect(r.exitPrice).toBeNull();
    expect(r.returnPct).toBe(0);
  });

  it("ignores bars at or before the entry timestamp", () => {
    const bars = [bar(0, 100, 120, 90, 110), bar(DAY, 100, 101, 99, 100)];
    const r = resolvePosition(LONG, bars, CONTINUOUS_SESSION, 10);
    // The t=0 bar would have hit both levels; it must not be considered.
    expect(r.reason).toBe("timeout");
    expect(r.barsHeld).toBe(1);
  });

  it("returns a short's profit as positive when price falls to target", () => {
    const bars = [bar(DAY, 99, 100, 89, 91)];
    const r = resolvePosition(SHORT, bars, CONTINUOUS_SESSION, 10);
    expect(r.reason).toBe("target");
    expect(r.returnPct).toBeCloseTo(10, 10);
  });
});
