import { describe, it, expect } from "vitest";
import { rankOpportunities, ACTIONABLE_OPPORTUNITY } from "./opportunityRanking";
import { AssetComposite } from "./assetComposite";
import { Verdict } from "./types";

/**
 * Every expected number below is hand-computed from the formula before being
 * asserted, following the discipline metrics.test.ts uses. The ranking decides
 * what a trader looks at first, so the ordering rules are pinned to examples a
 * human can check rather than to a snapshot.
 */

function composite(asset: string, score: number, confidence: number, verdict: Verdict = "neutral"): AssetComposite {
  return {
    asset: asset as AssetComposite["asset"],
    score,
    verdict,
    confidence,
    priceChange24hPct: 0,
    priceChange7dPct: null,
    headline: `${asset} headline`,
  };
}

describe("rankOpportunities", () => {
  it("computes opportunity as conviction x confidence, normalised to 0-100", () => {
    // score 80 -> conviction 30; 30 * 90 = 2700; 2700 / 5000 = 54%.
    const [r] = rankOpportunities([composite("BTC", 80, 90)]);
    expect(r.conviction).toBe(30);
    expect(r.opportunity).toBe(54);
  });

  it("scores a maximally convicted, fully confident read at 100", () => {
    const [r] = rankOpportunities([composite("BTC", 100, 100)]);
    expect(r.opportunity).toBe(100);
  });

  it("treats bullish and bearish conviction symmetrically", () => {
    const ranked = rankOpportunities([composite("UP", 75, 80), composite("DOWN", 25, 80)]);
    expect(ranked[0].opportunity).toBe(ranked[1].opportunity);
  });

  it("ranks a strong read on thin evidence BELOW a weaker read that is well evidenced", () => {
    // The product is the point: 40 conviction x 20% = 800; 20 x 90% = 1800.
    const ranked = rankOpportunities([
      composite("GUESS", 90, 20), // conviction 40, confidence 20 -> 16
      composite("SOLID", 70, 90), // conviction 20, confidence 90 -> 36
    ]);
    expect(ranked.map((r) => r.asset)).toEqual(["SOLID", "GUESS"]);
    expect(ranked[0].opportunity).toBe(36);
    expect(ranked[1].opportunity).toBe(16);
  });

  it("ranks a perfectly evidenced FLAT read at the bottom — it is not a trade", () => {
    const ranked = rankOpportunities([composite("FLAT", 50, 100), composite("WEAK", 55, 30)]);
    expect(ranked[0].asset).toBe("WEAK");
    expect(ranked[1].opportunity).toBe(0);
  });

  it("maps verdict to a trade direction, never inventing one for neutral", () => {
    const ranked = rankOpportunities([
      composite("B", 80, 50, "bullish"),
      composite("S", 20, 50, "bearish"),
      composite("N", 52, 50, "neutral"),
    ]);
    expect(ranked.find((r) => r.asset === "B")!.direction).toBe("long");
    expect(ranked.find((r) => r.asset === "S")!.direction).toBe("short");
    expect(ranked.find((r) => r.asset === "N")!.direction).toBe("none");
  });

  it("is stable across equal opportunity — a list that reshuffles cannot be read", () => {
    // Same conviction and confidence, so only the alphabetical tiebreak differs.
    const input = [composite("ZZZ", 70, 60), composite("AAA", 70, 60)];
    expect(rankOpportunities(input).map((r) => r.asset)).toEqual(["AAA", "ZZZ"]);
    // Reversing the input must not change the output.
    expect(rankOpportunities([...input].reverse()).map((r) => r.asset)).toEqual(["AAA", "ZZZ"]);
  });

  it("breaks an opportunity tie by conviction, preferring the more decisive read", () => {
    // 25 conviction x 40 = 1000 -> 20; 20 conviction x 50 = 1000 -> 20. Tie.
    const ranked = rankOpportunities([composite("LOWCONV", 70, 50), composite("HIGHCONV", 75, 40)]);
    expect(ranked[0].opportunity).toBe(ranked[1].opportunity);
    expect(ranked[0].asset).toBe("HIGHCONV");
  });

  it("passes the engine's own score, verdict, confidence and headline through untouched", () => {
    const [r] = rankOpportunities([composite("BTC", 63, 71, "bullish")]);
    expect(r.score).toBe(63);
    expect(r.verdict).toBe("bullish");
    expect(r.confidence).toBe(71);
    expect(r.headline).toBe("BTC headline");
  });

  it("returns the quiet tail rather than hiding it", () => {
    const ranked = rankOpportunities([composite("FLAT", 50, 90), composite("HOT", 90, 90)]);
    expect(ranked).toHaveLength(2);
    expect(ranked[1].opportunity).toBeLessThan(ACTIONABLE_OPPORTUNITY);
  });

  it("handles an empty universe", () => {
    expect(rankOpportunities([])).toEqual([]);
  });
});
