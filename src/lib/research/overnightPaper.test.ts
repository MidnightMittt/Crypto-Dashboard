import { describe, expect, it } from "vitest";
import { BarsPanel, PanelRow } from "./barsPanel";
import { SpreadObservation, spreadBp } from "../history/spreadHistory";
import { BP, buildPaperRecord, fingerprintDeclaration } from "./paperEngine";
import {
  MARK_MINUTE,
  MARK_TO_OPEN_DECLARATION,
  closeToOpenDeclaration,
  closeToOpenSessions,
  markDrag,
  markToOpenSessions,
  panelBars,
} from "./overnightPaper";

/**
 * Every failure guarded here produces a plausible number rather than an
 * error: a carried-forward fill priced as a flat night, a mark with no exit
 * session counted as a zero, a basket averaged after the statistics instead
 * of before, and a drag compared unpaired so the market move swamps it.
 */

const SESSIONS = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];

/** open, high, low, close, volume. */
const row = (open: number, close: number): PanelRow => [open, Math.max(open, close), Math.min(open, close), close, 1_000];

function panel(
  symbols: Record<string, { bars: (PanelRow | null)[]; interpolated?: number[] }>,
  sessions = SESSIONS
): BarsPanel {
  return {
    version: 1,
    generatedAt: 0,
    sessions,
    fields: ["open", "high", "low", "close", "volume"],
    adjusted: "splits-and-dividends",
    symbols: Object.fromEntries(
      Object.entries(symbols).map(([s, v]) => [s, { bars: v.bars, interpolated: v.interpolated ?? [] }])
    ),
  };
}

/** A flat $100 name: every session opens and closes at 100. */
const FLAT: (PanelRow | null)[] = SESSIONS.map(() => row(100, 100));

const quote = (
  session: string,
  symbol: string,
  bid: number,
  ask: number,
  over: Partial<SpreadObservation> = {}
): SpreadObservation => ({
  t: `${session}T19:50:00.000Z`,
  session,
  symbol,
  window: "entry",
  targetMinute: MARK_MINUTE,
  bid,
  ask,
  mid: (bid + ask) / 2,
  spreadBp: spreadBp(bid, ask),
  last: (bid + ask) / 2,
  bidSize: 100,
  askSize: 100,
  imbalance: 0,
  ...over,
});

describe("panelBars", () => {
  it("carries open and close through for a real session", () => {
    const bars = panelBars(panel({ AAA: { bars: [row(99, 101), ...FLAT.slice(1)] } }), "AAA");
    expect(bars[0].open).toBe(99);
    expect(bars[0].close).toBe(101);
  });

  /*
   * THE FILL. A carried-forward session repeats the previous close in all four
   * price fields. Left in, it invents a 0bp night INTO the fill and folds a
   * genuine two-day move into the one night OUT of it — two fabricated
   * observations from one absent session, and they point opposite ways.
   */
  it("zeroes an interpolated session so BOTH its nights are dropped", () => {
    const p = panel({ AAA: { bars: FLAT, interpolated: [2] } });
    const bars = panelBars(p, "AAA");
    expect(bars[2]).toEqual({ t: Date.parse("2026-08-19T00:00:00Z"), open: 0, high: 0, low: 0, close: 0, volume: 0 });
    // ...and the observations that would have used it are gone, rather than
    // the neighbours being spliced into one two-night return.
    const dates = closeToOpenSessions(p, ["AAA"]).map((s) => s.date);
    expect(dates).not.toContain("2026-08-19"); // into the fill
    expect(dates).not.toContain("2026-08-20"); // out of the fill
    expect(dates).toContain("2026-08-18");
  });

  it("zeroes a null row rather than reading undefined prices", () => {
    const bars = panelBars(panel({ AAA: { bars: [null, ...FLAT.slice(1)] } }), "AAA");
    expect(bars[0].close).toBe(0);
  });

  it("is empty for a symbol the panel does not carry", () => {
    expect(panelBars(panel({ AAA: { bars: FLAT } }), "ZZZ")).toEqual([]);
  });
});

describe("closeToOpenSessions", () => {
  it("prices prior close to next open", () => {
    // Closes 100 throughout; session 1 opens at 101 -> +100bp overnight.
    const bars = [...FLAT];
    bars[1] = row(101, 100);
    const s = closeToOpenSessions(panel({ AAA: { bars } }), ["AAA"]);
    const night = s.find((x) => x.date === "2026-08-18")!;
    expect(night.grossBp).toBeCloseTo(100, 6);
    // One tick on a $100 name is 1bp.
    expect(night.costBp).toBeCloseTo(1, 6);
    expect(night.netBp).toBeCloseTo(99, 6);
  });

  /*
   * THE BASKET IS ONE BET. Averaging within a date before the statistics is
   * the difference between n=4 nights and n=8 name-nights, and pooling the
   * second inflated t by about 40% when it was measured on this cohort.
   */
  it("averages names within a date and reports the count, never the sample size", () => {
    const up = [...FLAT];
    up[1] = row(102, 100); // +200bp
    const flat2 = [...FLAT]; // 0bp
    const s = closeToOpenSessions(panel({ AAA: { bars: up }, BBB: { bars: flat2 } }), ["AAA", "BBB"]);
    const night = s.find((x) => x.date === "2026-08-18")!;
    expect(night.names).toBe(2);
    expect(night.grossBp).toBeCloseTo(100, 6); // the mean of 200 and 0
    // One PaperSession per DATE, not per name-date.
    expect(s.filter((x) => x.date === "2026-08-18")).toHaveLength(1);
  });

  it("turns over fully every night, which is what makes breakeven bite", () => {
    const s = closeToOpenSessions(panel({ AAA: { bars: FLAT } }), ["AAA"]);
    expect(s.every((x) => x.turnover === 1)).toBe(true);
  });

  it("ignores a symbol the panel does not carry rather than refusing the basket", () => {
    const s = closeToOpenSessions(panel({ AAA: { bars: FLAT } }), ["AAA", "NOPE"]);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.names === 1)).toBe(true);
  });
});

describe("markToOpenSessions", () => {
  /*
   * The arithmetic, pinned. Buy the ask at 15:50, sell the next auction print.
   * gross marks at the mid so the difference IS the half-spread, measured.
   */
  it("buys the 15:50 ask and sells the next open", () => {
    const bars = [...FLAT];
    bars[2] = row(101, 100); // 2026-08-19 opens at 101
    const s = markToOpenSessions(
      panel({ AAA: { bars } }),
      ["AAA"],
      [quote("2026-08-18", "AAA", 99.99, 100.01)]
    );
    expect(s).toHaveLength(1);
    const night = s[0];
    expect(night.date).toBe("2026-08-19"); // dated by the session it RESOLVES on
    expect(night.grossBp).toBeCloseTo((101 / 100 - 1) * BP, 6);
    expect(night.netBp).toBeCloseTo((101 / 100.01 - 1) * BP, 6);
    // The charged cost is gross − net by construction: the measured half-spread.
    expect(night.costBp).toBeCloseTo(night.grossBp - night.netBp, 9);
    expect(night.costBp).toBeGreaterThan(0);
  });

  /*
   * A wider book must cost more, and it must cost more in the one direction.
   * If this ever inverted, a thin-book night would look like a cheap one.
   */
  it("charges a wider book more", () => {
    const bars = [...FLAT];
    bars[2] = row(101, 100);
    const tight = markToOpenSessions(panel({ AAA: { bars } }), ["AAA"], [
      quote("2026-08-18", "AAA", 99.99, 100.01),
    ])[0];
    const wide = markToOpenSessions(panel({ AAA: { bars } }), ["AAA"], [
      quote("2026-08-18", "AAA", 99.9, 100.1),
    ])[0];
    expect(wide.costBp).toBeGreaterThan(tight.costBp);
    expect(wide.netBp).toBeLessThan(tight.netBp);
    // ...and gross is untouched, because the mid did not move.
    expect(wide.grossBp).toBeCloseTo(tight.grossBp, 9);
  });

  /*
   * THE OPEN POSITION. A mark on the last session in the panel has no exit
   * yet. Counting it as anything — a zero, a mid-to-mid — would put an
   * unresolved trade into a record of resolved ones, which is the shape of
   * the bug that once published a 100% forward record.
   */
  it("drops a mark whose exit session has not happened", () => {
    const s = markToOpenSessions(
      panel({ AAA: { bars: FLAT } }),
      ["AAA"],
      [quote(SESSIONS[SESSIONS.length - 1], "AAA", 99.99, 100.01)]
    );
    expect(s).toEqual([]);
  });

  it("drops a mark whose exit session is an interpolated fill", () => {
    const s = markToOpenSessions(
      panel({ AAA: { bars: FLAT, interpolated: [2] } }),
      ["AAA"],
      [quote("2026-08-18", "AAA", 99.99, 100.01)]
    );
    expect(s).toEqual([]);
  });

  /*
   * A long calendar gap is a halt or a hole, not a night. The rule matches
   * the close-to-open leg's so the two cannot disagree about scope — which
   * would show up as a drag that is really a difference in which nights each
   * leg decided to count.
   */
  it("drops a hold spanning more than a working weekend", () => {
    const sparse = ["2026-08-18", "2026-09-30"];
    const s = markToOpenSessions(
      panel({ AAA: { bars: [row(100, 100), row(120, 120)] } }, sparse),
      ["AAA"],
      [quote("2026-08-18", "AAA", 99.99, 100.01)]
    );
    expect(s).toEqual([]);
  });

  /*
   * 15:50 IS THE DECLARATION. The capture schedule also records 15:54 and
   * 15:58, and substituting one silently would mean the record's entry price
   * is not the one its own declaration names.
   */
  it("takes the declared minute and does not substitute a later capture", () => {
    const bars = [...FLAT];
    bars[2] = row(101, 100);
    const s = markToOpenSessions(panel({ AAA: { bars } }), ["AAA"], [
      quote("2026-08-18", "AAA", 99.99, 100.01, { targetMinute: "15:58" }),
    ]);
    expect(s).toEqual([]);
  });

  it("ignores exit-window captures, which are the other end of the trade", () => {
    const bars = [...FLAT];
    bars[2] = row(101, 100);
    const s = markToOpenSessions(panel({ AAA: { bars } }), ["AAA"], [
      quote("2026-08-18", "AAA", 99.99, 100.01, { window: "exit", targetMinute: "09:35" }),
    ]);
    expect(s).toEqual([]);
  });

  it("averages within a date like the other leg", () => {
    const up = [...FLAT];
    up[2] = row(102, 100);
    const flat2 = [...FLAT];
    const s = markToOpenSessions(
      panel({ AAA: { bars: up }, BBB: { bars: flat2 } }),
      ["AAA", "BBB"],
      [quote("2026-08-18", "AAA", 100, 100), quote("2026-08-18", "BBB", 100, 100)]
    );
    expect(s).toHaveLength(1);
    expect(s[0].names).toBe(2);
    expect(s[0].grossBp).toBeCloseTo(100, 6);
  });
});

/*
 * THE DRAG — the measurement that rescues the live series. It is PAIRED
 * because both legs see the same overnight market move; unpaired, a ~10bp
 * execution effect would be invisible inside a ~200bp nightly dispersion at
 * any sample size this will reach in a year.
 */
describe("markDrag", () => {
  /*
   * A panel whose overnight moves are violent and OPPOSITE, so a drag that
   * failed to cancel the market would be obvious rather than lucky. Two
   * marked sessions, because a standard deviation needs two observations and
   * a drag reported without one is not a measurement.
   */
  function volatile() {
    const bars = [...FLAT];
    bars[1] = row(112, 100); // +1200bp into 2026-08-18
    bars[2] = row(88, 100); //  −1200bp into 2026-08-19
    return panel({ AAA: { bars } });
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const MARKED = ["2026-08-17", "2026-08-18"];
  const RESOLVED = ["2026-08-18", "2026-08-19"];

  it("cancels the shared market move and leaves only the execution effect", () => {
    const p = volatile();
    const c2o = closeToOpenSessions(p, ["AAA"]);
    // Mid exactly at the close, so no timing drift: the ONLY difference
    // between the legs is the measured half-spread against the modelled tick.
    const mark = markToOpenSessions(
      p,
      ["AAA"],
      MARKED.map((s) => quote(s, "AAA", 99.95, 100.05))
    );
    const d = markDrag(mark, c2o);
    expect(d.n).toBe(2);

    // The ±1200bp market move is gone: the gross legs marked at the same price.
    expect(d.gross!.meanBp).toBeCloseTo(0, 6);
    expect(d.gross!.sdBp).toBeCloseTo(0, 6);

    /*
     * And the net drag is exactly the cost gap. Asserted as an identity
     * rather than a hardcoded −4bp, because the measured half-spread scales
     * with (1 + overnight return) while the modelled tick does not — so the
     * two nights carry 5.60bp and 4.40bp, and a literal would have pinned the
     * fixture's arithmetic rather than the module's.
     */
    const costGap =
      avg(mark.map((m) => m.costBp)) -
      avg(c2o.filter((s) => RESOLVED.includes(s.date)).map((s) => s.costBp));
    expect(costGap).toBeGreaterThan(3); // ~5bp book against a 1bp tick
    expect(d.net!.meanBp).toBeCloseTo(d.gross!.meanBp - costGap, 9);
    expect(d.net!.meanBp).toBeLessThan(0); // the mark costs more than the model assumed
  });

  /*
   * The timing half. Marking ten minutes before a rally into the close means
   * buying lower, so the mark-to-open leg captures MORE gross. With a mid of
   * 99 against a close of 100 the drift term is mean(open) * (1/99 − 1/100),
   * which at a mean open of 100 is 101.01bp — and it must be POSITIVE, or
   * the sign convention is backwards and every drag reads inverted.
   */
  it("shows a positive gross drag when the mark is below the close", () => {
    const p = volatile();
    const c2o = closeToOpenSessions(p, ["AAA"]);
    const mark = markToOpenSessions(
      p,
      ["AAA"],
      MARKED.map((s) => quote(s, "AAA", 98.99, 99.01))
    );
    const d = markDrag(mark, c2o);
    expect(d.n).toBe(2);
    expect(d.gross!.meanBp).toBeGreaterThan(0);
    expect(d.gross!.meanBp).toBeCloseTo(avg([112, 88]) * (1 / 99 - 1 / 100) * BP, 6);
  });

  it("pairs only on dates BOTH legs produced, and says how many", () => {
    const p = panel({ AAA: { bars: FLAT } });
    const c2o = closeToOpenSessions(p, ["AAA"]);
    const mark = markToOpenSessions(p, ["AAA"], [
      quote("2026-08-18", "AAA", 99.99, 100.01),
      // A session the panel has no bar-pair for: no counterpart, no pair.
      quote("2026-07-01", "AAA", 99.99, 100.01),
    ]);
    const d = markDrag(mark, c2o);
    expect(d.n).toBe(1);
    expect(d.firstDate).toBe("2026-08-19");
    expect(d.lastDate).toBe("2026-08-19");
  });

  it("is empty rather than zero when the legs never overlap", () => {
    const d = markDrag([], closeToOpenSessions(panel({ AAA: { bars: FLAT } }), ["AAA"]));
    expect(d.n).toBe(0);
    expect(d.net).toBeNull();
    expect(d.gross).toBeNull();
    expect(d.detectableAtT3Bp).toBeNull();
  });

  /*
   * A drag of zero at n=2 is not a finding of no drag. The power line is what
   * makes the difference legible, and it is the reason the live series being
   * stuck at n=2 was a problem rather than a result.
   */
  it("states the smallest drag it could have detected", () => {
    const p = panel({ AAA: { bars: FLAT } }, ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"]);
    const c2o = closeToOpenSessions(p, ["AAA"]);
    const mark = markToOpenSessions(p, ["AAA"], [
      quote("2026-08-17", "AAA", 99.9, 100.1),
      quote("2026-08-18", "AAA", 99.99, 100.01),
      quote("2026-08-19", "AAA", 99.95, 100.05),
    ]);
    const d = markDrag(mark, c2o);
    expect(d.n).toBe(3);
    expect(d.detectableAtT3Bp!).toBeCloseTo((3 * d.net!.sdBp) / Math.sqrt(3), 9);
    expect(d.detectableAtT3Bp!).toBeGreaterThan(0);
  });
});

/*
 * The declarations are what a reader checks the numbers against, so the two
 * legs must be distinguishable from each other and from a control.
 */
describe("the declarations", () => {
  it("gives the two legs different fingerprints", () => {
    const a = fingerprintDeclaration(closeToOpenDeclaration("scanned", "every scanned name"));
    const b = fingerprintDeclaration(MARK_TO_OPEN_DECLARATION);
    expect(a).not.toBe(b);
  });

  it("gives the cohort and its control different fingerprints", () => {
    const cohort = closeToOpenDeclaration("scanned", "every scanned non-benchmark name");
    const control = closeToOpenDeclaration("benchmarks", "index ETFs");
    expect(fingerprintDeclaration(cohort)).not.toBe(fingerprintDeclaration(control));
  });

  /*
   * The membership RULE travels in the statement. A basket named without the
   * rule that defines it is one refactor away from being a list somebody
   * chose, and the fingerprint would not notice that happening.
   */
  it("carries the membership rule, so a silently rewritten basket changes the fingerprint", () => {
    const declared = closeToOpenDeclaration("scanned", "every scanned non-benchmark name");
    const rewritten = closeToOpenDeclaration("scanned", "the seven that worked");
    expect(fingerprintDeclaration(declared)).not.toBe(fingerprintDeclaration(rewritten));
  });

  it("labels the cost basis honestly on each leg", () => {
    expect(closeToOpenDeclaration("scanned", "x").costBasis).toBe("modelled");
    expect(MARK_TO_OPEN_DECLARATION.costBasis).toBe("measured");
    // The measured leg must say what it still EXCLUDES, or "measured" overclaims.
    expect(MARK_TO_OPEN_DECLARATION.costNote).toMatch(/market impact/i);
  });

  it("names 15:50 in the declaration the producer actually reads", () => {
    expect(MARK_TO_OPEN_DECLARATION.entry).toContain(MARK_MINUTE);
  });
});

/* The producers must compose with the engine without translation. */
describe("feeding the engine", () => {
  it("builds a record straight from a producer's output", () => {
    const bars = [...FLAT];
    bars[1] = row(101, 100);
    const r = buildPaperRecord(
      closeToOpenDeclaration("scanned", "every scanned non-benchmark name"),
      closeToOpenSessions(panel({ AAA: { bars } }), ["AAA"])
    );
    expect(r.n).toBeGreaterThan(0);
    expect(r.meanTurnover).toBe(1);
    // Full turnover -> breakeven is exactly the gross mean.
    expect(r.breakevenCostBp!).toBeCloseTo(r.gross!.meanBp, 9);
  });
});
