import { describe, expect, it } from "vitest";
import {
  equityPlanConstraints,
  EquityCell,
  EquityExecutionSnapshot,
  equityCellKey,
  equityExpectationsFor,
  ReachCell,
  reachRateFor,
  volRegimeFromMetrics,
} from "./equityExpectations";
import { MetricVerdict } from "@/lib/signals/types";

function metric(id: string, verdict: MetricVerdict["verdict"]): MetricVerdict {
  return {
    id,
    label: id,
    verdict,
    confidence: 50,
    confidenceBasis: "",
    explanation: "",
    whyItMatters: "",
    asOf: 0,
    conflicts: [],
    nextTrigger: "",
  };
}

const cell = (over: Partial<EquityCell> = {}): EquityCell => ({
  side: "long",
  volRegime: "normal-vol",
  n: 400,
  effectiveN: 41,
  winRatePct: 42.9,
  winRateWilsonLowPct: 36.4,
  avgWinPct: 8.2,
  avgLossPct: -3.1,
  evPointPct: 1.76,
  evLowerPct: 0.95,
  medianHoldSessions: 10,
  driftNullPct: 0.82,
  excessEvPct: 0.94,
  winners: { n: 172, maeP50Pct: 1.9, maeP80Pct: 4.3, mfeP50Pct: 6.1, mfeP75Pct: 9.4 },
  ...over,
});

const snapshot = (cells: Record<string, EquityCell | undefined>): EquityExecutionSnapshot => ({
  generatedAt: 0,
  method: { engine: "test", lookbackYears: 5, maxHoldSessions: 30, costBpsRoundTrip: 10, barsPerYear: 252 },
  coverage: {
    symbols: 120, firstDate: "2008-06-02", lastDate: "2026-08-13",
    sessionsEvaluated: 4570, plansPrinted: 100, reachRatePct: 91, trades: 90,
  },
  cells,
  caveats: [],
});

describe("volRegimeFromMetrics", () => {
  /*
   * The live evaluator INVERTS the usual mapping — high volatility is the
   * bearish end — so reading it as "bearish means short" would silently
   * bucket every trade wrong. Pinned in both directions.
   */
  it("reads the live volatility verdict with its inverted sign", () => {
    expect(volRegimeFromMetrics([metric("equityVolatilityRegime", "bearish")])).toBe("high-vol");
    expect(volRegimeFromMetrics([metric("equityVolatilityRegime", "bullish")])).toBe("low-vol");
    expect(volRegimeFromMetrics([metric("equityVolatilityRegime", "neutral")])).toBe("normal-vol");
  });

  it("returns null when the engine reported no volatility read at all", () => {
    expect(volRegimeFromMetrics([])).toBeNull();
    expect(volRegimeFromMetrics([metric("somethingElse", "bullish")])).toBeNull();
  });
});

describe("equityExpectationsFor", () => {
  it("maps a live plan onto its measured cell", () => {
    const e = equityExpectationsFor(
      "long",
      [metric("equityVolatilityRegime", "neutral")],
      snapshot({ "long:normal-vol": cell() })
    )!;
    expect(e.cellKey).toBe("long:normal-vol");
    expect(e.winRatePct).toBeCloseTo(42.9, 5);
    expect(e.evLowerPct).toBeCloseTo(0.95, 5);
    expect(e.n).toBe(400);
    // Drawdown is the winners' p80 MAE — what a holder should expect to sit through.
    expect(e.expectedDrawdownPct).toBeCloseTo(4.3, 5);
    expect(e.expectedRunPct).toBeCloseTo(9.4, 5);
    expect(e.medianHoldSessions).toBe(10);
  });

  it("keeps the sides separate — a short never reads a long's record", () => {
    const s = snapshot({ "long:normal-vol": cell() });
    expect(equityExpectationsFor("short", [metric("equityVolatilityRegime", "neutral")], s)).toBeNull();
  });

  /*
   * The whole point of the null path: a bucket the replay refused to publish
   * must produce the dossier's stated absence, never a number borrowed from
   * a neighbouring cell that happens to exist.
   */
  it("refuses to substitute a neighbouring cell when this bucket is unpublished", () => {
    const s = snapshot({ "long:normal-vol": cell(), "long:low-vol": cell({ volRegime: "low-vol" }) });
    expect(equityExpectationsFor("long", [metric("equityVolatilityRegime", "bearish")], s)).toBeNull();
  });

  it("returns null when volatility is unknown, rather than guessing a bucket", () => {
    expect(equityExpectationsFor("long", [], snapshot({ "long:normal-vol": cell() }))).toBeNull();
  });

  it("returns null with no snapshot at all, so an absent file degrades cleanly", () => {
    expect(equityExpectationsFor("long", [metric("equityVolatilityRegime", "neutral")], null)).toBeNull();
  });

  it("degrades the excursion fields alone when winners were too few to describe", () => {
    const e = equityExpectationsFor(
      "long",
      [metric("equityVolatilityRegime", "neutral")],
      snapshot({ "long:normal-vol": cell({ winners: null }) })
    )!;
    // The cell still stands; only the two winner-derived fields fall back.
    expect(e.winRatePct).toBeCloseTo(42.9, 5);
    expect(e.expectedDrawdownPct).toBe(0);
    expect(e.expectedRunPct).toBeNull();
  });
});

describe("equityCellKey", () => {
  it("is the stable side:vol form the replay writes and the page reads", () => {
    expect(equityCellKey("short", "high-vol")).toBe("short:high-vol");
  });
});

describe("equityPlanConstraints — the gate", () => {
  /*
   * The finding this gate exists for. Every replayed short cell lost money
   * beyond the drift it was already fighting, so a short must not reach the
   * page as a plan. Pinned with the real measured shape.
   */
  it("hands the gate a NEGATIVE number for a short, so tradePlan refuses it", () => {
    const short = cell({
      side: "short",
      volRegime: "high-vol",
      evLowerPct: -2.43,
      driftNullPct: -0.68,
      excessEvPct: -1.68,
    });
    const c = equityPlanConstraints(
      "short",
      [metric("equityVolatilityRegime", "bearish")],
      snapshot({ "short:high-vol": short })
    )!;
    // -2.43 - (-0.68) = -1.75: the drift-adjusted pessimistic expectancy.
    expect(c.evLowerPct).toBeCloseTo(-1.75, 5);
    expect(c.evLowerPct).toBeLessThan(0);
    expect(c.cellKey).toBe("short:high-vol");
  });

  it("subtracts the drift null for longs, so the market's own rise is not counted as edge", () => {
    const c = equityPlanConstraints(
      "long",
      [metric("equityVolatilityRegime", "neutral")],
      snapshot({ "long:normal-vol": cell({ evLowerPct: 1.21, driftNullPct: 0.83 }) })
    )!;
    expect(c.evLowerPct).toBeCloseTo(0.38, 5);
    expect(c.evLowerPct).toBeGreaterThan(0); // still passes the gate
  });

  it("falls back to the raw bound when no drift null was measured", () => {
    const c = equityPlanConstraints(
      "long",
      [metric("equityVolatilityRegime", "neutral")],
      snapshot({ "long:normal-vol": cell({ evLowerPct: 0.95, driftNullPct: null }) })
    )!;
    expect(c.evLowerPct).toBeCloseTo(0.95, 5);
  });

  it("carries the winners' excursions so stops and targets are shaped by measurement", () => {
    const c = equityPlanConstraints(
      "long",
      [metric("equityVolatilityRegime", "neutral")],
      snapshot({ "long:normal-vol": cell() })
    )!;
    expect(c.winnersMaeP80Pct).toBeCloseTo(4.3, 5);
    expect(c.winnersMfeP75Pct).toBeCloseTo(9.4, 5);
    expect(c.n).toBe(400);
  });

  it("returns null with no cell, so an ungated plan builds exactly as before", () => {
    expect(
      equityPlanConstraints("long", [metric("equityVolatilityRegime", "bearish")], snapshot({}))
    ).toBeNull();
    expect(equityPlanConstraints("long", [], snapshot({ "long:normal-vol": cell() }))).toBeNull();
  });
});

/**
 * COHORT SELECTION. The replay universe pools 95 operating companies with 30
 * index/sector funds, and a fund is a weighted average of its holdings — less
 * idiosyncratic volatility, different mean reversion. These pin the rule that
 * a stock is never quoted a fund's number, including the failure mode that
 * existed before the split: an unfiltered `matches[0]` handing back whichever
 * cohort happened to be first in the array.
 */
describe("reachRateFor — cohort", () => {
  const reachCell = (over: Partial<ReachCell>): ReachCell => ({
    source: "zone",
    distanceAtrMax: 1,
    touchesMin: 0,
    attempts: 5_000,
    reached: 2_500,
    reachRatePct: 50,
    medianSessionsToReach: 4,
    ...over,
  });

  const withReach = (reach: ReachCell[]): EquityExecutionSnapshot =>
    ({ ...snapshot({}), reach }) as EquityExecutionSnapshot;

  const split = withReach([
    reachCell({ kind: "all", reachRatePct: 60 }),
    reachCell({ kind: "company", reachRatePct: 55 }),
    reachCell({ kind: "fund", reachRatePct: 90 }),
  ]);

  it("quotes the pooled table by default, so existing callers are unchanged", () => {
    expect(reachRateFor(0.9, 0, split, "zone")!.reachRatePct).toBe(60);
  });

  it("quotes each cohort's own rate when asked", () => {
    expect(reachRateFor(0.9, 0, split, "zone", "company")!.reachRatePct).toBe(55);
    expect(reachRateFor(0.9, 0, split, "zone", "fund")!.reachRatePct).toBe(90);
  });

  /*
   * The regression. Funds are listed FIRST here, so any lookup that filtered
   * on bucket alone and took the first match would hand a single stock the
   * index's 90% — a wrong number that looks perfectly reasonable.
   */
  it("never falls through to the other cohort when one is ordered first", () => {
    const fundsFirst = withReach([
      reachCell({ kind: "fund", reachRatePct: 90 }),
      reachCell({ kind: "company", reachRatePct: 55 }),
      reachCell({ kind: "all", reachRatePct: 60 }),
    ]);
    expect(reachRateFor(0.9, 0, fundsFirst, "zone", "company")!.reachRatePct).toBe(55);
  });

  /*
   * A cohort thin enough that no bucket published falls back to POOLED, never
   * to the sibling: the blend is a worse answer than the matching population
   * and a better one than the opposite population.
   */
  it("falls back to pooled, not to the sibling cohort, when a cohort is absent", () => {
    const noCompanyCells = withReach([
      reachCell({ kind: "all", reachRatePct: 60 }),
      reachCell({ kind: "fund", reachRatePct: 90 }),
    ]);
    expect(reachRateFor(0.9, 0, noCompanyCells, "zone", "company")!.reachRatePct).toBe(60);
  });

  /* Records written before the split carry no `kind` and must read as pooled. */
  it("treats untagged legacy cells as the pooled population", () => {
    const legacy = withReach([reachCell({ reachRatePct: 71 })]);
    expect(reachRateFor(0.9, 0, legacy, "zone")!.reachRatePct).toBe(71);
    expect(reachRateFor(0.9, 0, legacy, "zone", "company")!.reachRatePct).toBe(71);
  });
});
