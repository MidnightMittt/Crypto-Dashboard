import { describe, expect, it } from "vitest";
import { buildEntryQuality, EntryQualityInputs, StarRating } from "./entryQuality";

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

describe("buildEntryQuality — structural support/resistance", () => {
  it("uses the nearest qualifying support as the stop and the nearest qualifying resistance as the target", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // atrAbs = 2, structural band = [1, 8]
        supportResistance: [
          { price: 97, kind: "support", source: "swing-low" }, // distance 3, in-band -> used as stop
          { price: 90, kind: "support", source: "swing-low" }, // distance 10, out of band -> ignored
          { price: 102, kind: "resistance", source: "swing-high" }, // distance 2, rr = 2/3 = 0.667 < 1.5 -> doesn't qualify
          { price: 105, kind: "resistance", source: "volume-poc" }, // distance 5, rr = 5/3 = 1.667 >= 1.5 -> qualifies, nearest
          { price: 110, kind: "resistance", source: "fib-level" }, // distance 10, rr = 10/3 -> qualifies but farther
        ],
      })
    );
    expect(result).not.toBeNull();
    expect(result!.stopPrice).toBe(97);
    expect(result!.stopBasis).toContain("swing-low");
    expect(result!.targetPrice).toBe(105);
    expect(result!.targetBasis).toContain("volume-poc");
    expect(result!.riskRewardRatio).toBeCloseTo(5 / 3, 10);
    // TP2: the only remaining resistance beyond TP1 (105) is 110 — distance
    // 10, rr = 10/3 = 3.33 >= MIN_RR_TP2 (3), so it qualifies structurally.
    expect(result!.target2Price).toBe(110);
    expect(result!.target2Basis).toContain("fib-level");
    expect(result!.riskRewardRatio2).toBeCloseTo(10 / 3, 10);
  });

  it("TP2 falls back to a flat 4:1 target when nothing beyond TP1 clears the higher bar", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2, // riskDistance = 3
        supportResistance: [
          { price: 97, kind: "support", source: "swing-low" },
          { price: 105, kind: "resistance", source: "volume-poc" }, // TP1: rr = 5/3 = 1.667 >= 1.5
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

  it("ignores support/resistance levels on the wrong side of price for the given direction", () => {
    const result = buildEntryQuality(
      inputs({
        verdict: "bullish",
        price: 100,
        atrPct: 2,
        supportResistance: [
          { price: 103, kind: "support", source: "swing-low" }, // support ABOVE price -> not a valid long stop
          { price: 95, kind: "resistance", source: "swing-high" }, // resistance BELOW price -> not a valid long target
        ],
      })
    );
    // Neither level qualifies for a long -> falls back to ATR stop / flat 2:1 target, same as the pure fallback case.
    expect(result!.stopPrice).toBeCloseTo(97, 10);
    expect(result!.targetPrice).toBeCloseTo(106, 10);
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
    expect(result!.starRationale).toContain("isn't available");
  });
});
