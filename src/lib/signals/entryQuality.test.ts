import { describe, expect, it } from "vitest";
import { buildEntryQuality, EntryQualityInputs, StarRating } from "./entryQuality";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";

/** A zero-width zone reproduces the old single-price-level behavior exactly (tradeRelevantEdge returns priceHigh for a long, which equals priceLow when the zone has no width) — used wherever a test only cares about placement/filtering, not zone width itself. */
function zone(priceLow: number, priceHigh: number, kind: "support" | "resistance", overrides: Partial<SupportResistanceZone> = {}): SupportResistanceZone {
  return {
    priceLow,
    priceHigh,
    kind,
    strength: 0,
    reactionCount: 1,
    confluence: [],
    status: "inactive",
    mostRecentTouchBarsAgo: null,
    source: "swing-cluster",
    timeframe: "1D",
    ...overrides,
  };
}

function inputs(overrides: Partial<EntryQualityInputs>): EntryQualityInputs {
  return {
    verdict: "bullish",
    confidence: 50,
    agreement: 50,
    price: 100,
    atrPct: 2, // 2% of price -> atrAbs = 2
    supportResistance: [],
    historicalWinRatePct: null,
    historicalWinRateN: null,
    ...overrides,
  };
}

describe("buildEntryQuality — no-entry cases", () => {
  it("returns null for a neutral verdict — no directional entry exists to rate", () => {
    expect(buildEntryQuality(inputs({ verdict: "neutral" }))).toBeNull();
  });

  it("returns null for a non-positive price", () => {
    expect(buildEntryQuality(inputs({ price: 0 }))).toBeNull();
  });

  it("returns null when there's no ATR and no support/resistance level — no honest way to place a stop", () => {
    expect(buildEntryQuality(inputs({ atrPct: null, supportResistance: [] }))).toBeNull();
  });
});

describe("buildEntryQuality — ATR fallback (no qualifying structural levels)", () => {
  it("bullish: places a 1.5x ATR stop and a flat 2:1 target, hand-computed", () => {
    const result = buildEntryQuality(inputs({ verdict: "bullish", price: 100, atrPct: 2, supportResistance: [] }));
    expect(result).not.toBeNull();
    // atrAbs = 2. stop = 100 - 1.5*2 = 97. riskDistance = 3. target = 100 + 2*3 = 106.
    expect(result!.stopPrice).toBeCloseTo(97, 10);
    expect(result!.targetPrice).toBeCloseTo(106, 10);
    expect(result!.riskRewardRatio).toBeCloseTo(2, 10);
    expect(result!.stopBasis).toContain("ATR");
    expect(result!.targetBasis).toContain("2:1");
    // TP2: flat 4:1 fallback — target2 = 100 + 4*3 = 112.
    expect(result!.target2Price).toBeCloseTo(112, 10);
    expect(result!.riskRewardRatio2).toBeCloseTo(4, 10);
    expect(result!.target2Basis).toContain("4:1");
  });

  it("bearish: mirrors the bullish case above with stop/target on the opposite sides", () => {
    const result = buildEntryQuality(inputs({ verdict: "bearish", price: 100, atrPct: 2, supportResistance: [] }));
    expect(result).not.toBeNull();
    // stop = 100 + 1.5*2 = 103. riskDistance = 3. target = 100 - 2*3 = 94.
    expect(result!.stopPrice).toBeCloseTo(103, 10);
    expect(result!.targetPrice).toBeCloseTo(94, 10);
    expect(result!.riskRewardRatio).toBeCloseTo(2, 10);
    // TP2 = 100 - 4*3 = 88.
    expect(result!.target2Price).toBeCloseTo(88, 10);
    expect(result!.riskRewardRatio2).toBeCloseTo(4, 10);
  });
});

describe("buildEntryQuality — structural support/resistance zones", () => {
  it("uses the nearest qualifying support as the stop and the nearest qualifying resistance as the target", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // atrAbs = 2, structural band = [1, 8]
        supportResistance: [
          zone(97, 97, "support"), // distance 3, in-band -> used as stop
          zone(90, 90, "support"), // distance 10, out of band -> ignored
          zone(102, 102, "resistance"), // distance 2, rr = 2/3 = 0.667 < 1.5 -> doesn't qualify
          zone(105, 105, "resistance", { reactionCount: 3, confluence: ["volume-poc"] }), // distance 5, rr = 5/3 = 1.667 >= 1.5 -> qualifies, nearest
          zone(110, 110, "resistance"), // distance 10, rr = 10/3 -> qualifies but farther
        ],
      })
    );
    expect(result).not.toBeNull();
    expect(result!.stopPrice).toBe(97);
    expect(result!.stopBasis).toContain("support zone");
    expect(result!.targetPrice).toBe(105);
    expect(result!.targetBasis).toContain("resistance zone");
    expect(result!.targetBasis).toContain("3 touches");
    expect(result!.targetBasis).toContain("confluence: volume-poc");
    expect(result!.riskRewardRatio).toBeCloseTo(5 / 3, 10);
    // TP2: the only remaining resistance beyond TP1 (105) is 110 — distance
    // 10, rr = 10/3 = 3.33 >= MIN_RR_TP2 (3), so it qualifies structurally.
    expect(result!.target2Price).toBe(110);
    expect(result!.riskRewardRatio2).toBeCloseTo(10 / 3, 10);
  });

  it("TP2 falls back to a flat 4:1 target when nothing beyond TP1 clears the higher bar", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // riskDistance = 3
        supportResistance: [
          zone(97, 97, "support"),
          zone(105, 105, "resistance"), // TP1: rr = 5/3 = 1.667 >= 1.5
          // No resistance beyond 105 clears MIN_RR_TP2 (3) -> TP2 falls back.
        ],
      })
    );
    expect(result!.targetPrice).toBe(105);
    // TP2 = 100 + 4*3 = 112, strictly farther than TP1's 105.
    expect(result!.target2Price).toBeCloseTo(112, 10);
    expect(result!.target2Price).toBeGreaterThan(result!.targetPrice);
    expect(result!.target2Basis).toContain("4:1");
  });

  it("keeps TP2 beyond TP1 even when TP1 alone already clears the flat 4:1 fallback", () => {
    // Regression: the flat fallback used to be a FIXED 4:1, so a structural
    // TP1 farther out than that produced a TP2 nearer to price than TP1 —
    // an inverted pair reporting a worse reward/risk for the farther
    // target. Found by the execution backtest in 37 of 1350 real setups.
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // riskDistance = 3
        supportResistance: [
          zone(97, 97, "support"), // stop
          zone(120, 120, "resistance"), // TP1: rr = 20/3 = 6.67, already past 4:1
          // Nothing beyond 120 -> TP2 must fall back, but not to a flat 112.
        ],
      })
    );
    expect(result!.targetPrice).toBe(120);
    // fallback rr = max(4, 6.667 + 2) = 8.667 -> 100 + 8.667*3 = 126
    expect(result!.target2Price).toBeCloseTo(126, 10);
    expect(result!.target2Price).toBeGreaterThan(result!.targetPrice);
    expect(result!.riskRewardRatio2).toBeGreaterThan(result!.riskRewardRatio);
  });

  it("keeps the same TP2 invariant for a short", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bearish",
        price: 100,
        atrPct: 2, // riskDistance = 3
        supportResistance: [
          zone(103, 103, "resistance"), // stop
          zone(80, 80, "support"), // TP1: rr = 20/3 = 6.67
        ],
      })
    );
    expect(result!.targetPrice).toBe(80);
    expect(result!.target2Price).toBeCloseTo(74, 10); // 100 - 8.667*3
    expect(result!.target2Price).toBeLessThan(result!.targetPrice);
    expect(result!.riskRewardRatio2).toBeGreaterThan(result!.riskRewardRatio);
  });

  it("ignores support/resistance zones on the wrong side of price for the given direction", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2,
        supportResistance: [
          zone(103, 103, "support"), // support ABOVE price -> not a valid long stop
          zone(95, 95, "resistance"), // resistance BELOW price -> not a valid long target
        ],
      })
    );
    // Neither zone qualifies for a long -> falls back to ATR stop / flat 2:1 target, same as the pure fallback case.
    expect(result!.stopPrice).toBeCloseTo(97, 10);
    expect(result!.targetPrice).toBeCloseTo(106, 10);
  });

  it("uses the zone's far edge for the target, not its midpoint or near edge — 'fully cleared', not just 'touched'", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // riskDistance from a 97 stop = 3
        supportResistance: [
          zone(97, 97, "support"),
          // A WIDE resistance zone: near edge 104 (rr = 4/3 = 1.33, doesn't
          // clear MIN_RR 1.5), far edge 112 (rr = 12/3 = 4, clears it). If
          // the target used the near edge or midpoint it would either not
          // qualify at all, or land at 108 — neither is 112.
          zone(104, 112, "resistance"),
        ],
      })
    );
    expect(result!.targetPrice).toBe(112);
  });

  it("uses the zone's near edge for the stop — tighter, more conservative than the midpoint or far edge", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // structural band = [1, 8]
        supportResistance: [
          // A WIDE support zone: near edge (top) 98, far edge (bottom) 92.
          // The near edge is closer to price -> tighter stop.
          zone(92, 98, "support"),
        ],
      })
    );
    expect(result!.stopPrice).toBe(98);
  });

  it("exposes the nearest support/resistance zone regardless of whether it was used as the stop/target", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2,
        supportResistance: [
          zone(97, 97, "support"), // nearest support, also used as the stop
          zone(102, 102, "resistance"), // nearest resistance, does NOT qualify as target (rr too low)
          zone(105, 105, "resistance"),
        ],
      })
    );
    expect(result!.nearestSupport?.priceHigh).toBe(97);
    expect(result!.nearestResistance?.priceLow).toBe(102); // the nearest one, even though 105 was the actual target
  });
});

describe("buildEntryQuality — star rating formula", () => {
  // Fixed ATR-fallback geometry (price 100, atrPct 2, no levels) always yields
  // riskRewardRatio = 2.0 exactly -> rrComponent = clamp(2/3, 0, 1) = 0.6667,
  // contributing a fixed 0.3 * 0.6667 = 0.2 to score01. This isolates the
  // confidence/agreement/winRate terms for hand computation.
  function starsFor(confidence: number, agreement: number, historicalWinRatePct: number | null): StarRating {
    return buildEntryQuality(
      inputs({ confidence, agreement, historicalWinRatePct, historicalWinRateN: historicalWinRatePct === null ? null : 340 })
    )!.stars;
  }

  it("worst-case inputs (0 confidence, 0 agreement, no win-rate data) land at 2 stars", () => {
    // score01 = 0.25*0 + 0.2*0 + 0.2 + 0.25*0.5 = 0.325 -> stars = round(1 + 1.3) = round(2.3) = 2
    expect(starsFor(0, 0, null)).toBe(2);
  });

  it("mid-range inputs (50/50, no win-rate data) land at 3 stars", () => {
    // score01 = 0.25*0.5 + 0.2*0.5 + 0.2 + 0.25*0.5 = 0.55 -> stars = round(1 + 2.2) = round(3.2) = 3
    expect(starsFor(50, 50, null)).toBe(3);
  });

  it("best-case inputs (100 confidence, 100 agreement, 70% win rate) land at 5 stars", () => {
    // winRateComponent = clamp((70-50)/20, 0, 1) = 1
    // score01 = 0.25*1 + 0.2*1 + 0.2 + 0.25*1 = 0.9 -> stars = round(1 + 3.6) = round(4.6) = 5
    expect(starsFor(100, 100, 70)).toBe(5);
  });

  it("clamps an extreme win rate (90%) the same as a 70% one — both saturate winRateComponent at 1", () => {
    expect(starsFor(100, 100, 90)).toBe(starsFor(100, 100, 70));
  });

  it("clamps a below-50% win rate at winRateComponent 0, same as a 0% one", () => {
    expect(starsFor(0, 0, 10)).toBe(starsFor(0, 0, 0));
  });

  it("never returns fewer than 1 or more than 5 stars", () => {
    const s1 = starsFor(0, 0, 0);
    const s5 = starsFor(100, 100, 100);
    expect(s1).toBeGreaterThanOrEqual(1);
    expect(s5).toBeLessThanOrEqual(5);
  });
});

describe("buildEntryQuality — starRationale", () => {
  it("cites the actual reward/risk, confidence, agreement, and win-rate numbers", () => {
    const result = buildEntryQuality(
      inputs({ confidence: 62, agreement: 71, historicalWinRatePct: 58, historicalWinRateN: 340 })
    );
    expect(result!.starRationale).toContain("2.0:1");
    expect(result!.starRationale).toContain("62");
    expect(result!.starRationale).toContain("71");
    expect(result!.starRationale).toContain("58%");
    expect(result!.starRationale).toContain("340");
  });

  it("states plainly when historical win-rate data isn't available, rather than omitting it silently", () => {
    const result = buildEntryQuality(inputs({ historicalWinRatePct: null, historicalWinRateN: null }));
    // Wording tracks the trade-level upgrade: the input is now a measured
    // trade win rate, so the absent-data phrasing names trades, not days.
    expect(result!.starRationale).toContain("aren't enough comparable historical trades");
  });
});
