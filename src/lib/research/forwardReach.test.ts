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
  sessionsObserved: 0,
  windowComplete: false,
  ...over,
});

/** A settled row: outcome known AND window closed, so it counts. */
const settled = (reached: boolean, over: Partial<ReachPrediction> = {}): ReachPrediction =>
  pred({ reached, sessionsObserved: 10, windowComplete: true, ...over });

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
    expect(out[0].windowComplete).toBe(false);
  });

  /*
   * THE MIRROR, and the test that was missing when this shipped. The hit
   * above is REAL — price traded the level on session 3 — but its window is
   * four sessions old out of ten, and the misses registered the same day
   * cannot possibly have appeared yet. Marking it complete here is what
   * produced a published 38/38 = 100.0%.
   */
  it("does NOT complete a window just because the level was hit early", () => {
    const out = resolvePredictions([pred()], () => bars([95, 93, 89, 92]));
    expect(out[0].reached).toBe(true);
    expect(out[0].windowComplete).toBe(false);
    expect(out[0].sessionsObserved).toBe(4);
  });

  it("completes the window of an early hit once the full horizon exists", () => {
    const early = pred({ reached: true, sessionsToReach: 3, resolvedDate: "2026-08-19", sessionsObserved: 4 });
    const out = resolvePredictions([early], () => bars([95, 93, 89, 92, 92, 92, 92, 92, 92, 92, 92]));
    expect(out[0].windowComplete).toBe(true);
    expect(out[0].sessionsObserved).toBe(10);
    // The observation itself is untouched — only its admission to the sample changed.
    expect(out[0].sessionsToReach).toBe(3);
    expect(out[0].resolvedDate).toBe("2026-08-19");
  });

  it("records a miss only once the full window exists", () => {
    const out = resolvePredictions([pred()], () => bars([95, 96, 97, 98, 99, 100, 101, 102, 103, 104]));
    expect(out[0].reached).toBe(false);
    expect(out[0].sessionsToReach).toBeNull();
    expect(out[0].windowComplete).toBe(true);
  });

  it("reads a short's level against the HIGH, not the low", () => {
    const short = pred({ direction: "short", level: 99 });
    // highs are low+5, so a low of 95 gives a high of 100 -> touches 99.
    const out = resolvePredictions([short], () => bars([90, 95]));
    expect(out[0].reached).toBe(true);
    expect(out[0].sessionsToReach).toBe(2);
  });

  it("never re-reads a window that has closed", () => {
    const done = settled(false, { resolvedDate: "2026-08-28" });
    const out = resolvePredictions([done], () => bars([1, 1, 1]));
    expect(out[0].reached).toBe(false);
    expect(out[0].resolvedDate).toBe("2026-08-28");
  });

  /*
   * A revised bar cannot un-hit a level that demonstrably traded. Settled
   * rows are frozen outright; an open row that already hit keeps its hit.
   */
  it("keeps an open row's recorded hit even if later bars would not produce it", () => {
    const early = pred({ reached: true, sessionsToReach: 1, resolvedDate: "2026-08-17" });
    const out = resolvePredictions([early], () => bars([200, 200, 200]));
    expect(out[0].reached).toBe(true);
    expect(out[0].sessionsToReach).toBe(1);
  });
});

describe("summarise", () => {
  it("reports predicted against observed, and counts only completed windows", () => {
    const rows: ReachPrediction[] = [
      ...Array.from({ length: 20 }, () => settled(true, { predictedPct: 50 })),
      ...Array.from({ length: 20 }, () => settled(false, { predictedPct: 50 })),
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

  /*
   * THE REGRESSION. This is 2026-08-16's record in miniature: a young cohort
   * in which the only observable outcomes so far are hits, because a miss
   * takes the full ten sessions to become one. The honest report is "nothing
   * measured yet, 38 already touching" — NOT 100%.
   */
  it("refuses to score a young cohort whose only visible outcomes are hits", () => {
    const rows = Array.from({ length: 38 }, (_, i) =>
      pred({ symbol: `S${i}`, reached: true, sessionsToReach: 2, sessionsObserved: 3 })
    );
    const { calibration, totals } = summarise(rows);
    expect(totals.resolved).toBe(0);
    expect(totals.reached).toBe(0);
    expect(totals.observedPct).toBeNull();
    expect(calibration).toHaveLength(0);
    // Reported, not hidden — and clearly labelled as not-yet-counted.
    expect(totals.open).toBe(38);
    expect(totals.openReached).toBe(38);
  });

  it("separates open rows that have hit from open rows still waiting", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => pred({ reached: true, sessionsObserved: 2 })),
      ...Array.from({ length: 6 }, () => pred({ sessionsObserved: 2 })),
      settled(true),
    ];
    const { totals } = summarise(rows);
    expect(totals.open).toBe(10);
    expect(totals.openReached).toBe(4);
    expect(totals.resolved).toBe(1);
  });

  it("publishes no cell below the minimum sample, rather than a noisy one", () => {
    const rows = Array.from({ length: 12 }, () => settled(true));
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
  it("drops the oldest CLOSED windows first and never an open one", () => {
    const open = Array.from({ length: 5 }, (_, i) => pred({ date: `2026-08-${10 + i}`, symbol: `O${i}` }));
    const closed = Array.from({ length: 10 }, (_, i) =>
      settled(true, { date: `2026-07-${10 + i}`, symbol: `C${i}` })
    );
    const out = prune([...closed, ...open], 8);
    expect(out).toHaveLength(8);
    expect(out.filter((p) => !p.windowComplete)).toHaveLength(5);
    // The survivors are the most recent closed rows.
    expect(out.some((p) => p.symbol === "C0")).toBe(false);
    expect(out.some((p) => p.symbol === "C9")).toBe(true);
  });

  it("leaves a record under the cap untouched", () => {
    const rows = Array.from({ length: 5 }, (_, i) => pred({ symbol: `S${i}` }));
    expect(prune(rows, 100)).toHaveLength(5);
  });

  /*
   * An early hit is NOT settled. Dropping it as though it were would remove
   * exactly the rows whose cohort-mates are still-pending misses, censoring
   * the sample from the other end.
   */
  it("treats an already-hit but unfinished window as open", () => {
    const openHits = Array.from({ length: 5 }, (_, i) =>
      pred({ date: `2026-08-${10 + i}`, symbol: `H${i}`, reached: true, sessionsToReach: 1 })
    );
    const closed = Array.from({ length: 10 }, (_, i) =>
      settled(true, { date: `2026-07-${10 + i}`, symbol: `C${i}` })
    );
    const out = prune([...closed, ...openHits], 8);
    expect(out.filter((p) => !p.windowComplete)).toHaveLength(5);
    expect(out.filter((p) => p.symbol.startsWith("H"))).toHaveLength(5);
  });
});
