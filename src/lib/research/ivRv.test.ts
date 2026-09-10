import { describe, expect, it } from "vitest";
import { CONSTANT_MATURITY_DAYS } from "../options/ivTermStructure";
import {
  ANNUALISATION_SESSIONS,
  IV_TENOR_SESSIONS,
  MIN_RETURNS,
  TRAILING_WINDOWS,
  buildIvRvPoint,
  forwardRvPct,
  logReturnsAligned,
  matchedLeg,
  trailingRvPct,
} from "./ivRv";

/**
 * The failure modes here are all silent ones. A vol computed across a gap, a
 * window that reaches one session too far, a forward leg that double-counts
 * the observation session — none of them throw, and every one of them
 * produces a number that looks exactly like a good number.
 */

/** A constant-return series: every session moves by the same log amount. */
const steady = (n: number, perSession: number): (number | null)[] =>
  Array.from({ length: n }, (_, i) => (i === 0 ? null : perSession));

describe("logReturnsAligned", () => {
  it("indexes the return INTO each session, so slicing needs no off-by-one", () => {
    const r = logReturnsAligned([100, 110, 121]);
    expect(r).toHaveLength(3);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(Math.log(1.1), 12);
    expect(r[2]).toBeCloseTo(Math.log(1.1), 12);
  });

  it("nulls a return whose either end is missing or non-positive", () => {
    expect(logReturnsAligned([100, null, 121])).toEqual([null, null, null]);
    expect(logReturnsAligned([0, 110])[1]).toBeNull();
    expect(logReturnsAligned([100, -5])[1]).toBeNull();
  });
});

describe("trailingRvPct", () => {
  /*
   * The annualisation, pinned against a hand-computable case. A constant
   * per-session log move of x has zero-mean RMS exactly x, so the annualised
   * figure is x * sqrt(252) * 100 and nothing about the window can change it.
   */
  it("annualises a constant mover to its closed form", () => {
    const x = 0.01;
    // Long enough for the widest declared window, whatever that becomes.
    const n = Math.max(...TRAILING_WINDOWS) + 20;
    const r = steady(n, x);
    const expected = x * Math.sqrt(ANNUALISATION_SESSIONS) * 100;
    for (const w of TRAILING_WINDOWS) {
      expect(trailingRvPct(r, n - 1, w), `window ${w}`).toBeCloseTo(expected, 9);
    }
  });

  /*
   * THE LOOK-AHEAD TEST, and the one that matters most.
   *
   * A trailing estimate at session i must be identical whether or not the
   * series continues past i. If a future bar can move it, every ratio built
   * on it is contaminated and the whole study is worthless in the direction
   * that flatters it.
   */
  it("cannot be moved by anything after its end index", () => {
    const base = steady(30, 0.01);
    const withFuture = [...base, ...Array(30).fill(0.5)]; // violent later moves
    for (const w of TRAILING_WINDOWS) {
      expect(trailingRvPct(withFuture, 29, w)).toBe(trailingRvPct(base, 29, w));
    }
  });

  /*
   * A hole must produce a refusal, not a smaller number. Scoring a missing
   * session as no move understates vol, and it understates it hardest for the
   * illiquid names that have the gaps — which are the names a cheap-options
   * screen would surface.
   */
  it("refuses a window containing a gap rather than understating", () => {
    const holed = steady(30, 0.01);
    holed[12] = null;
    // The 21-session window reaches back over the hole; the 10 does not. The
    // gap must silence the one that spans it and leave the other alone,
    // rather than both returning a quietly depressed number.
    expect(trailingRvPct(holed, 29, 21)).toBeNull();
    expect(trailingRvPct(holed, 29, 10)).not.toBeNull();
  });

  it("refuses when the window would reach before the series starts", () => {
    const r = steady(15, 0.01);
    expect(trailingRvPct(r, 14, 63)).toBeNull();
    expect(trailingRvPct(r, 14, 10)).not.toBeNull();
  });

  it("refuses a window too short to estimate a standard deviation", () => {
    const r = steady(30, 0.01);
    expect(trailingRvPct(r, 29, MIN_RETURNS - 1)).toBeNull();
    expect(trailingRvPct(r, 29, MIN_RETURNS)).not.toBeNull();
  });
});

describe("forwardRvPct", () => {
  it("excludes the observation session's own move from the outcome", () => {
    /*
     * Session 10 moves violently; everything after it is calm. If the
     * observation session leaked into its own forward window, this would come
     * back high. The signal and its outcome sharing a bar is how a study
     * discovers that a variable predicts itself.
     */
    const r = steady(40, 0.005);
    r[10] = 0.4;
    const calm = forwardRvPct(r, 10, IV_TENOR_SESSIONS)!;
    const expected = 0.005 * Math.sqrt(ANNUALISATION_SESSIONS) * 100;
    expect(calm).toBeCloseTo(expected, 9);
  });

  it("is null until the full horizon has elapsed", () => {
    const r = steady(30, 0.01);
    // Needs sessions 21..29 inclusive after index 8 -> resolvable.
    expect(forwardRvPct(r, 8, IV_TENOR_SESSIONS)).not.toBeNull();
    // One short.
    expect(forwardRvPct(r, 9, IV_TENOR_SESSIONS)).toBeNull();
    expect(forwardRvPct(r, 25, IV_TENOR_SESSIONS)).toBeNull();
  });

  /*
   * UNIFORM RESOLUTION. Every observation resolves at exactly the same age,
   * so a fast arm cannot enter the sample ahead of a slow one. This is
   * asserted rather than assumed because the equivalent bug — outcomes
   * resolving at different speeds — once published a 100% forward record.
   */
  it("resolves every observation at the same age, whatever the path", () => {
    const calm = steady(60, 0.002);
    const wild = steady(60, 0.08);
    for (let i = 1; i + IV_TENOR_SESSIONS < 60; i++) {
      expect(forwardRvPct(calm, i, IV_TENOR_SESSIONS) === null).toBe(
        forwardRvPct(wild, i, IV_TENOR_SESSIONS) === null
      );
    }
  });
});

describe("buildIvRvPoint", () => {
  const sessions = Array.from({ length: 60 }, (_, i) => `S${String(i).padStart(2, "0")}`);

  const point = (sessionIndex: number, ivPct: number, returns = steady(60, 0.01)) =>
    buildIvRvPoint({
      date: sessions[sessionIndex],
      symbol: "CLSK",
      ivPct,
      ivTenorSessions: IV_TENOR_SESSIONS,
      returns,
      sessionIndex,
      sessions,
    });

  it("puts implied over realized, so cheap options read below one", () => {
    // Constant 1% moves -> RV = 15.87%. IV at 12.5% is cheap against that.
    const rv = 0.01 * Math.sqrt(ANNUALISATION_SESSIONS) * 100;
    const p = point(30, rv * 0.79);
    const m = matchedLeg(p)!;
    expect(m.rvPct).toBeCloseTo(rv, 9);
    expect(m.ratio).toBeCloseTo(0.79, 9);
  });

  /*
   * The trade that motivated this: implied 83 against realized 105. It must
   * land below one, on the leg whose window matches the IV tenor.
   */
  it("reproduces the CLSK reading that started this", () => {
    const perSession = 105 / (Math.sqrt(ANNUALISATION_SESSIONS) * 100);
    const p = point(30, 83, steady(60, perSession));
    const m = matchedLeg(p)!;
    expect(m.rvPct).toBeCloseTo(105, 6);
    expect(m.ratio).toBeCloseTo(83 / 105, 6);
    expect(m.ratio!).toBeLessThan(0.85);
  });

  it("carries every declared trailing window", () => {
    expect(point(40, 50).trailing.map((t) => t.windowSessions)).toEqual([...TRAILING_WINDOWS]);
  });

  it("leaves the forward leg open, and dates it once it closes", () => {
    const open = point(50, 50);
    expect(open.forwardRvPct).toBeNull();
    expect(open.forwardRatio).toBeNull();
    expect(open.forwardResolvedOn).toBeNull();

    const closed = point(20, 50);
    expect(closed.forwardRvPct).not.toBeNull();
    expect(closed.forwardResolvedOn).toBe(sessions[20 + IV_TENOR_SESSIONS]);
  });

  /*
   * The forward ratio is the one that carries a verdict, so its direction has
   * to be unambiguous: below one means the option was cheap against what the
   * underlying actually went on to do.
   */
  it("reads below one when realized vol arrives above implied", () => {
    const r = steady(60, 0.002); // calm trailing
    for (let i = 31; i < 60; i++) r[i] = 0.02; // then ten times as violent
    const p = buildIvRvPoint({
      date: sessions[30],
      symbol: "CLSK",
      ivPct: 10,
      ivTenorSessions: IV_TENOR_SESSIONS,
      returns: r,
      sessionIndex: 30,
      sessions,
    });
    expect(p.forwardRatio).not.toBeNull();
    expect(p.forwardRatio!).toBeLessThan(1);
    // ...and the trailing leg, looking the other way, disagrees. Which is the
    // entire reason both are recorded.
    expect(matchedLeg(p)!.ratio!).toBeGreaterThan(1);
  });

  it("refuses a ratio rather than dividing by a missing or zero vol", () => {
    const holed = steady(60, 0.01);
    holed[28] = null;
    const p = point(30, 50, holed);
    const m = matchedLeg(p)!;
    expect(m.rvPct).toBeNull();
    expect(m.ratio).toBeNull();
  });
});

/*
 * THE TENOR HAS TO MATCH, and it lives in another module.
 *
 * IV is interpolated to CONSTANT_MATURITY_DAYS there; realized vol is measured
 * over IV_TENOR_SESSIONS here. If those drift apart the ratio quietly becomes
 * a comparison of two different amounts of time — and a ratio that varies with
 * the tenor rather than with the vol is context, not evidence. A previous
 * measurement here found twelve names decaying 5.2-7.6%/day purely as a
 * function of tenor.
 */
describe("the tenor the two sides agree on", () => {
  it("measures realized vol over the same horizon implied vol describes", () => {
    expect(IV_TENOR_SESSIONS).toBe(CONSTANT_MATURITY_DAYS);
  });

  it("offers a trailing window at exactly that horizon", () => {
    expect(TRAILING_WINDOWS).toContain(IV_TENOR_SESSIONS);
  });
});
