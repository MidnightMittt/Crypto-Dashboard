import { describe, expect, it } from "vitest";
import {
  EquityCell,
  EquityExecutionSnapshot,
  equityCellKey,
  equityExpectationsFor,
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
