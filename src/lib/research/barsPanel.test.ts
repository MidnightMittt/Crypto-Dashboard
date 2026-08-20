import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import { alignPanel, coverage, sessionKey } from "./barsPanel";

const DAY = 86_400_000;
/** 2026-01-05 20:00 UTC — a close-stamped Monday session, like the ingest emits. */
const T0 = Date.UTC(2026, 0, 5, 20);

const bar = (i: number, close: number, volume: number | null = 1000): Bar => ({
  t: T0 + i * DAY,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume,
});

/** Consecutive days at the given closes, skipping indices in `skip`. */
const series = (closes: number[], skip: number[] = []): Bar[] =>
  closes.map((c, i) => bar(i, c)).filter((_, i) => !skip.includes(i));

describe("alignPanel", () => {
  it("matches complete series onto one calendar with no interpolation", () => {
    const p = alignPanel({ A: series([10, 11, 12]), B: series([20, 21, 22]) });
    expect(p.sessions).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
    expect(p.symbols.A.bars[1]).toEqual([11, 12, 10, 11, 1000]);
    expect(p.symbols.A.interpolated).toEqual([]);
    expect(p.symbols.B.interpolated).toEqual([]);
  });

  /*
   * THE FILL, hand-traced. B misses day 1 of 3. Its day-0 close is 20, so the
   * filled row is [20,20,20,20,null] — volume null because zero would be a
   * number a volume filter acts on, and index 1 is flagged.
   */
  it("carries the previous close across an interior gap, flagged, volume null", () => {
    const p = alignPanel({ A: series([10, 11, 12]), B: series([20, 21, 22], [1]) });
    expect(p.sessions).toHaveLength(3);
    expect(p.symbols.B.bars[1]).toEqual([20, 20, 20, 20, null]);
    expect(p.symbols.B.interpolated).toEqual([1]);
    // The real bars either side are untouched.
    expect(p.symbols.B.bars[0]).toEqual([20, 21, 19, 20, 1000]);
    expect(p.symbols.B.bars[2]).toEqual([22, 23, 21, 22, 1000]);
  });

  /*
   * Before listing there is no price to carry — inventing one would put a
   * return where the name did not exist. Null, and NOT flagged: interpolated
   * means "we filled it", and these cells are deliberately empty.
   */
  it("leaves pre-listing sessions null, never interpolated", () => {
    const late = [bar(2, 30), bar(3, 31)];
    const p = alignPanel({ A: series([10, 11, 12, 13]), B: late });
    expect(p.symbols.B.bars[0]).toBeNull();
    expect(p.symbols.B.bars[1]).toBeNull();
    expect(p.symbols.B.bars[2]).toEqual([30, 31, 29, 30, 1000]);
    expect(p.symbols.B.interpolated).toEqual([]);
    expect(coverage(p.symbols.B)).toBe(2);
  });

  /*
   * After a symbol's last bar it may be delisted or its feed dead. Carrying
   * the close forward would quote a live price for a dead name indefinitely.
   */
  it("leaves sessions after the last bar null rather than carrying forward", () => {
    const dead = [bar(0, 30), bar(1, 31)];
    const p = alignPanel({ A: series([10, 11, 12, 13]), B: dead });
    expect(p.symbols.B.bars[2]).toBeNull();
    expect(p.symbols.B.bars[3]).toBeNull();
    expect(p.symbols.B.interpolated).toEqual([]);
  });

  /*
   * THE QUORUM. Three symbols; a fourth date exists in only one series. One
   * of three active names trading (33%) is below the 50% quorum, so that date
   * is not a session — one off-convention series cannot define the calendar
   * for everyone. (Measured cost of the union alternative: a "5-day" hold
   * that was 2 real sessions.)
   */
  it("excludes dates where fewer than half the active symbols traded", () => {
    const offConvention = [...series([30, 31, 32]), bar(3, 33)];
    const p = alignPanel({
      A: series([10, 11, 12]),
      B: series([20, 21, 22]),
      C: offConvention,
    });
    expect(p.sessions).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
    // A and B are past their last bar on day 3, but they still vote: were
    // "active" bounded by each symbol's history, any date past everyone
    // else's would pass on the one series that has it — the same failure at
    // the calendar's tail. Alone, C is its own quorum.
    const solo = alignPanel({ C: offConvention });
    expect(solo.sessions).toHaveLength(4);
  });

  it("keeps only the trailing window of sessions", () => {
    const p = alignPanel({ A: series([1, 2, 3, 4, 5, 6]) }, { sessions: 4 });
    expect(p.sessions).toHaveLength(4);
    expect(p.sessions[0]).toBe("2026-01-07");
    expect(p.symbols.A.bars[0]?.[3]).toBe(3);
  });

  it("rounds prices to 4 decimals and keeps a symbol with no bars visible", () => {
    const p = alignPanel({
      A: [{ ...bar(0, 0.17631111457179163), volume: null }, bar(1, 0.2)],
      EMPTY: [],
    });
    expect(p.symbols.A.bars[0]).toEqual([0.1763, 1.1763, -0.8237, 0.1763, null]);
    expect(p.symbols.EMPTY.bars).toEqual([null, null]);
    expect(coverage(p.symbols.EMPTY)).toBe(0);
  });

  it("keeps the last bar when two share a session", () => {
    const p = alignPanel({ A: [bar(0, 10), { ...bar(0, 99), t: T0 + 3_600_000 }] });
    expect(p.symbols.A.bars[0]?.[3]).toBe(99);
  });
});

describe("sessionKey", () => {
  it("maps a close-stamped bar to its UTC session date", () => {
    expect(sessionKey(T0)).toBe("2026-01-05");
  });
});
