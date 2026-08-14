import { describe, expect, it } from "vitest";
import {
  ReachPrediction,
  SessionBar,
  prune,
  registerPredictions,
  resolvePredictions,
  summarise,
} from "./forwardReach";

const pred = (over: Partial<ReachPrediction> = {}): ReachPrediction => ({
  date: "2026-08-14",
  symbol: "AMD",
  direction: "long",
  level: 90,
  distanceAtr: 1.2,
  distanceAtrMax: 2,
  touchesMin: 0,
  predictedPct: 48.4,
  reached: null,
  sessionsToReach: null,
  resolvedDate: null,
  ...over,
});

const bars = (lows: number[]): SessionBar[] =>
  lows.map((low, i) => ({ t: Date.UTC(2026, 7, 17 + i), high: low + 5, low }));

describe("registerPredictions", () => {
  it("is idempotent per day, symbol and side — a re-run cannot stuff the sample", () => {
    const first = registerPredictions([], [pred(), pred()]);
    expect(first).toHaveLength(1);
    const again = registerPredictions(first, [pred({ level: 91 })]);
    expect(again).toHaveLength(1);
    expect(again[0].level).toBe(91);
  });

  it("keeps both sides of the same day", () => {
    const out = registerPredictions([], [pred(), pred({ direction: "short", level: 110 })]);
    expect(out).toHaveLength(2);
  });

  /*
   * The rule that stops the record being rewritten: once a prediction has
   * been scored it is history, and a later re-run of the daily job must not
   * be able to replace it with a fresh unresolved one.
   */
  it("refuses to overwrite an already-resolved prediction", () => {
    const resolved = pred({ reached: true, sessionsToReach: 3, resolvedDate: "2026-08-19" });
    const out = registerPredictions([resolved], [pred({ predictedPct: 99 })]);
    expect(out).toHaveLength(1);
    expect(out[0].reached).toBe(true);
    expect(out[0].predictedPct).toBe(48.4);
  });
});

describe("resolvePredictions", () => {
  it("records a hit the session price trades the level", () => {
    const out = resolvePredictions([pred()], () => bars([95, 93, 89, 92]));
    expect(out[0].reached).toBe(true);
    expect(out[0].sessionsToReach).toBe(3);
    expect(out[0].resolvedDate).toBe("2026-08-19");
  });

  /*
   * THE BIAS THIS PREVENTS. Calling a not-yet-reached level a miss before
   * its window is over would push every bucket's observed rate below the
   * truth, and the error would grow with how recently the prediction was
   * made — a systematic, one-directional distortion.
   */
  it("leaves a prediction OPEN when the horizon has not fully elapsed", () => {
    const out = resolvePredictions([pred()], () => bars([95, 96, 97]));
    expect(out[0].reached).toBeNull();
    expect(out[0].resolvedDate).toBeNull();
  });

  it("records a miss only once the full window exists", () => {
    const out = resolvePredictions([pred()], () => bars([95, 96, 97, 98, 99, 100, 101, 102, 103, 104]));
    expect(out[0].reached).toBe(false);
    expect(out[0].sessionsToReach).toBeNull();
  });

  it("reads a short's level against the HIGH, not the low", () => {
    const short = pred({ direction: "short", level: 99 });
    // highs are low+5, so a low of 95 gives a high of 100 -> touches 99.
    const out = resolvePredictions([short], () => bars([90, 95]));
    expect(out[0].reached).toBe(true);
    expect(out[0].sessionsToReach).toBe(2);
  });

  it("never re-resolves a prediction that already has an answer", () => {
    const done = pred({ reached: false, resolvedDate: "2026-08-28" });
    const out = resolvePredictions([done], () => bars([1, 1, 1]));
    expect(out[0].reached).toBe(false);
    expect(out[0].resolvedDate).toBe("2026-08-28");
  });
});

describe("summarise", () => {
  it("reports predicted against observed, and counts only resolved rows", () => {
    const rows: ReachPrediction[] = [
      ...Array.from({ length: 20 }, () => pred({ reached: true, predictedPct: 50 })),
      ...Array.from({ length: 20 }, () => pred({ reached: false, predictedPct: 50 })),
      // Still open — must not count either way.
      ...Array.from({ length: 50 }, () => pred()),
    ];
    const { calibration, totals } = summarise(rows);
    expect(totals.resolved).toBe(40);
    expect(totals.reached).toBe(20);
    expect(totals.observedPct).toBeCloseTo(50, 5);
    expect(totals.predictedPct).toBeCloseTo(50, 5);
    expect(calibration).toHaveLength(1);
    expect(calibration[0].resolved).toBe(40);
  });

  it("publishes no cell below the minimum sample, rather than a noisy one", () => {
    const rows = Array.from({ length: 12 }, () => pred({ reached: true }));
    const { calibration, totals } = summarise(rows);
    expect(calibration).toHaveLength(0);
    // Totals still count them: the headline is honest even when no cell qualifies.
    expect(totals.resolved).toBe(12);
  });

  it("reports null rates with nothing resolved, rather than a fabricated zero", () => {
    const { totals } = summarise([pred(), pred({ symbol: "NVDA" })]);
    expect(totals.resolved).toBe(0);
    expect(totals.observedPct).toBeNull();
    expect(totals.predictedPct).toBeNull();
  });
});

describe("prune", () => {
  it("drops the oldest RESOLVED rows first and never an open one", () => {
    const open = Array.from({ length: 5 }, (_, i) => pred({ date: `2026-08-${10 + i}`, symbol: `O${i}` }));
    const closed = Array.from({ length: 10 }, (_, i) =>
      pred({ date: `2026-07-${10 + i}`, symbol: `C${i}`, reached: true })
    );
    const out = prune([...closed, ...open], 8);
    expect(out).toHaveLength(8);
    expect(out.filter((p) => p.reached === null)).toHaveLength(5);
    // The survivors are the most recent closed rows.
    expect(out.some((p) => p.symbol === "C0")).toBe(false);
    expect(out.some((p) => p.symbol === "C9")).toBe(true);
  });

  it("leaves a record under the cap untouched", () => {
    const rows = Array.from({ length: 5 }, (_, i) => pred({ symbol: `S${i}` }));
    expect(prune(rows, 100)).toHaveLength(5);
  });
});
