import { describe, expect, it } from "vitest";
import { buildHarmonicEvidence, selectBestHarmonic, HarmonicContext, HarmonicEvidence } from "./harmonicEvidence";
import { Candle } from "@/lib/technicals/indicators";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { Verdict } from "./types";

/** Same mirrored-padding zigzag builder as harmonics.test.ts — see that file's own comment for why the padding exists. */
function buildZigzag(vertices: number[], barsPerLeg = 8): Candle[] {
  const n = vertices.length;
  const leadIn = vertices[1];
  const leadOut = vertices[n - 2];
  const padded = [leadIn, ...vertices, leadOut];
  const candles: Candle[] = [];
  let t = 0;
  const DAY = 86_400_000;
  const push = (price: number) => {
    candles.push({ t, open: price, high: price, low: price, close: price, volumeUsd: 0 });
    t += DAY;
  };
  push(padded[0]);
  for (let i = 1; i < padded.length; i++) {
    const from = padded[i - 1];
    const to = padded[i];
    for (let s = 1; s <= barsPerLeg; s++) push(from + ((to - from) * s) / barsPerLeg);
  }
  return candles;
}

/** Appends `extra` flat-price bars after the given candles, continuing the timestamp sequence. Used to advance "current price" past C without introducing new pivots that would change which candidate is latest. */
function extend(candles: Candle[], prices: number[]): Candle[] {
  const DAY = 86_400_000;
  let t = candles[candles.length - 1].t + DAY;
  const out = [...candles];
  for (const p of prices) {
    out.push({ t, open: p, high: p, low: p, close: p, volumeUsd: 0 });
    t += DAY;
  }
  return out;
}

/**
 * Appends one bar with a genuine wick: trades down to `wickTo` (testing a
 * zone) but closes back at `closeAt` — a real rejection candle. `extend`'s
 * flat dot-candles can't represent this (open=high=low=close all equal),
 * which is exactly why "touch the PRZ, then close back outside it" needs
 * its own helper rather than two separate flat bars.
 */
function appendWickBar(candles: Candle[], wickTo: number, closeAt: number): Candle[] {
  const t = candles[candles.length - 1].t + 86_400_000;
  const [low, high] = wickTo < closeAt ? [wickTo, closeAt] : [closeAt, wickTo];
  return [...candles, { t, open: wickTo, high, low, close: closeAt, volumeUsd: 0 }];
}

const X = 100, A = 200, B = 138.2, C = 176.38; // the same textbook bullish Gartley harmonics.test.ts verifies
const ATR = 10;

function zone(kind: "support" | "resistance", priceLow: number, priceHigh: number, tf: "1D" | "4H" | "both" = "1D"): SupportResistanceZone {
  return { priceLow, priceHigh, kind, strength: 60, reactionCount: 3, confluence: [], status: "inactive", mostRecentTouchBarsAgo: 5, source: "swing-cluster", timeframe: tf };
}

function ctx(overrides: Partial<HarmonicContext> = {}): HarmonicContext {
  return {
    candles: buildZigzag([X, A, B, C]),
    timeframe: "1D",
    atrAbs: ATR,
    price: 190, // far above the PRZ (~114-133) — the pattern hasn't been approached yet
    zones: [],
    biasVerdict: null,
    metricVerdicts: new Map(),
    currentDivergence: { rsi: null, macd: null },
    ...overrides,
  };
}

function gartley(evidence: HarmonicEvidence[]): HarmonicEvidence | undefined {
  return evidence.find((e) => e.pattern === "Gartley" && e.direction === "bullish");
}

describe("buildHarmonicEvidence — status lifecycle", () => {
  it("reads PRZ-PROJECTED while price is far away", () => {
    const g = gartley(buildHarmonicEvidence(ctx({ price: 190 })))!;
    expect(g).toBeDefined();
    expect(g.status).toBe("prz-projected");
    expect(g.distanceAtr).toBeGreaterThan(1.5);
  });

  it("reads APPROACHING within the configured ATR band, without yet touching the PRZ", () => {
    // PRZ ~[114.58, 133.24]; a price just above the high edge but within 1.5 ATR (15) counts as approaching.
    const g = gartley(buildHarmonicEvidence(ctx({ price: 140 })))!;
    expect(g.status).toBe("approaching");
    expect(g.distanceAtr).toBeGreaterThan(0);
    expect(g.distanceAtr).toBeLessThanOrEqual(1.5);
  });

  it("reads INSIDE-PRZ the instant price sits within the zone, before any candles have tested it", () => {
    const g = gartley(buildHarmonicEvidence(ctx({ price: 125 })))!;
    expect(g.status).toBe("inside-prz");
    expect(g.distanceAtr).toBe(0);
  });

  it("reads CONFIRMATION-PENDING once a candle has actually traded into the PRZ", () => {
    const withTest = extend(buildZigzag([X, A, B, C]), [180, 150, 125, 122]); // walks price down into the PRZ, closes inside it
    const g = gartley(buildHarmonicEvidence(ctx({ candles: withTest, price: 122 })))!;
    expect(g.status).toBe("confirmation-pending");
    expect(g.przTested).toBe(true);
    expect(g.structureReaction).toBe("none-yet");
  });

  it("reads TRADEABLE once price rejects out of the PRZ AND the regime agrees", () => {
    // Approach, then one bar with a real wick: trades down INTO the PRZ
    // (low=122) but closes back ABOVE it (close=140) — the bullish rejection.
    const withRejection = appendWickBar(extend(buildZigzag([X, A, B, C]), [180, 150]), 122, 140);
    const g = gartley(buildHarmonicEvidence(ctx({ candles: withRejection, price: 140, biasVerdict: "bullish" })))!;
    expect(g.structureReaction).toBe("rejection");
    expect(g.status).toBe("tradeable");
  });

  it("downgrades a confirmed rejection to CONFIRMED (not tradeable) when it is counter-trend to the Daily bias", () => {
    const withRejection = appendWickBar(extend(buildZigzag([X, A, B, C]), [180, 150]), 122, 140);
    const g = gartley(buildHarmonicEvidence(ctx({ candles: withRejection, price: 140, biasVerdict: "bearish" })))!;
    expect(g.regimeAlignment).toBe("counter-trend");
    expect(g.status).toBe("confirmed");
  });

  it("reads INVALIDATED once price closes beyond X, and never reverts to any other status", () => {
    const brokenX = extend(buildZigzag([X, A, B, C]), [180, 150, 95]); // closed below X=100
    const g = gartley(buildHarmonicEvidence(ctx({ candles: brokenX, price: 95 })));
    // Invalidated candidates are filtered out of the returned list entirely
    // (buildHarmonicEvidence's own contract) — the correct way to "never
    // influence the decision engine again" per the brief's §24.
    expect(g).toBeUndefined();
  });

  it("reads EXPIRED once the pattern has aged well past its own leg's formation time without ever testing the PRZ", () => {
    // legBars for X-A-B-C here is C.index - X.index = 24 (3 legs * 8 bars).
    // EXPIRY_LEG_MULTIPLE=2 means expiry after 48 bars since C with no test.
    const stale = extend(buildZigzag([X, A, B, C]), Array(60).fill(190)); // sits far above the PRZ, never approaches
    const g = gartley(buildHarmonicEvidence(ctx({ candles: stale, price: 190 })));
    expect(g).toBeUndefined();
  });
});

describe("support/resistance confluence", () => {
  it("flags genuine overlap with an existing, independently-derived support zone", () => {
    const zones = [zone("support", 120, 130)]; // overlaps the Gartley PRZ [114.58, 133.24]
    const g = gartley(buildHarmonicEvidence(ctx({ zones, price: 190 })))!;
    expect(g.srConfluence).toBe(true);
    expect(g.srConfluenceDetail).toContain("support");
    expect(g.summary).toContain("overlaps");
  });

  it("does not fabricate confluence when zones exist but don't overlap the PRZ", () => {
    const zones = [zone("support", 50, 60)]; // nowhere near [114.58, 133.24]
    const g = gartley(buildHarmonicEvidence(ctx({ zones, price: 190 })))!;
    expect(g.srConfluence).toBe(false);
    expect(g.srConfluenceDetail).toBeNull();
  });

  it("only matches zones on the DIRECTION-CORRECT side — a bullish PRZ needs support, not resistance", () => {
    const zones = [zone("resistance", 120, 130)]; // same price range, wrong kind
    const g = gartley(buildHarmonicEvidence(ctx({ zones, price: 190 })))!;
    expect(g.srConfluence).toBe(false);
  });
});

describe("regime and derivatives alignment — labeled, never used to suppress the candidate", () => {
  it("labels aligned/counter-trend/regime-neutral correctly, and the candidate is returned in every case", () => {
    for (const [verdict, expected] of [
      ["bullish", "aligned"],
      ["bearish", "counter-trend"],
      ["neutral", "regime-neutral"],
      [null, "regime-neutral"],
    ] as const) {
      const g = gartley(buildHarmonicEvidence(ctx({ biasVerdict: verdict, price: 190 })))!;
      expect(g).toBeDefined();
      expect(g.regimeAlignment).toBe(expected);
    }
  });

  it("reports derivatives alignment from ALREADY-SCORED metrics, never recomputing them", () => {
    const metricVerdicts = new Map<string, Verdict>([["funding", "bullish"], ["squeezeRisk", "bullish"]]);
    const g = gartley(buildHarmonicEvidence(ctx({ metricVerdicts, price: 190 })))!;
    expect(g.derivatives.aligned).toBe(true);
    expect(g.derivatives.detail).toContain("funding");
  });

  it("reports no derivatives read rather than a fabricated neutral when nothing reported", () => {
    const g = gartley(buildHarmonicEvidence(ctx({ metricVerdicts: new Map(), price: 190 })))!;
    expect(g.derivatives.aligned).toBeNull();
  });
});

describe("geometry vs confirmation stay structurally separate", () => {
  it("a tested-but-unconfirmed PRZ never reads as confirmed regardless of geometry quality", () => {
    const withTest = extend(buildZigzag([X, A, B, C]), [180, 150, 125, 122]);
    const g = gartley(buildHarmonicEvidence(ctx({ candles: withTest, price: 122 })))!;
    expect(g.geometryQuality).toBeGreaterThan(0.8); // exact textbook ratios
    expect(g.status).not.toBe("confirmed");
    expect(g.status).not.toBe("tradeable");
    expect(g.summary).not.toContain("confirmed");
  });
});

describe("selectBestHarmonic", () => {
  const daily = (status: HarmonicEvidence["status"], overrides: Partial<HarmonicEvidence> = {}): HarmonicEvidence => ({
    pattern: "Gartley", direction: "bullish", timeframe: "1D", status, geometryQuality: 0.9,
    przLow: 100, przHigh: 110, przConvergenceCount: 3, distanceAtr: 0, przTested: true,
    structureReaction: null, divergence: null, regimeAlignment: "aligned",
    derivatives: { aligned: null, detail: "" }, higherTimeframeConfluence: false,
    srConfluence: false, srConfluenceDetail: null, invalidated: false, invalidationPrice: 90,
    summary: "test", ...overrides,
  });

  it("Daily outranks 4H at the SAME status tier", () => {
    const d = daily("approaching");
    const h = { ...daily("approaching"), timeframe: "4H" as const };
    expect(selectBestHarmonic([d], [h])?.timeframe).toBe("1D");
  });

  it("a further-along 4H candidate can outrank a merely-projected Daily one", () => {
    const d = daily("prz-projected");
    const h = { ...daily("tradeable"), timeframe: "4H" as const };
    expect(selectBestHarmonic([d], [h])?.status).toBe("tradeable");
  });

  it("sets higherTimeframeConfluence when the OTHER timeframe agrees on direction", () => {
    const d = daily("tradeable");
    const h = { ...daily("approaching"), timeframe: "4H" as const, direction: "bullish" as const };
    expect(selectBestHarmonic([d], [h])?.higherTimeframeConfluence).toBe(true);
  });

  it("does not set confluence when the other timeframe disagrees on direction", () => {
    const d = daily("tradeable");
    const h = { ...daily("approaching"), timeframe: "4H" as const, direction: "bearish" as const };
    expect(selectBestHarmonic([d], [h])?.higherTimeframeConfluence).toBe(false);
  });

  it("returns null when nothing is detected on either timeframe", () => {
    expect(selectBestHarmonic([], [])).toBeNull();
  });
});

describe("look-ahead safety at the evidence layer", () => {
  it("status computed from a point-in-time-truncated candle series matches what the same evidence would show live at that instant", () => {
    const full = extend(buildZigzag([X, A, B, C]), [180, 150, 125, 122, 140, 160]);
    // Truncate to exactly the bars that existed the moment price first closed at 122 (inside the PRZ, pre-rejection).
    const cutIndex = full.findIndex((c) => c.close === 122);
    const truncated = full.slice(0, cutIndex + 1);

    const truncatedG = gartley(buildHarmonicEvidence(ctx({ candles: truncated, price: 122 })))!;
    expect(truncatedG.status).toBe("confirmation-pending");
    // The later rejection (140) must NOT be visible in the truncated evidence.
    expect(truncatedG.structureReaction).toBe("none-yet");
  });
});
