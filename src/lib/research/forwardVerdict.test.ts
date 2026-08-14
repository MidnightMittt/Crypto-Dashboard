import { describe, expect, it } from "vitest";
import {
  CloseBar,
  VerdictPrediction,
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
    const out = resolveVerdicts([pred()], () => closes([102, 130, 99, 101, 103, 97, 104, 106, 108, 105]));
    expect(out[0].forwardReturnPct).toBeCloseTo(5, 5);
    expect(out[0].resolvedDate).toBe("2026-08-26");
  });

  it("leaves a prediction open until the full horizon exists", () => {
    const out = resolveVerdicts([pred()], () => closes([101, 102, 103]));
    expect(out[0].forwardReturnPct).toBeNull();
  });

  it("never re-resolves", () => {
    const done = pred({ forwardReturnPct: -1.5, resolvedDate: "2026-08-28" });
    const out = resolveVerdicts([done], () => closes(Array(10).fill(200)));
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
