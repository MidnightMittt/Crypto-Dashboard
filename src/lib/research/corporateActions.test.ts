import { describe, expect, it } from "vitest";
import { Bar } from "./types";
import {
  MAX_SESSION_MOVE,
  adjustForCorporateActions,
  findPriceBreaks,
  formatAdjustmentNotes,
} from "./corporateActions";

/**
 * Fixtures use the real reported prices. The HUT and CORZ series are the raw
 * UNADJUSTED values from the Robinhood/MCP feed, which is where those two
 * corporate actions come through unadjusted — the Yahoo ingest back-adjusts
 * them, so they cannot be reproduced from committed bars. Testing the
 * detector against the raw numbers is the point: it is what protects any
 * future feed that behaves the way that one does.
 */

const day = 86_400_000;
const START = Date.parse("2023-11-27T00:00:00Z");

/** Flat OHLC bars from a close series — enough for close-to-close detection. */
function series(closes: number[], start = START): Bar[] {
  return closes.map((c, i) => ({
    t: start + i * day,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1_000,
  }));
}

/** Every close-to-close return in a series, as fractions. */
function returns(bars: Bar[]): number[] {
  return bars.slice(1).map((b, i) => b.close / bars[i].close - 1);
}


/*
 * Verdicts are injected rather than read from the real registry: these
 * fixtures are about the repair mechanics, and a test that silently depended
 * on a production declaration would break the day someone edited it for an
 * unrelated reason.
 */
const declare = (...dates: string[]) => ({
  declared: dates.map((date) => ({
    symbol: "TEST",
    date,
    treatment: "adjust" as const,
    reason: "fixture",
  })),
});
const D = declare("2023-11-30");

describe("findPriceBreaks — classification", () => {
  /*
   * HUT, the Hut 8 merger: 2.270 -> 11.910 on 2023-12-01, +425%. It steps
   * and stays, so exactly one return is fictional.
   */
  it("calls the Hut 8 merger a step", () => {
    const bars = series([2.31, 2.29, 2.27, 11.91, 12.4, 11.8, 12.1]);
    const breaks = findPriceBreaks(bars);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].kind).toBe("step");
    expect(breaks[0].ratio).toBeCloseTo(11.91 / 2.27, 10);
    expect(breaks[0].revertsAtIndex).toBeNull();
  });

  /* CORZ, Chapter 11 emergence: 0.890 -> 5.550, +524%. */
  it("calls the Core Scientific relisting a step", () => {
    const bars = series([0.91, 0.9, 0.89, 5.55, 5.4, 5.8, 5.6]);
    const breaks = findPriceBreaks(bars);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].kind).toBe("step");
    expect(breaks[0].ratio).toBeCloseTo(5.55 / 0.89, 10);
  });

  /*
   * MARA 2012, from the committed ingest: 104 flat, one session at 30.16,
   * straight back to 104. Both legs must be recognised as ONE excursion, or
   * a threshold rule deletes the recovery and keeps the crash.
   */
  it("calls a one-session round trip a spike, not two steps", () => {
    const bars = series([104, 104, 104, 30.16, 104, 104, 104]);
    const breaks = findPriceBreaks(bars);
    // The down leg is the break; the up leg is its reversion, not a second break.
    expect(breaks[0].kind).toBe("spike");
    expect(breaks[0].revertsAtIndex).toBe(4);
  });

  /*
   * THE LIMIT, stated rather than hidden. Morgan Stanley really did close
   * +87% on 2008-10-13. At the 100% default it survives, which is correct —
   * but the threshold is the only thing separating it from a fabrication.
   */
  it("leaves a real +87% session alone at the default threshold", () => {
    const bars = series([6.71, 6.52, 12.19, 11.4, 12.0]);
    expect(findPriceBreaks(bars, MAX_SESSION_MOVE)).toHaveLength(0);
    // Lower the bar and it is caught — the cut-off is a choice, not a law.
    expect(findPriceBreaks(bars, 0.5)).toHaveLength(1);
  });

  it("finds nothing in an ordinary series", () => {
    expect(findPriceBreaks(series([10, 10.4, 9.9, 10.2, 10.8]))).toHaveLength(0);
  });

  it("ignores non-positive prices instead of dividing by them", () => {
    const bars = series([10, 0, 10.2, 10.4]);
    expect(findPriceBreaks(bars)).toHaveLength(0);
  });
});

describe("adjustForCorporateActions — steps", () => {
  const raw = series([2.31, 2.29, 2.27, 11.91, 12.4, 11.8]);

  it("removes the fictional return and leaves every real one untouched", () => {
    const { bars } = adjustForCorporateActions(raw, "TEST", D);
    const before = returns(raw);
    const after = returns(bars);

    // The break session's return is now zero by construction.
    expect(before[2]).toBeCloseTo(11.91 / 2.27 - 1, 10);
    expect(after[2]).toBeCloseTo(0, 12);

    // THE PROPERTY THAT MAKES RESCALING SAFE: every other return is identical.
    for (const i of [0, 1, 3, 4]) expect(after[i]).toBeCloseTo(before[i], 12);
  });

  it("joins the segments so the series is continuous", () => {
    const { bars } = adjustForCorporateActions(raw, "TEST", D);
    expect(bars[2].close).toBeCloseTo(11.91, 10);
    // Post-break bars are never touched.
    expect(bars[3].close).toBe(11.91);
    expect(bars[5].close).toBe(11.8);
  });

  it("keeps every bar — a corporate action is not a reason to lose history", () => {
    const { bars } = adjustForCorporateActions(raw, "TEST", D);
    expect(bars).toHaveLength(raw.length);
  });

  it("scales the whole bar, not just the close", () => {
    const bars: Bar[] = [
      { t: START, open: 2.2, high: 2.4, low: 2.1, close: 2.27, volume: 1 },
      { t: START + day, open: 11.5, high: 12.0, low: 11.4, close: 11.91, volume: 1 },
    ];
    const k = 11.91 / 2.27;
    const out = adjustForCorporateActions(bars, "TEST", declare("2023-11-28")).bars;
    expect(out[0].open).toBeCloseTo(2.2 * k, 10);
    expect(out[0].high).toBeCloseTo(2.4 * k, 10);
    expect(out[0].low).toBeCloseTo(2.1 * k, 10);
    // Intraday range as a share of price is preserved, which is what ATR reads.
    expect((out[0].high - out[0].low) / out[0].close).toBeCloseTo((2.4 - 2.1) / 2.27, 10);
  });

  /* Two actions in one series, applied back to front without interfering. */
  it("handles two steps in the same series", () => {
    const raw2 = series([1, 1.02, 10, 10.2, 100, 101]);
    const { bars, notes } = adjustForCorporateActions(raw2, "TEST", declare("2023-11-29", "2023-12-01"));
    expect(notes).toHaveLength(2);
    const after = returns(bars);
    expect(after[1]).toBeCloseTo(0, 12);
    expect(after[3]).toBeCloseTo(0, 12);
    // The ordinary sessions survive intact.
    expect(after[0]).toBeCloseTo(0.02, 12);
    expect(after[4]).toBeCloseTo(0.01, 12);
  });
});

describe("adjustForCorporateActions — spikes", () => {
  const raw = series([104, 104, 104, 30.16, 104, 104]);

  /*
   * THE REGRESSION. A drop-what-exceeds-the-threshold rule removes the
   * +244.8% recovery and leaves the -71% crash, turning a broken print into
   * a permanent fictional loss. Both legs have to go.
   */
  it("removes BOTH legs of the excursion, not just the one over the threshold", () => {
    const { bars } = adjustForCorporateActions(raw, "TEST", D);
    const after = returns(bars);
    expect(Math.max(...after.map(Math.abs))).toBeCloseTo(0, 12);
    expect(bars[3].close).toBeCloseTo(104, 10);
  });

  it("does not touch anything outside the excursion", () => {
    const withMove = series([104, 110, 104, 30.16, 104, 99]);
    const { bars } = adjustForCorporateActions(withMove, "TEST");
    expect(bars[1].close).toBe(110);
    expect(bars[5].close).toBe(99);
  });
});

describe("adjustForCorporateActions — reporting", () => {
  it("returns an untouched series and no notes when nothing is wrong", () => {
    const clean = series([10, 10.4, 9.9, 10.2]);
    const { bars, notes } = adjustForCorporateActions(clean, "TEST");
    expect(notes).toEqual([]);
    expect(bars).toBe(clean);
  });

  it("describes every intervention so none of it is silent", () => {
    const { notes } = adjustForCorporateActions(series([2.27, 11.91, 12.4]), "TEST", declare("2023-11-28"));
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("step");
    expect(notes[0].barsAffected).toBe(1);
    const lines = formatAdjustmentNotes("HUT", notes);
    expect(lines[0]).toContain("HUT");
    expect(lines[0]).toContain("STEP");
    expect(lines[0]).toContain("back-adjusted");
  });

  it("reports notes in chronological order", () => {
    const { notes } = adjustForCorporateActions(series([1, 10, 10.2, 100, 101]), "TEST", declare("2023-11-28", "2023-11-30"));
    expect(notes.map((n) => n.date)).toEqual([...notes.map((n) => n.date)].sort());
  });
});

/**
 * THE SAFETY PROPERTY. Magnitude cannot separate an unadjusted action from a
 * violent real move, and the two mistakes cost wildly different amounts:
 * missing an action leaves one bad return, while "fixing" a real one deletes
 * a genuine return AND rescales every price before it. So an unjudged step is
 * reported and left alone.
 */
describe("adjustForCorporateActions — declared steps only", () => {
  const raw = series([2.31, 2.29, 2.27, 11.91, 12.4, 11.8]);

  it("refuses to touch a step nobody has judged, and says so", () => {
    const { bars, notes, undeclared } = adjustForCorporateActions(raw, "UNKNOWN");
    expect(bars.map((b) => b.close)).toEqual(raw.map((b) => b.close));
    expect(undeclared).toHaveLength(1);
    expect(notes[0].undeclared).toBe(true);
    expect(notes[0].barsAffected).toBe(0);
    expect(notes[0].action).toContain("UNDECLARED");
  });

  it("leaves a step declared real exactly as it is", () => {
    const declared = [
      { symbol: "TEST", date: "2023-11-30", treatment: "keep" as const, reason: "real move" },
    ];
    const { bars, notes, undeclared } = adjustForCorporateActions(raw, "TEST", { declared });
    expect(bars.map((b) => b.close)).toEqual(raw.map((b) => b.close));
    expect(undeclared).toHaveLength(0);
    expect(notes[0].action).toContain("kept as a real move");
  });

  /*
   * The two cases from the audit that a size-only rule would have destroyed.
   * REGN's Axokine crash and MARA's crypto repricing are both declared real,
   * so the registry must leave them alone at any threshold.
   */
  it("protects the real moves found in the audit, via the shipped registry", () => {
    // Dated so the break lands on 2003-03-31, the real Axokine session.
    const regn = series([19.19, 17.17, 7.46, 6.83, 6.55], Date.parse("2003-03-29T00:00:00Z"));
    const out = adjustForCorporateActions(regn, "REGN", { threshold: 0.5 });
    expect(out.bars.map((b) => b.close)).toEqual(regn.map((b) => b.close));
    expect(out.undeclared).toHaveLength(0);
    expect(out.notes[0].action).toContain("Axokine");
  });

  it("back-adjusts NVR's Chapter 11 relisting, via the shipped registry", () => {
    // Break lands on 1993-10-01, the real relisting.
    const nvr = series([0.38, 0.38, 10.25, 10.0, 10.13], Date.parse("1993-09-29T00:00:00Z"));
    const { bars, undeclared, notes } = adjustForCorporateActions(nvr, "NVR");
    expect(undeclared).toHaveLength(0);
    expect(notes[0].action).toContain("back-adjusted");
    // The fictional return is gone and the pre-break level is rescaled up.
    expect(bars[2].close / bars[1].close - 1).toBeCloseTo(0, 12);
    expect(bars[0].close).toBeCloseTo(10.25, 10);
  });

  /* A spike needs no declaration — a price that leaves and returns in two
   * sessions is a broken print by construction, not a market event. */
  it("repairs a spike without any declaration", () => {
    const spiky = series([104, 104, 30.16, 104, 104]);
    const { bars, undeclared } = adjustForCorporateActions(spiky, "NOBODY");
    expect(undeclared).toHaveLength(0);
    expect(bars[2].close).toBeCloseTo(104, 10);
  });
});
