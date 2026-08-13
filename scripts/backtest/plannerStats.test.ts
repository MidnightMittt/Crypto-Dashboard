import { describe, it, expect } from "vitest";
import {
  buildPlannerStats,
  buildTimeStopFinding,
  gateEffect,
  quantile,
  PlannerTradeRow,
  MIN_CELL_N,
} from "./plannerStats";

const row = (
  side: "long" | "short",
  volRegime: "high-vol" | "normal-vol" | "low-vol" | null,
  netReturnPct: number,
  maePct = -1,
  mfePct = 2,
  hoursHeld: number | null = 12
): PlannerTradeRow => ({ side, volRegime, netReturnPct, maePct, mfePct, hoursHeld });

describe("quantile", () => {
  it("matches hand-computed linear interpolation", () => {
    // Sorted [1,2,3,4,5]: p50 = 3; p80 = index 3.2 -> 4 + 0.2*(5-4) = 4.2.
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(quantile([5, 1, 4, 2, 3], 0.8)).toBeCloseTo(4.2, 10);
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe("buildPlannerStats cells", () => {
  it("computes EV at point and Wilson-lower win rates, hand-verified", () => {
    // 30 longs in high-vol: 15 win +4%, 15 lose -2%.
    // p = 0.5, avgWin 4, avgLoss -2 -> EV@point = 0.5*4 + 0.5*(-2) = +1.
    // Wilson lower for 15/30 at z=1.96 is 0.3313 (hand-computed:
    // center (0.5 + 1.96^2/60)/(1+1.96^2/30) = 0.5, half-width
    // 1.96*sqrt(0.25/30 + 1.96^2/3600)/(1+1.96^2/30) = 0.1687).
    // EV@lower = 0.3313*4 + 0.6687*(-2) = 1.3252 - 1.3374 = -0.0122.
    const rows: PlannerTradeRow[] = [
      ...Array.from({ length: 15 }, () => row("long", "high-vol", 4)),
      ...Array.from({ length: 15 }, () => row("long", "high-vol", -2)),
    ];
    const stats = buildPlannerStats(rows);
    const cell = stats.cells["long:high-vol"]!;
    expect(cell.n).toBe(30);
    expect(cell.winRatePct).toBe(50);
    expect(cell.winRateWilsonLowPct).toBeCloseTo(33.13, 1);
    expect(cell.evPointPct).toBeCloseTo(1, 10);
    expect(cell.evLowerPct).toBeCloseTo(-0.012, 2);
    // A coin-flip cell with asymmetric payoffs is positive at the point
    // estimate and NEGATIVE at the pessimistic bound — exactly the case the
    // gate exists to catch.
    expect(cell.evPointPct).toBeGreaterThan(0);
    expect(cell.evLowerPct).toBeLessThanOrEqual(0);
  });

  it("omits cells below MIN_CELL_N instead of publishing thin bounds", () => {
    const rows = Array.from({ length: MIN_CELL_N - 1 }, () => row("short", "low-vol", 1));
    expect(buildPlannerStats(rows).cells["short:low-vol"]).toBeUndefined();
  });

  it("describes winners' excursions as positive adverse percentages", () => {
    // 30 winners with MAE spread -1..-30 (recorded negative), MFE 2..60.
    const rows = Array.from({ length: 30 }, (_, i) => row("long", "low-vol", 1, -(i + 1), 2 * (i + 1)));
    // One loser so the cell has both sides.
    rows.push(row("long", "low-vol", -1));
    const w = buildPlannerStats(rows).cells["long:low-vol"]!.winners!;
    expect(w.n).toBe(30);
    expect(w.maeP50Pct).toBeCloseTo(15.5, 10); // median of 1..30
    expect(w.maeP90Pct).toBeCloseTo(27.1, 10); // index 26.1 over sorted 1..30
    expect(w.mfeP50Pct).toBeCloseTo(31, 10);
  });
});

describe("time-stop finding", () => {
  it("declares no time stop when survivors keep improving", () => {
    const finding = buildTimeStopFinding([
      { hours: 24, n: 100, eventualWinRatePct: 50 },
      { hours: 96, n: 60, eventualWinRatePct: 58 },
    ]);
    expect(finding).toContain("NO TIME STOP");
    expect(finding).toContain("never fires");
  });

  it("names the exit hour when a cohort drops below the threshold", () => {
    const finding = buildTimeStopFinding([
      { hours: 24, n: 100, eventualWinRatePct: 52 },
      { hours: 72, n: 70, eventualWinRatePct: 41 },
    ]);
    expect(finding).toContain("exit by hour 72");
  });
});

describe("gateEffect", () => {
  it("splits trades by their cell's EV-lower sign and reports both expectancies", () => {
    // Longs: 25 win +4, 5 lose -2 -> p=25/30, Wilson lower ~0.664,
    // EV@lower = 0.664*4 + 0.336*(-2) > 0 -> kept.
    // Shorts: 5 win +2, 25 lose -3 -> clearly negative -> refused.
    const longs = [
      ...Array.from({ length: 25 }, () => row("long", "high-vol", 4)),
      ...Array.from({ length: 5 }, () => row("long", "high-vol", -2)),
    ];
    const shorts = [
      ...Array.from({ length: 5 }, () => row("short", "high-vol", 2)),
      ...Array.from({ length: 25 }, () => row("short", "high-vol", -3)),
    ];
    const rows = [...longs, ...shorts];
    const stats = buildPlannerStats(rows);
    const effect = gateEffect(rows, stats);
    expect(effect.keptN).toBe(30);
    expect(effect.refusedN).toBe(30);
    expect(effect.keptExpectancyPct).toBeCloseTo((25 * 4 + 5 * -2) / 30, 10);
    expect(effect.refusedExpectancyPct).toBeCloseTo((5 * 2 + 25 * -3) / 30, 10);
  });

  it("never gates untagged or below-sample trades — no evidence, no verdict", () => {
    const rows = [row("short", null, -5), row("short", "low-vol", -5)];
    const stats = buildPlannerStats(rows); // no cell clears MIN_CELL_N
    const effect = gateEffect(rows, stats);
    expect(effect.refusedN).toBe(0);
    expect(effect.keptN).toBe(2);
  });
});
