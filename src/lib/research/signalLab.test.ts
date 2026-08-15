import { describe, expect, it } from "vitest";
import {
  Hypothesis,
  LabSeries,
  excludeCorruptSeries,
  indexAsOf,
  panelBreadth,
  realisedVol,
  ret,
  runHypothesis,
  signTestP,
  trailingHigh,
} from "./signalLab";

/**
 * HAND-VERIFIED FIXTURES FOR THE LAB.
 *
 * Five signals now claim Edge on this engine's output, and one of them —
 * the long-only leg — exists specifically so a single-ticker page can quote
 * a number. If `runHypothesis` computes the wrong statistic, every one of
 * those claims is wrong in a way no amount of downstream care can catch.
 *
 * So the panel below is built so that the answer can be worked out on paper.
 * 40 instruments (exactly MIN_PANEL), one period, decile k = floor(40 × 0.1)
 * = 4, and forward returns assigned in three flat blocks:
 *
 *   top 4     +10%
 *   middle 32   0%
 *   bottom 4   −2%
 *
 *   long-short    = 0.10 − (−0.02)          = 0.12
 *   panel mean    = (4(0.10) + 32(0) + 4(−0.02)) / 40
 *                 = (0.40 − 0.08) / 40      = 0.008
 *   long-vs-panel = 0.10 − 0.008            = 0.092
 *
 * Both are exact, and they differ — which is the entire point of the `leg`
 * field. A version of this engine that ignored `leg` would return 0.12 for
 * both and the long-only claim would silently inherit a spread's record.
 */

const DAY = 86_400_000;
const PANEL_SIZE = 40;

/**
 * Four bars per instrument. The rank is read at index 2 and the forward
 * return runs 2 → 3, so bars 0 and 1 exist only to satisfy the warmup.
 */
function buildPanel(forwardFor: (j: number) => number): LabSeries[] {
  const out: LabSeries[] = [];
  for (let j = 0; j < PANEL_SIZE; j++) {
    // Descending, so instrument 0 ranks highest and instrument 39 lowest.
    const score = PANEL_SIZE - j;
    const close = [1, 1, score, score * (1 + forwardFor(j))];
    out.push({
      symbol: `S${j}`,
      t: [0, DAY, 2 * DAY, 3 * DAY],
      close,
      high: close,
      low: close,
      volume: close.map(() => 1000),
    });
  }
  return out;
}

/** Top 4 up 10%, bottom 4 down 2%, everything between flat. */
const blockForward = (j: number) => (j < 4 ? 0.1 : j >= PANEL_SIZE - 4 ? -0.02 : 0);

/** Ranks on the close at the decision bar, which is the score built above. */
const base: Hypothesis = {
  id: "test",
  statement: "test",
  rationale: "test",
  hold: 1,
  warmup: 2,
  costPp: 0,
  killCriteria: "test",
  rank: ({ series, i }) => series.close[i],
};

describe("runHypothesis — which statistic is being measured", () => {
  it("defaults to top decile minus bottom decile", () => {
    const r = runHypothesis(buildPanel(blockForward), base);
    expect(r.n).toBe(1);
    expect(r.meanSpread).toBeCloseTo(0.12, 10);
  });

  it("measures the top decile against the whole panel when leg is long-vs-panel", () => {
    const r = runHypothesis(buildPanel(blockForward), { ...base, leg: "long-vs-panel" });
    expect(r.n).toBe(1);
    expect(r.meanSpread).toBeCloseTo(0.092, 10);
  });

  it("the two legs disagree, so a consumer cannot substitute one for the other", () => {
    const panel = buildPanel(blockForward);
    const spread = runHypothesis(panel, base).meanSpread;
    const longOnly = runHypothesis(panel, { ...base, leg: "long-vs-panel" }).meanSpread;
    expect(spread).not.toBeCloseTo(longOnly, 3);
  });

  /*
   * The case that matters most for the dossier: an edge living ENTIRELY in
   * the short leg. Top decile flat, bottom decile down 5%. The spread is a
   * healthy +5% while a long position captures nothing — quoting the spread
   * on a ticker page here would be pure fiction.
   */
  it("separates a short-leg-only effect from a tradeable long", () => {
    const shortLegOnly = (j: number) => (j >= PANEL_SIZE - 4 ? -0.05 : 0);
    const panel = buildPanel(shortLegOnly);

    expect(runHypothesis(panel, base).meanSpread).toBeCloseTo(0.05, 10);
    // panel mean = 4(−0.05)/40 = −0.005; top decile 0 − (−0.005) = +0.005
    expect(runHypothesis(panel, { ...base, leg: "long-vs-panel" }).meanSpread).toBeCloseTo(
      0.005,
      10
    );
  });
});

describe("runHypothesis — periods, gates and entry offset", () => {
  it("refuses to rank a panel below the decile minimum", () => {
    const small = buildPanel(blockForward).slice(0, 39);
    expect(runHypothesis(small, base).n).toBe(0);
  });

  it("counts periods the regime gate closed rather than silently dropping them", () => {
    const r = runHypothesis(buildPanel(blockForward), { ...base, periodGate: () => false });
    expect(r.n).toBe(0);
    expect(r.periodsGatedOut).toBe(1);
  });

  it("passes the panel and decision time to the gate, never the outcome", () => {
    let seen: { count: number; time: number } | null = null;
    runHypothesis(buildPanel(blockForward), {
      ...base,
      periodGate: ({ panel, decisionTime }) => {
        seen = { count: panel.length, time: decisionTime };
        return true;
      },
    });
    expect(seen).toEqual({ count: PANEL_SIZE, time: 2 * DAY });
  });

  /*
   * THE BOUNCE TEST, on a panel built to fail it.
   *
   * The top decile makes its entire move on the bar immediately after the
   * signal and nothing afterwards — the shape of a close-on-the-bid then
   * close-on-the-ask artifact. Entering at the signal captures all of it;
   * entering one bar later captures none. That is exactly the pattern that
   * retired reversal-5d, so the engine has to reproduce it on demand.
   *
   * Six bars and hold = 2 so that BOTH runs contain exactly one period:
   * offset 0 steps 2 → 4, offset 1 steps 3 → 5. (Five bars with hold = 1
   * gives the unshifted run two periods and the shifted run one, which
   * averages the answer with a second period rather than isolating it.)
   */
  it("enters after the signal bar when entryOffset is set", () => {
    const panel: LabSeries[] = [];
    for (let j = 0; j < PANEL_SIZE; j++) {
      const score = PANEL_SIZE - j;
      const bump = j < 4 ? 1.1 : 1;
      // bar2 = the signal; the move lands on bar3 and never repeats.
      const close = [1, 1, score, score * bump, score * bump, score * bump];
      panel.push({
        symbol: `S${j}`,
        t: [0, DAY, 2 * DAY, 3 * DAY, 4 * DAY, 5 * DAY],
        close,
        high: close,
        low: close,
        volume: close.map(() => 1000),
      });
    }
    const twoBarHold = { ...base, hold: 2 };

    // Entered at bar 2, exited at bar 4: the top decile captures its +10%.
    expect(runHypothesis(panel, twoBarHold).n).toBe(1);
    expect(runHypothesis(panel, twoBarHold).meanSpread).toBeCloseTo(0.1, 10);

    // Entered at bar 3, exited at bar 5: the move already happened.
    const shifted = runHypothesis(panel, { ...twoBarHold, entryOffset: 1 });
    expect(shifted.n).toBe(1);
    expect(shifted.meanSpread).toBeCloseTo(0, 10);
  });
});

describe("panelBreadth", () => {
  /** A series whose last close sits above or below its own 200-bar average. */
  function flatThen(last: number): LabSeries {
    const close = [...Array(200).fill(100), last];
    return {
      symbol: "x",
      t: close.map((_, i) => i * DAY),
      close,
      high: close,
      low: close,
      volume: close.map(() => 1),
    };
  }

  it("is the share of the panel trading above its own 200-session average", () => {
    // 30 above, 20 below. The 200-bar mean at the final bar includes that
    // bar, so 100 flat bars plus one at 110 averages just over 100.
    const panel = [
      ...Array.from({ length: 30 }, () => flatThen(110)),
      ...Array.from({ length: 20 }, () => flatThen(90)),
    ];
    expect(panelBreadth(panel, 200 * DAY)).toBeCloseTo(0.6, 10);
  });

  it("returns null rather than a number when too few instruments qualify", () => {
    const panel = Array.from({ length: 39 }, () => flatThen(110));
    expect(panelBreadth(panel, 200 * DAY)).toBeNull();
  });

  it("ignores instruments without 200 sessions at the decision date", () => {
    const short: LabSeries = {
      symbol: "young",
      t: [0, DAY],
      close: [100, 200],
      high: [100, 200],
      low: [100, 200],
      volume: [1, 1],
    };
    const panel = [...Array.from({ length: 40 }, () => flatThen(110)), short];
    expect(panelBreadth(panel, 200 * DAY)).toBeCloseTo(1, 10);
  });
});

describe("excludeCorruptSeries", () => {
  function withMove(symbol: string, move: number): LabSeries {
    const close = [100, 100 * (1 + move), 100 * (1 + move)];
    return {
      symbol,
      t: [0, DAY, 2 * DAY],
      close,
      high: close,
      low: close,
      volume: [1, 1, 1],
    };
  }

  it("drops an instrument with an impossible session and keeps a large but plausible one", () => {
    const { clean, excluded } = excludeCorruptSeries([
      withMove("ok", 0.55),
      withMove("bad", 26.33),
    ]);
    expect(clean.map((s) => s.symbol)).toEqual(["ok"]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].symbol).toBe("bad");
    expect(excluded[0].worstMovePct).toBeCloseTo(2633, 6);
  });

  it("catches an impossible move in either direction", () => {
    const { clean } = excludeCorruptSeries([withMove("crash", -0.9)]);
    expect(clean).toHaveLength(0);
  });

  /*
   * The decision reads the instrument's ENTIRE history and is therefore the
   * same for every period. That is what makes it a statement about the data
   * rather than look-ahead, and it is worth pinning: a version that only
   * inspected bars up to some date would exclude different names on
   * different runs.
   */
  it("is independent of where in the series the bad bar sits", () => {
    const early = { ...withMove("e", 26.33) };
    const late: LabSeries = {
      symbol: "l",
      t: [0, DAY, 2 * DAY],
      close: [100, 100, 2733],
      high: [100, 100, 2733],
      low: [100, 100, 2733],
      volume: [1, 1, 1],
    };
    expect(excludeCorruptSeries([early]).clean).toHaveLength(0);
    expect(excludeCorruptSeries([late]).clean).toHaveLength(0);
  });
});

describe("feature helpers", () => {
  const s: LabSeries = {
    symbol: "f",
    t: [0, DAY, 2 * DAY, 3 * DAY],
    close: [100, 110, 121, 100],
    high: [100, 110, 121, 100],
    low: [100, 110, 121, 100],
    volume: [10, 20, 30, 40],
  };

  it("ret is a simple return between two indices", () => {
    expect(ret(s, 0, 2)).toBeCloseTo(0.21, 10);
  });

  it("ret returns null rather than Infinity on an unusable bar", () => {
    const bad = { ...s, close: [0, 110, 121, 100] };
    expect(ret(bad, 0, 2)).toBeNull();
  });

  it("trailingHigh is inclusive of the current bar", () => {
    expect(trailingHigh(s, 3, 4)).toBe(121);
    expect(trailingHigh(s, 3, 1)).toBe(100);
  });

  it("trailingHigh returns null when the window predates the series", () => {
    expect(trailingHigh(s, 1, 5)).toBeNull();
  });

  it("realisedVol is zero for a constant-return series", () => {
    const steady: LabSeries = {
      ...s,
      close: [100, 110, 121, 133.1],
    };
    expect(realisedVol(steady, 3, 3)).toBeCloseTo(0, 12);
  });

  it("indexAsOf finds the last bar at or before a time, and -1 before the series", () => {
    expect(indexAsOf(s.t, 2 * DAY)).toBe(2);
    expect(indexAsOf(s.t, 2 * DAY + 1)).toBe(2);
    expect(indexAsOf(s.t, -1)).toBe(-1);
  });
});

describe("signTestP", () => {
  // Six digits, not ten: the erf approximation underneath is Abramowitz-
  // Stegun 7.1.26, whose stated max error is 1.5e-7.
  it("is 1 for an exactly even split", () => {
    expect(signTestP(50, 100)).toBeCloseTo(1, 6);
  });

  /*
   * 60/100 is z = 0.1 / sqrt(0.0025) = 2 exactly, and the two-sided normal
   * tail at z = 2 is 0.0455.
   */
  it("matches the normal approximation at z = 2", () => {
    expect(signTestP(60, 100)).toBeCloseTo(0.0455, 3);
  });

  it("returns 1 for an empty sample rather than dividing by zero", () => {
    expect(signTestP(0, 0)).toBe(1);
  });
});
