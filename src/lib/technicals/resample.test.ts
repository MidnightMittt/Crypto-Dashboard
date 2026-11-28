import { describe, it, expect } from "vitest";
import { resampleToWeekly, resampleToMonthly, weekStartUtc, monthStartUtc } from "./resample";
import { Candle } from "./indicators";

/**
 * Fixtures are anchored to 2024-01-01, which is a MONDAY — so the first weekly
 * bucket is exactly Jan 1-7 and every assertion below can be checked by hand
 * against a calendar rather than against whatever the implementation produces.
 */
const DAY = 86_400_000;
const d = (iso: string) => Date.parse(iso + "T00:00:00Z");

/** One daily bar. `v` defaults so volume assertions stay readable. */
function bar(iso: string, open: number, high: number, low: number, close: number, v = 1): Candle {
  return { t: d(iso), open, high, low, close, volumeUsd: v };
}

/** n consecutive daily bars from `startIso`, close = index, so order is visible. */
function series(startIso: string, n: number): Candle[] {
  const t0 = d(startIso);
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * DAY, open: i, high: i + 1, low: i - 1, close: i, volumeUsd: 1,
  }));
}

describe("period keys", () => {
  it("anchors weeks to Monday UTC", () => {
    // 2024-01-03 is a Wednesday; its week begins Monday 2024-01-01.
    expect(weekStartUtc(d("2024-01-03"))).toBe(d("2024-01-01"));
    // 2024-01-07 is a Sunday — still the SAME week, not the next one.
    expect(weekStartUtc(d("2024-01-07"))).toBe(d("2024-01-01"));
    // 2024-01-08 is the next Monday.
    expect(weekStartUtc(d("2024-01-08"))).toBe(d("2024-01-08"));
  });

  it("anchors months to the 1st UTC", () => {
    expect(monthStartUtc(d("2024-03-17"))).toBe(d("2024-03-01"));
    expect(monthStartUtc(d("2024-03-01"))).toBe(d("2024-03-01"));
  });
});

describe("resampleToWeekly", () => {
  it("builds one completed weekly bar from a full week, with correct OHLCV", () => {
    // Mon..Sun = 7 bars, plus one bar in the NEXT week so the first is provably complete.
    const daily = [
      bar("2024-01-01", 10, 12, 9, 11, 100),
      bar("2024-01-02", 11, 15, 10, 14, 100),
      bar("2024-01-03", 14, 14, 6, 7, 100),   // the week's LOW
      bar("2024-01-04", 7, 20, 7, 19, 100),   // the week's HIGH
      bar("2024-01-05", 19, 19, 17, 18, 100),
      bar("2024-01-06", 18, 18, 16, 17, 100),
      bar("2024-01-07", 17, 18, 16, 16, 100), // the week's CLOSE
      bar("2024-01-08", 16, 16, 15, 15, 100), // next week — makes week 1 complete
    ];
    const r = resampleToWeekly(daily);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]).toEqual({
      t: d("2024-01-01"), open: 10, high: 20, low: 6, close: 16, volumeUsd: 700,
    });
    expect(r.droppedIncomplete).toBe(1); // the Jan 8 week is still forming
  });

  it("DROPS the still-forming final week — the look-ahead guard", () => {
    // Three days into a week. That is not a weekly candle.
    const r = resampleToWeekly(series("2024-01-01", 3));
    expect(r.candles).toHaveLength(0);
    expect(r.droppedIncomplete).toBe(1);
  });

  it("never emits a bar whose period has not closed, even with a long history", () => {
    // 7 full weeks + 2 days. Expect 7 completed, the partial dropped.
    const r = resampleToWeekly(series("2024-01-01", 7 * 7 + 2));
    expect(r.candles).toHaveLength(7);
    expect(r.droppedIncomplete).toBe(1);
    const last = r.candles[r.candles.length - 1];
    expect(last.t).toBe(d("2024-02-12")); // 7th Monday
  });
});

describe("resampleToMonthly", () => {
  it("builds completed months and drops the forming one", () => {
    // All of January plus one February bar: January closes, February forms.
    const jan = series("2024-01-01", 31);
    const daily = [...jan, bar("2024-02-01", 99, 99, 99, 99, 5)];
    const r = resampleToMonthly(daily);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0].t).toBe(d("2024-01-01"));
    expect(r.candles[0].close).toBe(30); // last January bar's close
    expect(r.droppedIncomplete).toBe(1);
  });
});

describe("data hygiene", () => {
  it("sorts out-of-order input before bucketing", () => {
    const week = series("2024-01-01", 7);
    const shuffled = [week[3], week[0], week[6], week[1], week[5], week[2], week[4]];
    const withNext = [...shuffled, bar("2024-01-08", 0, 0, 0, 0)];
    const r = resampleToWeekly(withNext);
    // open must come from Jan 1 and close from Jan 7 regardless of input order
    expect(r.candles[0].open).toBe(0);
    expect(r.candles[0].close).toBe(6);
  });

  it("deduplicates repeated timestamps, keeping the later copy", () => {
    const week = series("2024-01-01", 7);
    const revised = { ...week[6], close: 999 };
    const r = resampleToWeekly([...week, revised, bar("2024-01-08", 0, 0, 0, 0)]);
    expect(r.deduped).toBe(1);
    expect(r.candles[0].close).toBe(999);
    expect(r.candles[0].volumeUsd).toBe(7); // the dupe must NOT be added twice
  });

  it("counts a short week as partial without dropping it", () => {
    // 4 trading days then the next week starts — a holiday week, genuinely 4 bars.
    const daily = [
      bar("2024-01-01", 1, 1, 1, 1), bar("2024-01-02", 2, 2, 2, 2),
      bar("2024-01-03", 3, 3, 3, 3), bar("2024-01-04", 4, 4, 4, 4),
      bar("2024-01-08", 5, 5, 5, 5), bar("2024-01-15", 6, 6, 6, 6),
    ];
    const r = resampleToWeekly(daily);
    expect(r.candles.length).toBeGreaterThanOrEqual(1);
    expect(r.partialPeriods).toBeGreaterThanOrEqual(1);
  });

  it("detects missing periods between present ones", () => {
    // Weeks present: Jan 1, Jan 29, Feb 5 (all Mondays — Jan 1 2024 is a Monday).
    // Absent between them: Jan 8, Jan 15, Jan 22 = THREE missing weeks.
    const daily = [
      ...series("2024-01-01", 7),
      ...series("2024-01-29", 7),
      bar("2024-02-05", 0, 0, 0, 0),
    ];
    const r = resampleToWeekly(daily);
    expect(r.missingPeriods).toBe(3);
  });

  it("returns an empty report for empty input", () => {
    expect(resampleToWeekly([]).candles).toHaveLength(0);
    expect(resampleToMonthly([]).candles).toHaveLength(0);
  });
});

describe("LOOK-AHEAD PROPERTY — the decisive test", () => {
  /**
   * If resampling leaked the future, a bar computed from a SHORT prefix would
   * differ from the same bar computed from the FULL series. Walking every
   * prefix and demanding byte-identical overlap is a much stronger statement
   * than any single hand-built fixture: it says the function's output for a
   * given period depends only on data from that period and earlier.
   */
  it("every completed bar is identical whether computed from a prefix or the full series", () => {
    const full = series("2024-01-01", 200);
    for (const fn of [resampleToWeekly, resampleToMonthly]) {
      const all = fn(full).candles;
      for (let k = 40; k < full.length; k += 7) {
        const prefix = fn(full.slice(0, k)).candles;
        for (const p of prefix) {
          const match = all.find((c) => c.t === p.t);
          expect(match, `period ${new Date(p.t).toISOString()} vanished from the full series`).toBeDefined();
          expect(match).toEqual(p);
        }
      }
    }
  });

  it("a forming period never appears in any prefix", () => {
    const full = series("2024-01-01", 100);
    for (let k = 10; k < full.length; k++) {
      const out = resampleToWeekly(full.slice(0, k)).candles;
      const lastBarT = full[k - 1].t;
      for (const c of out) {
        // every emitted weekly bar must have fully closed before the newest daily bar
        expect(c.t + 7 * DAY).toBeLessThanOrEqual(lastBarT + DAY);
      }
    }
  });
});
