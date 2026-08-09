import { describe, it, expect } from "vitest";
import { findSwingPoints, classifyDivergence } from "./divergence";

/**
 * Every fixture below is a hand-constructed series whose swing points were
 * verified by manually walking each index's window before writing the
 * assertion — same discipline as indicators.test.ts. Divergence is the one
 * place a subtle indexing/alignment bug would be invisible in the UI (a
 * wrong classification still looks like a plausible one), so nothing here
 * is asserted against "whatever the implementation happens to produce."
 */

describe("findSwingPoints", () => {
  it("finds alternating highs and lows with lookback=1", () => {
    const series = [1, 2, 3, 2, 1, 2, 3, 4, 3, 2];
    // Hand-verified: idx2(val3) is a high (neighbors 2,2), idx4(val1) is a
    // low (neighbors 2,2), idx6(val3) is NOT extreme (idx7=4 is higher), and
    // idx7(val4) is a high (neighbors 3,3).
    expect(findSwingPoints(series, 1)).toEqual([
      { index: 2, value: 3, kind: "high" },
      { index: 4, value: 1, kind: "low" },
      { index: 7, value: 4, kind: "high" },
    ]);
  });

  it("returns nothing for a series shorter than 2*lookback+1", () => {
    expect(findSwingPoints([1, 2, 3, 4, 5], 3)).toEqual([]);
  });

  it("treats a flat plateau as not a swing point", () => {
    // idx1 and idx2 are adjacent and tied at 5 — within EITHER one's own
    // window the max isn't unique, so neither is called a swing rather than
    // arbitrarily picking one side of the plateau.
    expect(findSwingPoints([1, 5, 5, 1], 1)).toEqual([]);
  });
});

describe("classifyDivergence", () => {
  it("returns null when the series is too short for any comparable swing", () => {
    expect(classifyDivergence([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeNull();
  });

  it("detects regular bullish divergence: price lower low, indicator higher low", () => {
    // Price: valley at idx5 (100), single hump at idx11 (130, harmless —
    // only 1 high, insufficient for a highs pair), lower valley at idx18
    // (95). Hand-verified swing detection: idx5 window[2..8] min=100
    // unique; idx18 window[15..21] min=95 unique.
    const price = [
      140, 130, 120, 110, 105, 100, 105, 110, 115, 120, 125, 130, 125, 120, 115, 110, 105, 100, 95,
      100, 105, 110, 115, 120, 125,
    ];
    const indicator = new Array(25).fill(50);
    indicator[5] = 20; // prior low
    indicator[18] = 35; // recent low, HIGHER than prior — diverges from price's lower low
    const result = classifyDivergence(price, indicator);
    expect(result?.kind).toBe("regular-bullish");
    expect(result?.priorIndex).toBe(5);
    expect(result?.recentIndex).toBe(18);
  });

  it("detects hidden bullish divergence: price higher low, indicator lower low", () => {
    // Mirror of the regular-bullish fixture with the two valley values
    // swapped (95 then 100, instead of 100 then 95) — hand-verified the
    // same way: idx5 window min=95 unique, idx18 window min=100 unique.
    const price = [
      140, 130, 120, 112, 103, 95, 103, 110, 115, 120, 125, 130, 125, 120, 115, 110, 105, 103, 100,
      105, 110, 115, 120, 125, 130,
    ];
    const indicator = new Array(25).fill(50);
    indicator[5] = 40; // prior low
    indicator[18] = 20; // recent low, LOWER than prior — price's higher low isn't confirmed
    const result = classifyDivergence(price, indicator);
    expect(result?.kind).toBe("hidden-bullish");
    expect(result?.priorIndex).toBe(5);
    expect(result?.recentIndex).toBe(18);
  });

  it("detects regular bearish divergence: price higher high, indicator lower high", () => {
    // Exact negation (240 - x) of the regular-bullish price fixture — flips
    // every min into a max and vice versa, preserving all strict-order
    // relationships, so the same by-hand verification carries over: swing
    // HIGH at idx5 (140) and idx18 (145, higher — price's higher high).
    const price = [
      100, 110, 120, 130, 135, 140, 135, 130, 125, 120, 115, 110, 115, 120, 125, 130, 135, 140, 145,
      140, 135, 130, 125, 120, 115,
    ];
    const indicator = new Array(25).fill(50);
    indicator[5] = 70; // prior high
    indicator[18] = 50; // recent high, LOWER than prior — price's higher high isn't confirmed
    const result = classifyDivergence(price, indicator);
    expect(result?.kind).toBe("regular-bearish");
    expect(result?.priorIndex).toBe(5);
    expect(result?.recentIndex).toBe(18);
  });

  it("detects hidden bearish divergence: price lower high, indicator higher high", () => {
    // Negation of the hidden-bullish price fixture: swing HIGH at idx5
    // (145) and idx18 (140, lower — price's lower high, a downtrend
    // pullback shape).
    const price = [
      100, 110, 120, 128, 137, 145, 137, 130, 125, 120, 115, 110, 115, 120, 125, 130, 135, 137, 140,
      135, 130, 125, 120, 115, 110,
    ];
    const indicator = new Array(25).fill(50);
    indicator[5] = 50; // prior high
    indicator[18] = 70; // recent high, HIGHER than prior — momentum still expanding despite the lower price high
    const result = classifyDivergence(price, indicator);
    expect(result?.kind).toBe("hidden-bearish");
    expect(result?.priorIndex).toBe(5);
    expect(result?.recentIndex).toBe(18);
  });

  it("returns null when price and the indicator move the same way at the compared swings (no divergence)", () => {
    // Reuses the regular-bullish price shape (lower low at 18) but the
    // indicator ALSO makes a lower low — they agree, so nothing diverges.
    const price = [
      140, 130, 120, 110, 105, 100, 105, 110, 115, 120, 125, 130, 125, 120, 115, 110, 105, 100, 95,
      100, 105, 110, 115, 120, 125,
    ];
    const indicator = new Array(25).fill(50);
    indicator[5] = 40;
    indicator[18] = 20; // also lower — confirms, doesn't diverge
    expect(classifyDivergence(price, indicator)).toBeNull();
  });

  it("prefers the more recent divergence when both a lows-pair and a highs-pair qualify", () => {
    // Hand-verified swing map for this fixture (lookback=1): HIGHS at
    // {1:20, 8:28, 12:30, 18:35}, LOWS at {2:5, 9:2, 13:25} — every index
    // checked against its immediate 3-value window by hand. The lows pair
    // resolves to (2, 13) — not (2, 9) — because idx9's nearest earlier low
    // partner within the gap requirement is 2, not 9 itself (9 and 13 are
    // only 4 bars apart, under MIN_SWING_GAP). The highs pair resolves to
    // (12, 18). Indicator values are set so BOTH pairs qualify as real
    // divergences, with the highs pair's recentIndex (18) later than the
    // lows pair's (13) — expect the highs-based (later) result to win.
    const price = [10, 20, 5, 15, 20, 22, 24, 26, 28, 2, 15, 20, 30, 25, 26, 27, 28, 29, 35, 20];
    const indicator = new Array(20).fill(50);
    indicator[2] = 60;
    indicator[13] = 30; // lows pair (2,13): price higher low (5->25), indicator lower low -> hidden-bullish
    indicator[12] = 70;
    indicator[18] = 40; // highs pair (12,18): price higher high (30->35), indicator lower high -> regular-bearish, later

    const result = classifyDivergence(price, indicator, 1);
    expect(result?.kind).toBe("regular-bearish");
    expect(result?.recentIndex).toBe(18);
  });
});
