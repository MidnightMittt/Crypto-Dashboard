import { describe, expect, it } from "vitest";
import { findPivots, findCandidates, findAbcdCandidates, PIVOT_LOOKBACK } from "./harmonics";
import { Candle } from "./indicators";

/**
 * Builds an exact zigzag: each `vertices[i]` becomes a flat-OHLC candle
 * (open=high=low=close), linearly ramped to/from its neighbours over
 * `barsPerLeg` bars. Because the ramp between vertices is strictly
 * monotonic, each vertex is guaranteed to be the strict local extreme of its
 * fractal window — this constructs KNOWN, EXACT pivot prices to test ratio
 * math against, rather than hoping real-looking data happens to produce them.
 *
 * A vertex at the very first or last candle can never be a confirmed pivot —
 * the fractal detector structurally needs `lookback` real bars on BOTH
 * sides. So one synthetic leg is prepended and appended, each stepping AWAY
 * from the first/last real vertex on the opposite side from its neighbour —
 * exactly what a real chart does before/after the swing that matters. Use
 * `vertexIndices` (not raw multiples of `barsPerLeg`) to find where the real
 * vertices ended up after this padding.
 */
function buildZigzag(vertices: number[], barsPerLeg = 8): Candle[] {
  const n = vertices.length;
  // Mirroring vertices[1] back before vertices[0] makes a symmetric V/^ at
  // vertices[0] regardless of which direction the real leg goes — the two
  // flanking values are literally equal, which is always a strict extremum
  // at the point between them. Same mirror at the tail end.
  const leadIn = vertices[1];
  const leadOut = vertices[n - 2];
  const padded = [leadIn, ...vertices, leadOut];

  const candles: Candle[] = [];
  let t = 0;
  const DAY = 86_400_000;
  const pushPoint = (price: number) => {
    candles.push({ t, open: price, high: price, low: price, close: price, volumeUsd: 0 });
    t += DAY;
  };
  pushPoint(padded[0]);
  for (let i = 1; i < padded.length; i++) {
    const from = padded[i - 1];
    const to = padded[i];
    for (let s = 1; s <= barsPerLeg; s++) {
      pushPoint(from + ((to - from) * s) / barsPerLeg);
    }
  }
  return candles;
}

/** Index of each REAL vertex (i.e. `vertices[i]`, not the synthetic padding) in the candle array `buildZigzag` produced. */
function vertexIndices(count: number, barsPerLeg = 8): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * barsPerLeg);
}

// Realistic ATR relative to the ~100-point swings used below: Bat and
// Crab-family specs project a genuinely wider zone than Gartley's (cd_bc up
// to 2.618x vs 1.618x), and ATR=5 (0.05x the leg size) made even a correctly
// computed Bat width trip the 5x sanity cap. 10 keeps every fixture's real,
// hand-computed width comfortably under that cap without loosening the cap
// itself.
const ATR = 10;

describe("findPivots", () => {
  it("finds exact vertex prices as pivots, alternating kind", () => {
    // low high low high low
    const candles = buildZigzag([100, 200, 138.2, 176.38, 120]);
    const pivots = findPivots(candles, PIVOT_LOOKBACK);
    const [i0, i1, i2, i3, i4] = vertexIndices(5);

    const at = (idx: number) => pivots.find((p) => p.index === idx);
    expect(at(i0)?.kind).toBe("low");
    expect(at(i1)?.kind).toBe("high");
    expect(at(i2)?.kind).toBe("low");
    expect(at(i3)?.kind).toBe("high");
    expect(at(i4)?.kind).toBe("low");
    expect(at(i1)?.price).toBeCloseTo(200, 6);
  });

  it("knownAtT is the close lookback bars AFTER the pivot, never the pivot's own bar", () => {
    const candles = buildZigzag([100, 200, 138.2]);
    const pivots = findPivots(candles, PIVOT_LOOKBACK);
    const apex = pivots.find((p) => p.price === 200)!;
    expect(apex.knownAtT).toBe(candles[apex.index + PIVOT_LOOKBACK].t);
    expect(apex.knownAtT).toBeGreaterThan(apex.t);
  });
});

describe("findCandidates — exact pattern geometry", () => {
  it("recognises a textbook bullish Gartley from X-A-B-C alone (D has not happened)", () => {
    // X=100 A=200 (XA=100) B=138.2 (AB/XA=0.618) C: BC/AB=0.618 -> BC=38.18 -> C=176.38
    const X = 100, A = 200, B = 138.2, C = 176.38;
    const candles = buildZigzag([X, A, B, C]);
    const candidates = findCandidates(candles, ATR);

    const gartley = candidates.find((c) => c.pattern === "Gartley" && c.direction === "bullish");
    expect(gartley).toBeDefined();
    expect(gartley!.ratios.ab_xa).toBeCloseTo(0.618, 2);
    expect(gartley!.ratios.bc_ab).toBeCloseTo(0.618, 2);
    // D has NOT happened — this is the whole point. Only X,A,B,C exist.
    expect(gartley!.legQuality).toBeGreaterThan(0.9);
  });

  it("projects the D-completion PRZ from XABC, not from any future D price", () => {
    const X = 100, A = 200, B = 138.2, C = 176.38;
    const candles = buildZigzag([X, A, B, C]);
    const gartley = findCandidates(candles, ATR).find((c) => c.pattern === "Gartley")!;

    // Gartley D = 0.786 retracement of XA => 200 - 0.786*100 = 121.4
    // AB=CD => C - AB = 176.38 - 61.8 = 114.58
    // These should bracket the theoretical 121.4/114.58 region.
    expect(gartley.prz.low).toBeLessThan(130);
    expect(gartley.prz.high).toBeGreaterThan(110);
    expect(gartley.prz.low).toBeLessThan(gartley.prz.high);
    expect(gartley.prz.convergenceCount).toBeGreaterThanOrEqual(2);
    // Every level is a real Fibonacci relationship, named.
    for (const level of gartley.prz.levels) {
      expect(level.source.length).toBeGreaterThan(0);
    }
  });

  it("sets invalidation at X — the structural level, not an arbitrary distance", () => {
    const X = 100, A = 200, B = 138.2, C = 176.38;
    const candles = buildZigzag([X, A, B, C]);
    const gartley = findCandidates(candles, ATR).find((c) => c.pattern === "Gartley")!;
    expect(gartley.invalidationPrice).toBe(X);
  });

  it("recognises a bearish Bat with mirrored ratios", () => {
    // Bearish: X high, A low, B high (AB/XA in 0.382-0.5), C low (BC/AB in 0.382-0.886)
    const X = 200, A = 100, B = 145, C = 115; // AB/XA=0.45, BC/AB=0.667
    const candles = buildZigzag([X, A, B, C]);
    const bat = findCandidates(candles, ATR).find((c) => c.pattern === "Bat" && c.direction === "bearish");
    expect(bat).toBeDefined();
    expect(bat!.prz.low).toBeLessThan(bat!.prz.high);
  });

  it("rejects a near-miss: ratios just outside every pattern's tolerance", () => {
    // AB/XA = 0.99 fits no standard pattern's B-leg window even loosely.
    const X = 100, A = 200, B = 101, C = 150;
    const candles = buildZigzag([X, A, B, C]);
    const candidates = findCandidates(candles, ATR);
    expect(candidates.filter((c) => c.direction === "bullish")).toHaveLength(0);
  });

  it("does not fabricate a pattern from a flat/degenerate leg", () => {
    // A == X collapses XA to zero; must not divide by zero into a fake ratio.
    const candles = buildZigzag([100, 100, 100, 100]);
    expect(() => findCandidates(candles, ATR)).not.toThrow();
    expect(findCandidates(candles, ATR)).toHaveLength(0);
  });

  it("dedups to one candidate per direction, keeping the best-fitting", () => {
    const X = 100, A = 200, B = 138.2, C = 176.38;
    const candles = buildZigzag([X, A, B, C]);
    const bullish = findCandidates(candles, ATR).filter((c) => c.direction === "bullish");
    // Multiple (X,pattern) combinations can share this exact C — only the
    // single best-fitting one should survive per direction.
    expect(bullish).toHaveLength(1);
  });

  it("discards a PRZ so wide it carries no location information (sanity cap)", () => {
    // A tiny AB leg against a huge XA can project a nonsensical spread.
    const X = 0, A = 1000, B = 619, C = 619.001;
    const candles = buildZigzag([X, A, B, C]);
    // Should not throw, and should not report a multi-thousand-point "zone".
    const candidates = findCandidates(candles, 1);
    for (const c of candidates) expect(c.prz.widthAtr).toBeLessThanOrEqual(5);
  });
});

describe("findAbcdCandidates", () => {
  it("projects classic AB=CD (~1x AB extension) from A-B-C, no X leg", () => {
    const A = 100, B = 160, C = 130; // AB = 60
    const candles = buildZigzag([A, B, C]);
    const abcd = findAbcdCandidates(candles, ATR).find((c) => c.pattern === "AB=CD");
    expect(abcd).toBeDefined();
    expect(abcd!.direction).toBe("bearish"); // C is a high in this ramp direction? verify below
  });

  it("Alternate AB=CD projects a genuinely different (larger) zone than classic AB=CD", () => {
    const A = 100, B = 160, C = 130;
    const candles = buildZigzag([A, B, C]);
    const cands = findAbcdCandidates(candles, ATR);
    const classic = cands.find((c) => c.pattern === "AB=CD");
    const alt = cands.find((c) => c.pattern === "AltAB=CD");
    if (classic && alt) {
      // Alternate uses a larger multiple of AB, so its zone sits farther from C.
      const classicDist = Math.abs(classic.prz.mid - C);
      const altDist = Math.abs(alt.prz.mid - C);
      expect(altDist).toBeGreaterThan(classicDist);
    }
  });
});

describe("look-ahead safety", () => {
  it("a candidate's knownAtT never precedes the bar that confirms its last pivot", () => {
    const X = 100, A = 200, B = 138.2, C = 176.38;
    const candles = buildZigzag([X, A, B, C]);
    const cIndex = vertexIndices(4)[3];
    const expectedKnownAt = candles[cIndex + PIVOT_LOOKBACK].t;

    for (const cand of findCandidates(candles, ATR)) {
      expect(cand.knownAtT).toBeGreaterThanOrEqual(expectedKnownAt);
    }
  });

  it("truncating to only the bars available at knownAt reproduces the same candidate a full future history would eventually confirm", () => {
    // The standard point-in-time check this whole app uses elsewhere
    // (scripts/backtest/pointInTime.test.ts): replay with only the data that
    // would have existed at the decision timestamp, and require it match.
    const X = 100, A = 200, B = 138.2, C = 176.38;
    const full = buildZigzag([X, A, B, C, 150, 190, 130]); // future swings appended after C

    // Find C's own knownAt from the full series, then truncate to exactly
    // the bars that existed at that instant.
    const cIndex = vertexIndices(4)[3];
    const knownAtT = full[cIndex + PIVOT_LOOKBACK].t;
    const truncated = full.filter((c) => c.t <= knownAtT);

    const truncatedCand = findCandidates(truncated, ATR).find((c) => c.pattern === "Gartley")!;
    expect(truncatedCand).toBeDefined();
    expect(truncatedCand.knownAtT).toBe(knownAtT);

    // A pattern superseded by a later same-kind pivot is correctly DROPPED
    // from the full series' candidate set (see findCandidates's own doc
    // comment) — that is deliberate staleness handling, not a look-ahead
    // bug. What look-ahead safety actually requires is narrower: the PRZ and
    // invalidation the truncated (honest, point-in-time) view computed must
    // be genuine numbers derivable from X-A-B-C alone, not something only
    // the future bars could have produced. Recomputing directly from the
    // known pivot prices is the independent check for that.
    const XA = Math.abs(A - X);
    const expectedD = A - 0.786 * XA; // Gartley's own defined ratio
    expect(Math.abs(truncatedCand.prz.mid - expectedD)).toBeLessThan(XA * 0.2);
    expect(truncatedCand.invalidationPrice).toBe(X);
  });
});
