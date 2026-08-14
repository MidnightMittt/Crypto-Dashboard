import { describe, expect, it } from "vitest";
import {
  composeInvalidation,
  composeMacroSummary,
  composeBearCase,
  composeBullCase,
  composeTldr,
} from "./narrative";
import { MarketBias, MetricVerdict, Verdict } from "@/lib/signals/types";
import { TradePlan } from "@/lib/signals/tradePlan";

const metric = (id: string, verdict: Verdict, over: Partial<MetricVerdict> = {}): MetricVerdict => ({
  id,
  label: id,
  verdict,
  confidence: 70,
  confidenceBasis: "",
  explanation: `${id} explanation`,
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger: null,
  ...over,
});

const bias = (over: Partial<MarketBias> = {}): MarketBias =>
  ({
    asset: "AAPL",
    basis: "state",
    score: 70,
    verdict: "bullish",
    confidence: 70,
    agreement: 80,
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

const plan = { entryLow: 218, entryHigh: 221, stopPrice: 214 } as TradePlan;

describe("composeTldr", () => {
  it("leads with the structural read a reader can check on a chart", () => {
    const t = composeTldr({
      bias: bias({
        metrics: [metric("marketStructure", "bullish", { explanation: "AAPL is making higher highs and higher lows." })],
      }),
      plan,
      symbol: "AAPL",
      name: "Apple Inc.",
    });
    expect(t.state).toBe("AAPL is making higher highs and higher lows.");
  });

  it("joins four clauses into one ten-second read", () => {
    const t = composeTldr({
      bias: bias({
        metrics: [metric("marketStructure", "bullish", { explanation: "Higher highs and higher lows." })],
        topBullish: [metric("equityBreadth", "bullish", { label: "Market Breadth" })],
        topBearish: [metric("momentum", "bearish", { label: "Momentum" })],
      }),
      plan,
      symbol: "AAPL",
      name: "Apple Inc.",
    });
    expect(t.full).toContain("Higher highs and higher lows.");
    expect(t.full).toContain("Market breadth back it up.");
    expect(t.full).toContain("buying pullbacks into $218.00–$221.00");
    expect(t.full).toContain("stays valid above $214.00");
  });

  it("OMITS the support clause when nothing supports it — never asserts from absence", () => {
    const t = composeTldr({
      bias: bias({ metrics: [metric("marketStructure", "bullish")], topBullish: [], topBearish: [] }),
      plan: null,
      symbol: "AAPL",
      name: "AAPL",
    });
    expect(t.support).toBeNull();
    expect(t.full).not.toContain("back it up");
  });

  it("omits the invalidation clause when there is no plan to invalidate", () => {
    const t = composeTldr({ bias: bias(), plan: null, symbol: "AAPL", name: "AAPL" });
    expect(t.invalidation).toBeNull();
    expect(t.full).not.toContain("stays valid");
  });

  it("mirrors direction for a bearish read", () => {
    const t = composeTldr({
      bias: bias({
        verdict: "bearish",
        score: 30,
        metrics: [metric("marketStructure", "bearish", { explanation: "Lower highs." })],
        topBearish: [metric("equityRelativeStrength", "bearish", { label: "Relative Strength" })],
        topBullish: [metric("equityBreadth", "bullish", { label: "Market Breadth" })],
      }),
      plan,
      symbol: "AAPL",
      name: "AAPL",
    });
    expect(t.support).toContain("pushing the same way");
    expect(t.tension).toContain("selling rallies into");
    expect(t.invalidation).toContain("below");
  });

  it("falls back to a plain composite sentence when no module is directional", () => {
    const t = composeTldr({
      bias: bias({ verdict: "neutral", metrics: [metric("marketStructure", "neutral")] }),
      plan: null,
      symbol: "AAPL",
      name: "Apple Inc.",
    });
    expect(t.state).toContain("Apple Inc.");
    expect(t.state).toContain("sideways");
  });

  it("ties the counter-evidence to the entry, which is what makes it a decision", () => {
    const t = composeTldr({
      bias: bias({
        metrics: [metric("marketStructure", "bullish")],
        topBearish: [metric("momentum", "bearish", { label: "Momentum" })],
      }),
      plan,
      symbol: "AAPL",
      name: "AAPL",
    });
    // Both halves in one clause: why to wait, and where.
    expect(t.tension).toContain("Momentum argues the other way");
    expect(t.tension).toContain("$218.00–$221.00");
  });
});

describe("composeBullCase / composeBearCase", () => {
  it("takes the engine's own ranking rather than re-sorting", () => {
    const b = bias({
      topBullish: [metric("a", "bullish", { label: "A" }), metric("b", "bullish", { label: "B" })],
      topBearish: [metric("c", "bearish", { label: "C" })],
    });
    expect(composeBullCase(b).map((r) => r.label)).toEqual(["A", "B"]);
    expect(composeBearCase(b).map((r) => r.label)).toEqual(["C"]);
  });

  /*
   * THE POINT OF THE RENAME. These used to swap by side, so that the
   * "supporting" column always matched the call — which meant a reading sat
   * under opposite headings on two different tickers and the labels carried
   * no fixed meaning. Bull is bull regardless of what the engine concluded.
   */
  it("does NOT swap sides for a bearish verdict", () => {
    const b = bias({
      verdict: "bearish",
      topBullish: [metric("a", "bullish", { label: "A" })],
      topBearish: [metric("c", "bearish", { label: "C" })],
    });
    expect(composeBullCase(b).map((r) => r.label)).toEqual(["A"]);
    expect(composeBearCase(b).map((r) => r.label)).toEqual(["C"]);
  });

  it("keeps every bullet traceable to the module it came from", () => {
    const b = bias({ topBullish: [metric("equityBreadth", "bullish", { label: "Market Breadth" })] });
    const [bullet] = composeBullCase(b);
    expect(bullet.metricId).toBe("equityBreadth");
    expect(bullet.detail).toBe("equityBreadth explanation");
  });
});

describe("composeInvalidation", () => {
  it("names the price level, the evidence flips and the event separately", () => {
    const triggers = composeInvalidation({
      bias: bias({
        watchNext: [metric("equityBreadth", "bullish", { label: "Market Breadth", nextTrigger: "turns neutral below 65%" })],
      }),
      plan,
      earningsDate: "2026-08-18",
    });
    expect(triggers.map((t) => t.kind)).toEqual(["price", "evidence", "event"]);
    expect(triggers[0].condition).toContain("$214.00");
    expect(triggers[1].condition).toContain("turns neutral below 65%");
    expect(triggers[2].condition).toContain("2026-08-18");
  });

  it("skips modules that cannot name what would flip them", () => {
    const triggers = composeInvalidation({
      bias: bias({ watchNext: [metric("x", "bullish", { nextTrigger: null })] }),
      plan: null,
      earningsDate: null,
    });
    expect(triggers).toHaveLength(0);
  });

  it("returns nothing rather than a vague reassurance when there is nothing to state", () => {
    expect(composeInvalidation({ bias: bias(), plan: null, earningsDate: null })).toEqual([]);
  });
});

describe("composeMacroSummary", () => {
  it("calls out the valuable divergence: strength inside a risk-off tape", () => {
    const s = composeMacroSummary({
      regime: "risk-off",
      sectorName: "Technology",
      sectorState: "leading",
      industryName: "Semiconductors",
      industryState: "leading",
    });
    expect(s).toContain("risk-off");
    expect(s).toContain("Semiconductors is leading");
    expect(s).toContain("where relative strength is worth the most");
  });

  it("calls out the opposite divergence: weakness inside a rising market", () => {
    const s = composeMacroSummary({
      regime: "risk-on",
      sectorName: "Utilities",
      sectorState: "lagging",
      industryName: "Power & Utilities",
      industryState: "lagging",
    });
    expect(s).toContain("harder tape to own");
  });

  it("stays quiet when the levels agree — the common case earns no commentary", () => {
    const s = composeMacroSummary({
      regime: "risk-on",
      sectorName: "Technology",
      sectorState: "leading",
      industryName: "Software",
      industryState: "leading",
    });
    expect(s).not.toContain("—");
    expect(s.endsWith(".")).toBe(true);
  });

  it("falls back to the sector when no industry is known, and omits both when neither is", () => {
    expect(
      composeMacroSummary({ regime: "mixed", sectorName: "Energy", sectorState: "improving", industryName: null, industryState: null })
    ).toContain("Energy is improving");
    expect(
      composeMacroSummary({ regime: "mixed", sectorName: null, sectorState: null, industryName: null, industryState: null })
    ).toBe("The wider tape is mixed.");
  });
});

describe("contradiction between the chart and the verdict", () => {
  /*
   * The defect this guards, caught by looking at a rendered NVDA page: the
   * verdict read BULLISH while the summary opened "an intact downtrend".
   * Both were true — the chart was weak, the backdrop strong — but printed
   * in sequence they read as the page contradicting itself in its own
   * summary, which costs more trust than being wrong would.
   */
  const conflicted = bias({
    verdict: "bullish",
    metrics: [metric("marketStructure", "bearish", { explanation: "NVDA is printing lower highs and lower lows." })],
    topBullish: [
      metric("equityBreadth", "bullish", { label: "Market Breadth" }),
      metric("equityRiskAppetite", "bullish", { label: "Risk Appetite" }),
    ],
    topBearish: [metric("equityRelativeStrength", "bearish", { label: "Relative Strength" })],
  });

  it("NAMES the disagreement instead of printing both facts in sequence", () => {
    const t = composeTldr({ bias: conflicted, plan, symbol: "NVDA", name: "NVDA" });
    expect(t.state).toContain("lower highs and lower lows");
    expect(t.support).toContain("comes from the backdrop rather than from the chart itself");
  });

  it("attributes the supports correctly — they hold the verdict UP, they do not oppose it", () => {
    /*
     * The first version of this clause said "market breadth and risk appetite
     * point the other way", which inverted the roles: those two ARE the
     * bullish case, and the chart is what opposes it. Fluent, confident and
     * backwards — the failure mode a language model would produce, arrived at
     * by hand.
     */
    const t = composeTldr({ bias: conflicted, plan, symbol: "NVDA", name: "NVDA" });
    expect(t.support).toContain("market breadth and risk appetite are what hold it up");
    expect(t.support).not.toContain("point the other way");
  });

  it("does not state the same opposition twice in one summary", () => {
    const t = composeTldr({ bias: conflicted, plan, symbol: "NVDA", name: "NVDA" });
    // The support clause already carries the conflict, so the tension clause
    // — which exists to introduce it — is dropped rather than repeating it.
    expect(t.tension).toBeNull();
    expect(t.full).not.toContain("argues the other way");
  });

  it("still keeps the ordinary phrasing when chart and verdict agree", () => {
    const agreeing = bias({
      verdict: "bullish",
      metrics: [metric("marketStructure", "bullish", { explanation: "Higher highs." })],
      topBullish: [metric("equityBreadth", "bullish", { label: "Market Breadth" })],
      topBearish: [metric("momentum", "bearish", { label: "Momentum" })],
    });
    const t = composeTldr({ bias: agreeing, plan, symbol: "NVDA", name: "NVDA" });
    expect(t.support).toContain("back it up");
    expect(t.support).not.toContain("backdrop");
    expect(t.tension).not.toBeNull();
  });

  it("says so plainly when the chart disagrees and nothing supports the verdict", () => {
    const bare = bias({
      verdict: "bullish",
      metrics: [metric("marketStructure", "bearish", { explanation: "Lower highs." })],
      topBullish: [],
    });
    const t = composeTldr({ bias: bare, plan: null, symbol: "NVDA", name: "NVDA" });
    expect(t.support).toContain("nothing else is currently backing that up");
  });
});
