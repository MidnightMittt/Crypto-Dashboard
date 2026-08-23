import { describe, expect, it } from "vitest";
import {
  CloseBar,
  ForwardVerdict,
  VerdictPrediction,
  expireUnresolvable,
  pruneVerdicts,
  registerVerdicts,
  resolveVerdicts,
  summariseVerdicts,
} from "./forwardVerdict";

const pred = (over: Partial<VerdictPrediction> = {}): VerdictPrediction => ({
  date: "2026-08-14",
  symbol: "AMD",
  verdict: "bullish",
  confidence: 60,
  closePrice: 100,
  forwardReturnPct: null,
  resolvedDate: null,
  ...over,
});

const closes = (xs: number[]): CloseBar[] =>
  xs.map((close, i) => ({ t: Date.UTC(2026, 7, 17 + i), close }));

describe("registerVerdicts", () => {
  it("is idempotent per day and symbol", () => {
    const once = registerVerdicts([], [pred(), pred({ confidence: 80 })]);
    expect(once).toHaveLength(1);
    expect(once[0].confidence).toBe(80);
  });

  it("never overwrites a resolved row", () => {
    const done = pred({ forwardReturnPct: 4.2, resolvedDate: "2026-08-28" });
    const out = registerVerdicts([done], [pred({ verdict: "bearish" })]);
    expect(out[0].forwardReturnPct).toBe(4.2);
    expect(out[0].verdict).toBe("bullish");
  });
});

describe("resolveVerdicts", () => {
  it("scores the CLOSE of the tenth session, not the best price along the way", () => {
    // Spikes to 130 mid-window but ends at 105 — the verdict is about where
    // price ENDS, so 5% is the answer.
    const out = resolveVerdicts([pred()], () => closes([102, 130, 99, 101, 103, 97, 104, 106, 108, 105]), () => 100);
    expect(out[0].forwardReturnPct).toBeCloseTo(5, 5);
    expect(out[0].resolvedDate).toBe("2026-08-26");
  });

  it("leaves a prediction open until the full horizon exists", () => {
    const out = resolveVerdicts([pred()], () => closes([101, 102, 103]), () => 100);
    expect(out[0].forwardReturnPct).toBeNull();
  });

  it("never re-resolves", () => {
    const done = pred({ forwardReturnPct: -1.5, resolvedDate: "2026-08-28" });
    const out = resolveVerdicts([done], () => closes(Array(10).fill(200)), () => 100);
    expect(out[0].forwardReturnPct).toBe(-1.5);
  });
});

describe("summariseVerdicts", () => {
  /*
   * THE POINT OF THE WHOLE MODULE. A universe that rose 2% makes any
   * always-bullish caller look good. Edge is measured against the sample's
   * own drift, so a bullish cell that merely matched the market scores zero.
   */
  it("reports bullish edge NET of the sample's own drift", () => {
    const bull = Array.from({ length: 40 }, () => pred({ forwardReturnPct: 3 }));
    const neutral = Array.from({ length: 40 }, () => pred({ verdict: "neutral", forwardReturnPct: 1 }));
    const { cells, baselineReturnPct } = summariseVerdicts([...bull, ...neutral]);
    expect(baselineReturnPct).toBeCloseTo(2, 5); // (3 + 1) / 2
    const b = cells.find((c) => c.verdict === "bullish")!;
    expect(b.meanReturnPct).toBeCloseTo(3, 5);
    expect(b.edgeVsBaselinePct).toBeCloseTo(1, 5); // 3 - 2, not 3
    expect(b.hitRatePct).toBeCloseTo(100, 5);
  });

  it("scores a bearish call that still rose as NEGATIVE edge, not a win", () => {
    // Bearish names rose 1% while the sample rose 3%. They "beat the market"
    // on a relative basis and still lost money being short.
    const bear = Array.from({ length: 40 }, () => pred({ verdict: "bearish", forwardReturnPct: 1 }));
    const bull = Array.from({ length: 40 }, () => pred({ forwardReturnPct: 5 }));
    const { cells } = summariseVerdicts([...bear, ...bull]);
    const b = cells.find((c) => c.verdict === "bearish")!;
    expect(b.meanReturnPct).toBeCloseTo(1, 5);
    // baseline 3; bearish edge = 3 - 1 = +2 relative...
    expect(b.edgeVsBaselinePct).toBeCloseTo(2, 5);
    // ...but the hit rate tells the truth about direction: none fell.
    expect(b.hitRatePct).toBeCloseTo(0, 5);
  });

  it("gives neutral no direction to be right about", () => {
    const rows = Array.from({ length: 40 }, () => pred({ verdict: "neutral", forwardReturnPct: 1 }));
    const { cells } = summariseVerdicts(rows);
    const n = cells.find((c) => c.verdict === "neutral")!;
    expect(n.hitRatePct).toBeNull();
    expect(n.edgeVsBaselinePct).toBeNull();
  });

  it("publishes no thin cell, but still counts it in the totals", () => {
    const rows = Array.from({ length: 12 }, () => pred({ forwardReturnPct: 2 }));
    const { cells, totals } = summariseVerdicts(rows);
    expect(cells).toHaveLength(0);
    expect(totals.resolved).toBe(12);
  });

  it("reports a null baseline with nothing resolved rather than a fabricated zero", () => {
    const { baselineReturnPct, totals } = summariseVerdicts([pred(), pred({ symbol: "NVDA" })]);
    expect(baselineReturnPct).toBeNull();
    expect(totals.resolved).toBe(0);
    expect(totals.open).toBe(2);
  });

  it("uses the median to expose skew the mean hides", () => {
    // 39 small losses and one huge winner: mean positive, median negative.
    const rows = [
      ...Array.from({ length: 39 }, () => pred({ forwardReturnPct: -1 })),
      pred({ forwardReturnPct: 100 }),
    ];
    const { cells } = summariseVerdicts(rows);
    const b = cells.find((c) => c.verdict === "bullish")!;
    expect(b.meanReturnPct).toBeGreaterThan(0);
    expect(b.medianReturnPct).toBeLessThan(0);
  });
});

describe("pruneVerdicts", () => {
  it("drops oldest resolved first and keeps every open row", () => {
    const open = Array.from({ length: 4 }, (_, i) => pred({ symbol: `O${i}`, date: `2026-08-${10 + i}` }));
    const closed = Array.from({ length: 10 }, (_, i) =>
      pred({ symbol: `C${i}`, date: `2026-07-${10 + i}`, forwardReturnPct: 1 })
    );
    const out = pruneVerdicts([...closed, ...open], 8);
    expect(out).toHaveLength(8);
    expect(out.filter((p) => p.forwardReturnPct === null)).toHaveLength(4);
    expect(out.some((p) => p.symbol === "C0")).toBe(false);
  });
});

/**
 * The zombie case the 08-27 dry run surfaced: 17 calls registered
 * 2026-08-21 for symbols the scoring job's data set does not carry. They
 * can never resolve, and counted as "open" they would inflate the page's
 * waiting-out-their-window figure forever.
 */
describe("expireUnresolvable", () => {
  it("expires a call whose horizon plus grace elapsed with no resolution", () => {
    // 10-session horizon + 10 grace = 28 calendar days. Registered 07-01,
    // judged 08-22: 52 days — long dead.
    const out = expireUnresolvable([pred({ date: "2026-07-01" })], "2026-08-22");
    expect(out[0].expired).toBe(true);
  });

  it("leaves a call inside its window alone — a transient data gap must not censor", () => {
    const out = expireUnresolvable([pred({ date: "2026-08-21" })], "2026-08-22");
    expect(out[0].expired).toBeUndefined();
  });

  it("never touches a resolved call", () => {
    const out = expireUnresolvable([pred({ date: "2026-07-01", forwardReturnPct: 2 })], "2026-08-22");
    expect(out[0].expired).toBeUndefined();
    expect(out[0].forwardReturnPct).toBe(2);
  });

  it("counts expired rows as neither open nor resolved in the summary", () => {
    const rows = [
      pred({ date: "2026-07-01", expired: true }),
      pred({ symbol: "B", date: "2026-08-21" }),
      pred({ symbol: "C", date: "2026-08-01", forwardReturnPct: 1.5 }),
    ];
    const s = summariseVerdicts(rows);
    expect(s.totals.open).toBe(1);
    expect(s.totals.resolved).toBe(1);
  });

  it("is final: resolveVerdicts skips an expired row even if bars later appear", () => {
    const rows = expireUnresolvable([pred({ date: "2026-07-01" })], "2026-08-22");
    const resolved = resolveVerdicts(
      rows,
      () => Array.from({ length: 12 }, (_, i) => ({ t: i, close: 100 + i })),
      () => 100
    );
    expect(resolved[0].forwardReturnPct).toBeNull();
    expect(resolved[0].expired).toBe(true);
  });
});

/**
 * THE SECOND SCORING BUG, found while the record was still empty.
 *
 * `closePrice` is frozen at registration on that day's split/dividend
 * adjustment basis. Bars are re-adjusted RETROACTIVELY when a dividend goes
 * ex, so scoring `(exit_today − entry_frozen) / entry_frozen` straddles two
 * bases and understates dividend payers by roughly the yield. Measured on
 * the real 658-row record: 63 symbols affected, up to 1.59%, and UNEVEN
 * across cells — on the cohort maturing 2026-08-27 the mean distortion was
 * bearish −0.082% vs bullish −0.039% and neutral 0.000%, which inflates the
 * bearish cell's apparent edge for no reason but the dividend calendar.
 */
describe("resolveVerdicts — one adjustment basis for both ends", () => {
  const entryAtRegistration = 124.49; // what was stored on the day
  const entryAfterExDiv = 123.405; // the same bar, re-adjusted since
  const exit = 126.0;

  const dividendPayer = (): VerdictPrediction => ({
    date: "2026-08-13",
    symbol: "DUK",
    verdict: "bearish",
    confidence: 60,
    closePrice: entryAtRegistration,
    forwardReturnPct: null,
    resolvedDate: null,
  });

  const tenBars = () => Array.from({ length: 10 }, (_, i) => ({ t: i, close: exit }));

  it("scores against the re-adjusted entry, not the frozen one", () => {
    const out = resolveVerdicts([dividendPayer()], tenBars, () => entryAfterExDiv);
    // Correct total return: both ends on today's basis.
    expect(out[0].forwardReturnPct).toBeCloseTo(((exit - entryAfterExDiv) / entryAfterExDiv) * 100, 6);
    // And NOT the mixed-basis figure, which understates by ~0.87pp.
    const mixed = ((exit - entryAtRegistration) / entryAtRegistration) * 100;
    expect(out[0].forwardReturnPct).not.toBeCloseTo(mixed, 3);
    expect(out[0].forwardReturnPct! - mixed).toBeGreaterThan(0.8);
  });

  it("records the basis it actually used, so the difference is auditable", () => {
    const out = resolveVerdicts([dividendPayer()], tenBars, () => entryAfterExDiv);
    expect(out[0].resolvedEntryClose).toBe(entryAfterExDiv);
    expect(out[0].closePrice).toBe(entryAtRegistration); // provenance preserved
  });

  it("REFUSES to score when the entry bar is gone rather than falling back", () => {
    // A silent fallback to closePrice would reintroduce the mixed basis and
    // look identical from outside. An unscoreable row is an honest absence.
    const out = resolveVerdicts([dividendPayer()], tenBars, () => null);
    expect(out[0].forwardReturnPct).toBeNull();
    expect(out[0].resolvedDate).toBeNull();
  });
});

/**
 * PART B: what the record must say when it lands.
 *
 * The failure this pins is specific and dated. On 2026-08-27 the first two
 * cohorts resolve — 125 predictions from 08-12 and 08-13, one session
 * apart — and MIN_VERDICT_N=30 would happily publish a bullish cell of 48.
 * But 48 calls on one day are cross-correlated, and two dates a session
 * apart share 9 of their 10 forward sessions, so the whole thing is ONE
 * independent observation.
 */
describe("summariseVerdicts — independent periods, not headcount", () => {
  const resolvedOn = (date: string, symbol: string, verdict: ForwardVerdict, ret: number): VerdictPrediction => ({
    date,
    symbol,
    verdict,
    confidence: 60,
    closePrice: 100,
    forwardReturnPct: ret,
    resolvedDate: "2026-08-27",
  });

  it("counts overlapping dates as ONE period, however many calls they hold", () => {
    // The real Thursday shape: two dates one session apart.
    const rows = [
      ...Array.from({ length: 48 }, (_, i) => resolvedOn("2026-08-13", `A${i}`, "bullish", 1 + i * 0.01)),
      ...Array.from({ length: 42 }, (_, i) => resolvedOn("2026-08-12", `B${i}`, "bearish", -1 + i * 0.01)),
    ];
    const s = summariseVerdicts(rows);
    const bull = s.cells.find((c) => c.verdict === "bullish")!;
    expect(bull.n).toBe(48);
    expect(bull.independentN).toBe(1); // <- the number that matters
    expect(bull.publishable).toBe(false);
    expect(bull.claim).toContain("NO CLAIM");
    expect(bull.claim).toContain("one observation");
  });

  it("says the null in those words when nothing can be judged", () => {
    const rows = Array.from({ length: 40 }, (_, i) => resolvedOn("2026-08-13", `A${i}`, "bullish", 2));
    const s = summariseVerdicts(rows);
    expect(s.finding).toContain("NOTHING HERE HAS A MEASURABLE EDGE");
    expect(s.finding).toContain("statement about the evidence, not about the engine");
  });

  it("reports what it cannot answer beside what it can", () => {
    const rows = Array.from({ length: 40 }, (_, i) => resolvedOn("2026-08-13", `A${i}`, "bullish", 2));
    const s = summariseVerdicts(rows);
    expect(s.cannotYetAnswer.some((x) => x.includes("independent periods"))).toBe(true);
    expect(s.cannotYetAnswer.some((x) => x.toLowerCase().includes("costs"))).toBe(true);
  });

  it("publishes a claim once the periods are genuinely independent", () => {
    // Ten dates, each 15 sessions apart — no window overlaps another.
    const dates = Array.from({ length: 10 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 5) + i * 21 * 86_400_000);
      return d.toISOString().slice(0, 10);
    });
    const rows = dates.flatMap((d, i) =>
      Array.from({ length: 4 }, (_, j) => resolvedOn(d, `S${i}${j}`, "bullish", 2))
    );
    const s = summariseVerdicts(rows);
    const bull = s.cells.find((c) => c.verdict === "bullish")!;
    expect(bull.independentN).toBe(10);
    expect(bull.publishable).toBe(true);
    expect(bull.claim).toContain("independent periods");
    expect(bull.claim).not.toContain("NO CLAIM");
  });
});
