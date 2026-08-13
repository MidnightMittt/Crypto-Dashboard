import { describe, expect, it } from "vitest";
import { equityVerdict } from "./equityVerdict";
import { MarketBias } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal } from "@/lib/signals/tradePlan";

const bias = (over: Partial<MarketBias> = {}): MarketBias =>
  ({
    asset: "SPY",
    basis: "state",
    score: 70,
    verdict: "bullish",
    confidence: 60,
    agreement: 100,
    headline: "",
    topBullish: [],
    topBearish: [],
    opportunity: null,
    counterRisk: null,
    watchNext: [],
    changes: [],
    isFirstReading: true,
    riskLevel: "low",
    riskRationale: "",
    metrics: [],
    categories: [],
    trendStrength: null,
    updatedAt: 0,
    ...over,
  }) as MarketBias;

const plan = { riskRewardRatio: 2 } as TradePlan;

describe("equityVerdict", () => {
  it("says BULLISH with a plan behind it", () => {
    const v = equityVerdict({ bias: bias({ verdict: "bullish", confidence: 80 }), plan, refusal: null });
    expect(v.word).toBe("BULLISH");
    expect(v.emoji).toBe("🟢");
    expect(v.action).toBe("buy");
    expect(v.sentence).toContain("plan below");
  });

  it("says BEARISH for the mirror case", () => {
    const v = equityVerdict({ bias: bias({ verdict: "bearish", score: 30, confidence: 80 }), plan, refusal: null });
    expect(v.word).toBe("BEARISH");
    expect(v.emoji).toBe("🔴");
    expect(v.action).toBe("sell");
  });

  it("NEVER says bullish when the plan was refused — the word survives the gate", () => {
    /*
     * The defect this whole module exists to prevent: a green BULLISH
     * headline sitting above machinery that just declined to offer a trade.
     */
    const refusals: TradePlanRefusal[] = [
      "no-structure",
      "stop-inside-noise",
      "reward-too-small",
      "negative-expectancy",
      "earnings-imminent",
      "target-beyond-winners-reach",
    ];
    for (const refusal of refusals) {
      const v = equityVerdict({ bias: bias({ verdict: "bullish" }), plan: null, refusal });
      expect(v.word, refusal).toBe("WAIT");
      expect(v.emoji, refusal).toBe("🟡");
      expect(v.action, refusal).toBe("wait");
      expect(v.sentence, refusal).not.toContain("plan below");
    }
  });

  it("states the refusal in plain words, not engine vocabulary", () => {
    const v = equityVerdict({ bias: bias(), plan: null, refusal: "stop-inside-noise" });
    expect(v.sentence).toContain("normal daily movement");
    expect(v.sentence).not.toContain("ATR");
    expect(v.sentence).not.toContain("structural");
  });

  it("names the date to wait for when earnings caused the refusal", () => {
    const v = equityVerdict({
      bias: bias(),
      plan: null,
      refusal: "earnings-imminent",
      earningsDate: "2026-08-18",
    });
    expect(v.sentence).toContain("Earnings land within three trading days");
    expect(v.sentence).toContain("Reconsider after 2026-08-18");
  });

  it("omits the date when earnings is the reason but no date is known", () => {
    const v = equityVerdict({ bias: bias(), plan: null, refusal: "earnings-imminent" });
    expect(v.sentence).not.toContain("Reconsider after");
  });

  it("calls a neutral read NO EDGE and explains the band rather than hedging", () => {
    const v = equityVerdict({ bias: bias({ verdict: "neutral", score: 52 }), plan: null, refusal: null });
    expect(v.word).toBe("NO EDGE");
    expect(v.emoji).toBe("⚪");
    expect(v.action).toBe("stand-aside");
    expect(v.sentence).toContain("2 points from neutral");
    expect(v.sentence).toContain("finding rather than a failure");
  });

  it("singularises the distance at exactly one point", () => {
    const v = equityVerdict({ bias: bias({ verdict: "neutral", score: 51 }), plan: null, refusal: null });
    expect(v.sentence).toContain("1 point from neutral");
  });

  it("warns about position size when the evidence is thin", () => {
    const v = equityVerdict({ bias: bias({ confidence: 28 }), plan, refusal: null });
    expect(v.sentence).toContain("size it small");
  });

  it("calls a partial read a lean rather than a conviction trade", () => {
    const v = equityVerdict({ bias: bias({ confidence: 50 }), plan, refusal: null });
    expect(v.sentence).toContain("lean rather than a conviction");
  });

  it("adds no caveat when the evidence is strong", () => {
    const v = equityVerdict({ bias: bias({ confidence: 80 }), plan, refusal: null });
    expect(v.sentence).not.toContain("size it small");
    expect(v.sentence).not.toContain("lean rather than");
  });

  it("refuses to imply tradeability when a plan is absent with no stated reason", () => {
    const v = equityVerdict({ bias: bias(), plan: null, refusal: null });
    expect(v.word).toBe("WAIT");
    expect(v.sentence).toContain("nothing to act on");
  });

  it("keeps every sentence free of engine-internal vocabulary", () => {
    const banned = ["composite", "basis", "State", "Edge voter", "renormalis", "Wilson", "percentile"];
    const cases: Array<Parameters<typeof equityVerdict>[0]> = [
      { bias: bias(), plan, refusal: null },
      { bias: bias({ verdict: "neutral", score: 50 }), plan: null, refusal: null },
      { bias: bias(), plan: null, refusal: "negative-expectancy" },
    ];
    for (const c of cases) {
      const { sentence } = equityVerdict(c);
      for (const term of banned) expect(sentence, term).not.toContain(term);
    }
  });
});
