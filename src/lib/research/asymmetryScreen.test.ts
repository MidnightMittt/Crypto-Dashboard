import { describe, expect, it } from "vitest";
import {
  ASYMMETRY_HORIZON_SESSIONS,
  ASYMMETRY_SCREEN_DECLARATION,
  AsymmetryObservation,
  asymmetryRatioOf,
  buildAsymmetryObservations,
  evaluateAsymmetryScreen,
} from "./asymmetryScreen";
import { REACH_HORIZON_SESSIONS } from "./forwardReach";
import type { BarsPanel, PanelRow } from "./barsPanel";
import type { Bar } from "./types";

/**
 * What these tests defend.
 *
 * The record's whole value is the declaration boundary and the refusal to
 * compute early. A forward record that quietly scores backfilled history,
 * or peeks at a result before its gates, is an in-sample study wearing the
 * only kind of clothes this project treats as evidence — so the boundary
 * and the gate get tests before the arithmetic does.
 */

const DECLARED = "2026-01-20";

/** Zigzag closes so both excursion medians exist; high/low straddle close by 1. */
function zigzagBars(n: number, start = 100): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + (i % 2 === 0 ? 0 : 2) + i * 0.05;
    return {
      t: Date.UTC(2026, 0, 1) + i * 86_400_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    };
  });
}

function panelOf(
  symbols: Record<string, { bars: (PanelRow | null)[]; interpolated: number[] }>,
  sessions: string[]
): BarsPanel {
  return {
    version: 1,
    generatedAt: 0,
    sessions,
    fields: ["open", "high", "low", "close", "volume"],
    adjusted: "splits-and-dividends",
    symbols,
  };
}

/** Sessions as ISO dates, one per weekday-ish step, crossing DECLARED at index `boundary`. */
function sessionsAround(boundary: number, total: number): string[] {
  const declaredMs = Date.parse(`${DECLARED}T00:00:00Z`);
  return Array.from({ length: total }, (_, i) =>
    new Date(declaredMs + (i - boundary) * 86_400_000).toISOString().slice(0, 10)
  );
}

function rowsFromBars(bars: Bar[]): PanelRow[] {
  return bars.map((b) => [b.open, b.high, b.low, b.close, b.volume] as PanelRow);
}

describe("declaration", () => {
  it("shares reach's clock by import, not by coincidence", () => {
    expect(ASYMMETRY_HORIZON_SESSIONS).toBe(REACH_HORIZON_SESSIONS);
    expect(ASYMMETRY_SCREEN_DECLARATION.horizonSessions).toBe(REACH_HORIZON_SESSIONS);
  });

  it("forbids citing the two records as independent corroboration, in its own text", () => {
    expect(ASYMMETRY_SCREEN_DECLARATION.corroborationNote).toContain("never");
    expect(ASYMMETRY_SCREEN_DECLARATION.corroborationNote).toContain("one observation, not two");
  });
});

describe("asymmetryRatioOf", () => {
  it("is the screen column's arithmetic exactly", () => {
    /*
     * contractScreen.ts computes: exc.upMedianPct / |exc.downMedianPct|,
     * rounded to 2dp, null unless downMedian < 0. If this drifts from the
     * column, the record starts scoring a cousin of the number the page
     * shows. Pinned against a hand-checkable series.
     */
    const bars = zigzagBars(60);
    const ratio = asymmetryRatioOf(bars);
    expect(ratio).not.toBeNull();
    // The series drifts up 0.05/bar with a symmetric 1-point range, so the
    // up excursion median must exceed the down: ratio > 1.
    expect(ratio!).toBeGreaterThan(1);
    // Two decimal places, as served.
    expect(ratio!).toBe(Math.round(ratio! * 100) / 100);
  });

  it("returns null on too-short history rather than a confident number", () => {
    expect(asymmetryRatioOf(zigzagBars(20))).toBeNull();
  });
});

describe("buildAsymmetryObservations — the boundary and the forward leg", () => {
  const H = ASYMMETRY_HORIZON_SESSIONS;

  it("refuses sessions before the declaration date", () => {
    const total = 70;
    const boundary = 60; // 60 pre-declaration sessions, 10 on/after
    const bars = zigzagBars(total);
    const built = buildAsymmetryObservations(
      panelOf({ AAA: { bars: rowsFromBars(bars), interpolated: [] } }, sessionsAround(boundary, total)),
      DECLARED
    );
    expect(built.sessions.length).toBe(total - boundary);
    for (const o of built.observations) {
      expect(o.session >= DECLARED).toBe(true);
    }
  });

  it("resolves an outcome as up-minus-down over exactly the next horizon", () => {
    const total = 61;
    const boundary = 50;
    const bars = zigzagBars(total);
    // Make the window after the boundary session unambiguous: flat closes,
    // then one big up bar inside the window.
    for (let i = boundary + 1; i < total; i++) {
      bars[i] = { ...bars[i], high: bars[boundary].close + 5, low: bars[boundary].close - 1, close: bars[boundary].close };
    }
    const built = buildAsymmetryObservations(
      panelOf({ AAA: { bars: rowsFromBars(bars), interpolated: [] } }, sessionsAround(boundary, total)),
      DECLARED
    );
    const first = built.observations.find((o) => o.sessionIndex === boundary)!;
    expect(first.status).toBe("resolved");
    const entry = bars[boundary].close;
    const expected = ((5 - 1) / entry) * 100; // up 5/entry, down 1/entry
    expect(first.outcome!).toBeCloseTo(Math.round(expected * 1000) / 1000, 6);
  });

  it("leaves the outcome pending when the bars end inside the window", () => {
    const total = 55;
    const boundary = 50; // only 4 sessions after the first eligible one
    const bars = zigzagBars(total);
    const built = buildAsymmetryObservations(
      panelOf({ AAA: { bars: rowsFromBars(bars), interpolated: [] } }, sessionsAround(boundary, total)),
      DECLARED
    );
    for (const o of built.observations) {
      expect(o.status).toBe("pending");
      expect(o.outcome).toBeNull();
    }
  });

  it("excludes a window containing an interpolated bar, and counts it", () => {
    const total = 65;
    const boundary = 50;
    const bars = zigzagBars(total);
    const sessions = sessionsAround(boundary, total);
    const built = buildAsymmetryObservations(
      panelOf(
        { AAA: { bars: rowsFromBars(bars), interpolated: [boundary + 3] } },
        sessions
      ),
      DECLARED
    );
    const tainted = built.observations.find((o) => o.sessionIndex === boundary)!;
    expect(tainted.status).toBe("excluded_interpolated");
    expect(tainted.outcome).toBeNull();
    expect(built.excludedInterpolatedBySession[sessions[boundary]]).toBeGreaterThanOrEqual(1);
    // A later session whose window clears the fill resolves normally.
    const clear = built.observations.find((o) => o.sessionIndex === boundary + 4 && o.status === "resolved");
    expect(clear).toBeDefined();
  });

  it(`needs ${H} sessions beyond the observation, not ${H - 1}`, () => {
    const total = 51 + H;
    const boundary = 50;
    const bars = zigzagBars(total);
    const built = buildAsymmetryObservations(
      panelOf({ AAA: { bars: rowsFromBars(bars), interpolated: [] } }, sessionsAround(boundary, total)),
      DECLARED
    );
    const atBoundary = built.observations.find((o) => o.sessionIndex === boundary)!;
    expect(atBoundary.status).toBe("resolved");
    const oneLater = built.observations.find((o) => o.sessionIndex === boundary + 1)!;
    expect(oneLater.status).toBe("pending");
  });
});

describe("evaluateAsymmetryScreen — gates before numbers", () => {
  function obs(
    sessionIndex: number,
    symbol: string,
    ratio: number,
    outcome: number | null,
    status: AsymmetryObservation["status"] = outcome === null ? "pending" : "resolved",
    /*
     * Dated AFTER declaredOn (2026-09-14), or the evaluator refuses the row
     * — the first draft of these fixtures used February dates and every
     * assertion failed with resolved=0, which is the boundary doing its job
     * against this test's own accidental backfill.
     */
    session = new Date(Date.UTC(2026, 9, 1) + sessionIndex * 86_400_000)
      .toISOString()
      .slice(0, 10)
  ): AsymmetryObservation {
    return { session, sessionIndex, symbol, ratio, outcome, status };
  }

  /** `count` sessions of `width` names each, spaced a full horizon apart. */
  function syntheticResolved(count: number, width: number, sign: 1 | -1): AsymmetryObservation[] {
    const out: AsymmetryObservation[] = [];
    for (let s = 0; s < count; s++) {
      for (let k = 0; k < width; k++) {
        const ratio = 0.5 + k * 0.25 + s * 0.01;
        out.push(obs(s * ASYMMETRY_HORIZON_SESSIONS, `S${k}`, ratio, sign * ratio * 2));
      }
    }
    return out;
  }

  it("computes nothing before the gates — not even privately", () => {
    // 3 windows of 25 names = 75 resolved: rows gate AND windows gate unmet.
    const standing = evaluateAsymmetryScreen({ observations: syntheticResolved(3, 25, 1) });
    expect(standing.result).toBeNull();
    expect(standing.verdict).toBe("waiting");
    expect(standing.independentWindows).toBe(3);
    expect(standing.reading).toContain("Waiting");
  });

  it("refuses pre-declaration rows and says so, loudly", () => {
    const backfilled = syntheticResolved(4, 25, 1).map((o) => ({
      ...o,
      session: "2020-01-05", // long before declaredOn
    }));
    const standing = evaluateAsymmetryScreen({ observations: backfilled });
    expect(standing.preDeclarationRows).toBe(100);
    expect(standing.resolved).toBe(0);
    expect(standing.result).toBeNull();
    expect(standing.reading).toContain("refused");
  });

  it("survives on the predicted sign with the interval clear of zero", () => {
    const standing = evaluateAsymmetryScreen({ observations: syntheticResolved(4, 25, 1) });
    expect(standing.gates.every((g) => g.met)).toBe(true);
    expect(standing.result).not.toBeNull();
    expect(standing.result!.correlation).toBeGreaterThan(0.9);
    expect(standing.result!.signAsPredicted).toBe(true);
    expect(standing.verdict).toBe("survives");
    expect(standing.reading).toContain("PROPOSED");
  });

  it("lands inside-noise on a significant WRONG sign, not survives", () => {
    /*
     * The subtle failure: a strongly negative correlation also excludes
     * zero, and a gate that only checked the interval would call it a
     * survivor. The declaration predicted +1; the opposite sign is a kill,
     * however significant.
     */
    const standing = evaluateAsymmetryScreen({ observations: syntheticResolved(4, 25, -1) });
    expect(standing.result).not.toBeNull();
    expect(standing.result!.correlation).toBeLessThan(-0.9);
    expect(standing.result!.containsZero).toBe(false);
    expect(standing.verdict).toBe("inside-noise");
    expect(standing.reading).toContain("never proposed");
  });

  it("counts overlapping sessions as fewer windows than sessions", () => {
    // 8 sessions ONE index apart: 80+ rows but overlapping windows.
    const out: AsymmetryObservation[] = [];
    for (let s = 0; s < 8; s++) {
      for (let k = 0; k < 15; k++) {
        out.push(obs(s, `S${k}`, 0.5 + k * 0.3, (0.5 + k * 0.3) * 2));
      }
    }
    const standing = evaluateAsymmetryScreen({ observations: out });
    expect(standing.resolved).toBe(120);
    expect(standing.independentWindows).toBe(1);
    expect(standing.result).toBeNull();
  });
});
