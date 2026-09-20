import { describe, expect, it } from "vitest";
import { evaluateLpAlerts, MIN_SIGMA_ROWS, ponsDailySigmaFromTicks } from "./lpAlerts";
import { FeeSeriesRow } from "./feeSeries";
import { PositionCard } from "./lpPosition";

const iso = (h: number) => new Date(Date.UTC(2026, 8, 20, h % 24, 0, 0)).toISOString();

function row(over: Partial<FeeSeriesRow>): FeeSeriesRow {
  return {
    ts: iso(0), block: 100, tick: 84000, fees_usd: 1, fee_rate_usd_per_day: 1,
    share_of_active: 0.0075, vol_2h: null, kind: "sample", gap_hours: 6,
    eth_usd_source: "kraken.ETHUSD.last", liquidity: "20709381339772035115", ...over,
  };
}

function card(over: Partial<PositionCard>): PositionCard {
  return {
    block: "100", observedAt: iso(6), chain: { chainId: 4663, rpc: "rpc" },
    currentTick: 84000, inRange: true, pctThroughRange: 0.68, ponsUsd: 0.57,
    ethUsd: { value: 2568, stamp: { ts: iso(6), source: "kraken.ETHUSD.last" } },
    amounts: { weth: 0.04, pons: 375 }, usdValue: 328,
    feesSinceCollect: { weth: 0.0003, pons: 1.7, usd: 1.5 },
    shareOfActivePct: 0.0075, liquidity: "20709381339772035115", notes: [], ...over,
  };
}

describe("review-tick alert", () => {
  it("fires once when the tick crosses UP through the review level", () => {
    const prior = [row({ tick: 85000 })];
    const newRow = row({ tick: 85600, ts: iso(6) });
    const a = evaluateLpAlerts(card({ currentTick: 85600, pctThroughRange: 0.85, ponsUsd: 0.5 }), newRow, prior);
    expect(a.map((x) => x.key)).toContain("review_tick");
  });

  it("does NOT re-fire while the tick stays above the review level", () => {
    const prior = [row({ tick: 85700 })];
    const newRow = row({ tick: 85800, ts: iso(6) });
    const a = evaluateLpAlerts(card({ currentTick: 85800 }), newRow, prior);
    expect(a.map((x) => x.key)).not.toContain("review_tick");
  });

  it("says review, never a trade instruction", () => {
    const a = evaluateLpAlerts(card({ currentTick: 85600 }), row({ tick: 85600, ts: iso(6) }), [row({ tick: 85000 })]);
    const msg = a.find((x) => x.key === "review_tick")!.message.toLowerCase();
    expect(msg).not.toMatch(/\b(sell|buy|exit|add|take profit)\b/);
    expect(msg).toContain("review");
  });
});

describe("range-exit alert", () => {
  it("fires on the transition out of range, naming the side", () => {
    const prior = [row({ tick: 86000 })];
    const newRow = row({ tick: 87500, ts: iso(6) });
    const a = evaluateLpAlerts(card({ currentTick: 87500, inRange: false }), newRow, prior);
    const exit = a.find((x) => x.key === "range_exit");
    expect(exit).toBeDefined();
    expect(exit!.message).toContain("above");
  });

  it("does not fire while still out of range", () => {
    const prior = [row({ tick: 88000 })];
    const a = evaluateLpAlerts(card({ currentTick: 88500, inRange: false }), row({ tick: 88500, ts: iso(6) }), prior);
    expect(a.map((x) => x.key)).not.toContain("range_exit");
  });
});

describe("series-gap alert", () => {
  it("fires when the gap exceeds the 12h threshold", () => {
    const newRow = row({ gap_hours: 18, ts: iso(18) });
    const a = evaluateLpAlerts(card({}), newRow, [row({ tick: 84000 })]);
    expect(a.map((x) => x.key)).toContain("series_gap");
  });
  it("stays quiet on an on-cadence gap", () => {
    const a = evaluateLpAlerts(card({}), row({ gap_hours: 6 }), [row({ tick: 84000 })]);
    expect(a.map((x) => x.key)).not.toContain("series_gap");
  });
});

describe("ponsDailySigmaFromTicks", () => {
  it("refuses below MIN_SIGMA_ROWS rather than reporting a thin-sample sigma", () => {
    const few = Array.from({ length: MIN_SIGMA_ROWS - 1 }, (_, i) => row({ tick: 84000 + i * 10, ts: iso(i) }));
    expect(ponsDailySigmaFromTicks(few)).toBeNull();
  });

  it("reports sigma with its window once there are enough rows", () => {
    // Alternating ticks → nonzero volatility.
    const rows = Array.from({ length: MIN_SIGMA_ROWS + 2 }, (_, i) =>
      row({ tick: 84000 + (i % 2 === 0 ? 0 : 120), ts: iso(i) })
    );
    const s = ponsDailySigmaFromTicks(rows);
    expect(s).not.toBeNull();
    expect(s!.sigma).toBeGreaterThan(0);
    expect(s!.windowRows).toBe(MIN_SIGMA_ROWS + 2);
  });
});

describe("lvr-uncovered alert", () => {
  it("fires when a real sigma makes fee coverage < 1", () => {
    // Build 14 rows with big tick swings → high sigma → LVR outruns a small fee rate.
    const prior = Array.from({ length: MIN_SIGMA_ROWS + 1 }, (_, i) =>
      row({ tick: 84000 + (i % 2 === 0 ? 0 : 300), ts: iso(i) })
    );
    const newRow = row({ tick: 84300, ts: iso(MIN_SIGMA_ROWS + 1), fee_rate_usd_per_day: 0.1, gap_hours: 6 });
    const a = evaluateLpAlerts(card({ usdValue: 328 }), newRow, prior);
    expect(a.map((x) => x.key)).toContain("lvr_uncovered");
    const msg = a.find((x) => x.key === "lvr_uncovered")!.message;
    expect(msg).toContain("σ"); // states the sigma and window
  });

  it("refuses to judge coverage on thin tick history", () => {
    const prior = [row({ tick: 84000 }), row({ tick: 84100, ts: iso(6) })];
    const newRow = row({ tick: 84200, ts: iso(12), fee_rate_usd_per_day: 0.1 });
    const a = evaluateLpAlerts(card({}), newRow, prior);
    expect(a.map((x) => x.key)).not.toContain("lvr_uncovered");
  });
});
