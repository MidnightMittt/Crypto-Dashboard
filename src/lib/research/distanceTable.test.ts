import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import { distanceRow, sortByDistance } from "./distanceTable";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** Bars from explicit (high, low) pairs around a flat 100 close. */
const bars = (pairs: Array<[number, number]>): Bar[] =>
  pairs.map(([high, low], i) => ({
    t: T0 + i * DAY,
    open: 100,
    high,
    low,
    close: 100,
    volume: 1_000_000,
  }));

/** 200 sessions; every 4th dips to 95 intraday, every 5th reaches 104. */
const path = bars(
  Array.from({ length: 200 }, (_, i) => [i % 5 === 0 ? 104 : 100.5, i % 4 === 0 ? 95 : 99.5] as [number, number])
);

describe("distanceRow", () => {
  it("computes distance and direction from the caller's own numbers", () => {
    // The real 2026-08-21 row: BTDR 11.315 against the 10.20 time-stop.
    const r = distanceRow({ symbol: "BTDR", price: 11.315, level: 10.2, label: "time-stop" }, null);
    expect(r.direction).toBe("below");
    expect(r.distance_usd).toBeCloseTo(1.12, 2);
    expect(r.distance_pct).toBeCloseTo(9.85, 2);
    expect(r.label).toBe("time-stop");
  });

  it("measures a level below price against LOWS — how often a session falls that far", () => {
    // A level 5% below: every 4th session's low touches 95 exactly.
    const r = distanceRow({ symbol: "TEST", price: 100, level: 95 }, path);
    expect(r.direction).toBe("below");
    const touch = r.single_session_touch as { pct: number; n: number };
    expect(touch.pct).toBeCloseTo(25, 0);
    expect(touch.n).toBeGreaterThan(150);
  });

  it("measures a level above price against HIGHS — how often a session reaches that far", () => {
    // A level 4% above: every 5th session's high reaches 104 exactly.
    const r = distanceRow({ symbol: "TEST", price: 100, level: 104 }, path);
    expect(r.direction).toBe("above");
    const touch = r.single_session_touch as { pct: number; n: number };
    expect(touch.pct).toBeCloseTo(20, 0);
  });

  it("still answers the distance when the panel cannot answer the frequency", () => {
    const r = distanceRow({ symbol: "PURR", price: 10, level: 9 }, null);
    expect(r.distance_pct).toBeCloseTo(10, 5);
    expect(r.single_session_touch).toHaveProperty("reason");
    const t = r.single_session_touch as { reason: string };
    expect(t.reason).toContain("distance is computed, frequency is not");
  });

  it("refuses the frequency on thin history rather than answering from a handful of bars", () => {
    const thin = path.slice(0, 10);
    const r = distanceRow({ symbol: "THIN", price: 100, level: 95 }, thin);
    expect(r.single_session_touch).toHaveProperty("reason");
  });
});

describe("sortByDistance", () => {
  it("puts the closest level first — the sort is the point of the table", () => {
    const rows = [
      distanceRow({ symbol: "RIOT", price: 19.7, level: 16.04 }, null), // 18.6%
      distanceRow({ symbol: "BTDR", price: 11.315, level: 10.2 }, null), // 9.9%
      distanceRow({ symbol: "CIFR", price: 15.76, level: 18.32 }, null), // 16.2%
    ];
    expect(sortByDistance(rows).map((r) => r.symbol)).toEqual(["BTDR", "CIFR", "RIOT"]);
  });
});
