import { describe, expect, it } from "vitest";
import {
  composeInvalidation,
  composeTrustLine,
  composeMacroSummary,
  composeBearCase,
  composeBullCase,
  composeTldr,
} from "./narrative";
import { MarketBias, MetricVerdict, Verdict } from "@/lib/signals/types";
import { TradePlan } from "@/lib/signals/tradePlan";
import {
  PlannedEntry,
  PlannedEntryRead,
  Read,
  WatchLevel,
  available,
  unavailable,
  undeclaredEvidence,
} from "./types";

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

/** Only the fields composeInvalidation reads are meaningful here. */
const plannedEntry = { direction: "long", primary: true, triggerPrice: null } as unknown as PlannedEntry;

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

  /*
   * The options clause earns its place in a ten-second read only because it
   * is INDEPENDENTLY SOURCED — every other clause derives from the same
   * price history. A second source disagreeing is the case it mostly exists
   * for, and it must not be softened into agreement.
   */
  it("names an options disagreement rather than smoothing it", () => {
    const t = composeTldr({
      bias: bias({ verdict: "bullish", metrics: [metric("marketStructure", "bullish")] }),
      plan,
      symbol: "AAPL",
      name: "AAPL",
      optionsLean: "bearish",
    });
    expect(t.options).toContain("OTHER way");
    expect(t.options).toContain("size smaller");
    expect(t.full).toContain("size smaller");
  });

  it("reports agreement as the independent corroboration it is", () => {
    const t = composeTldr({
      bias: bias({ verdict: "bullish", metrics: [metric("marketStructure", "bullish")] }),
      plan,
      symbol: "AAPL",
      name: "AAPL",
      optionsLean: "bullish",
    });
    expect(t.options).toContain("independently sourced");
  });

  it("omits the options clause with no chain, no lean, or no call to compare", () => {
    const base = { plan, symbol: "AAPL", name: "AAPL" };
    // No chain at all.
    expect(composeTldr({ ...base, bias: bias({ metrics: [metric("marketStructure", "bullish")] }) }).options).toBeNull();
    // A lean, but the engine has no direction to compare it against.
    expect(
      composeTldr({ ...base, bias: bias({ verdict: "neutral" }), optionsLean: "bullish" }).options
    ).toBeNull();
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

/** A next-entry read shaped like the builder's own output. */
const nextEntry = (over: Partial<PlannedEntryRead> = {}): Read<PlannedEntryRead> =>
  available(
    {
      anchorPrice: 100,
      favoured: "long",
      rationale: "",
      entries: [],
      watchLevels: [],
      forward: null,
      ...over,
    },
    "basic",
    null,
    undeclaredEvidence()
  );

const watch = (direction: "long" | "short", price: number): WatchLevel => ({
  direction,
  price,
  distancePct: 5,
  distanceAtr: 1.2,
  touches: 3,
  reachRatePct: null,
  medianSessionsToReach: null,
  reachAttempts: null,
});

describe("composeInvalidation", () => {
  it("names the price level, the event and the evidence flips, in that order", () => {
    const triggers = composeInvalidation({
      bias: bias({
        watchNext: [metric("equityBreadth", "bullish", { label: "Market Breadth", nextTrigger: "turns neutral below 65%" })],
      }),
      plan,
      earningsDate: "2026-08-18",
    });
    /*
     * Earnings moved AHEAD of module flips: a report can gap price straight
     * through a stop, which makes it the one condition that can invalidate a
     * trade before any reading has time to change.
     */
    expect(triggers.map((t) => t.kind)).toEqual(["price", "event", "evidence"]);
    expect(triggers[0].condition).toContain("$214.00");
    expect(triggers[1].condition).toContain("2026-08-18");
    expect(triggers[2].condition).toContain("turns neutral below 65%");
  });

  /*
   * THE DEFECT THIS SECTION EXISTS TO FIX. Measured across five tickers on
   * 2026-08-16, a price appeared on the two carrying plans and on none of the
   * three reading WAIT — and WAIT is the majority state since the EV gate
   * landed. "Price Action Strength 15/100" is not something anyone can act on.
   */
  it("still names a price when there is no plan", () => {
    const triggers = composeInvalidation({
      bias: bias(),
      plan: null,
      earningsDate: null,
      nextEntry: nextEntry({ watchLevels: [watch("long", 88.5), watch("short", 112.25)] }),
    });
    expect(triggers.every((t) => t.kind === "price")).toBe(true);
    expect(triggers[0].condition).toBe("A daily close below $88.50");
    expect(triggers[1].condition).toBe("A daily close above $112.25");
  });

  it("leads with the level that would MAKE it a trade", () => {
    const triggers = composeInvalidation({
      bias: bias(),
      plan: null,
      earningsDate: null,
      nextEntry: nextEntry({
        entries: [
          { ...plannedEntry, primary: false, triggerPrice: 70 },
          { ...plannedEntry, primary: true, triggerPrice: 95.4 },
        ],
        watchLevels: [watch("long", 88.5)],
      }),
    });
    expect(triggers[0].condition).toBe("Price reaching $95.40");
    expect(triggers[0].consequence).toContain("standing aside stops being the answer");
    // The non-primary entry does not also get a line.
    expect(triggers.some((t) => t.condition.includes("$70"))).toBe(false);
  });

  /*
   * A conditional entry's trigger is frequently the same structure edge a
   * watch level names. Printed twice it reads as two independent conditions.
   */
  it("prints one level once, even when two sources name it", () => {
    const triggers = composeInvalidation({
      bias: bias(),
      plan: null,
      earningsDate: null,
      nextEntry: nextEntry({
        entries: [{ ...plannedEntry, primary: true, triggerPrice: 88.5 }],
        watchLevels: [watch("long", 88.5), watch("short", 112.25)],
      }),
    });
    expect(triggers.filter((t) => t.condition.includes("88.50"))).toHaveLength(1);
    expect(triggers).toHaveLength(2);
  });

  /* With a plan the stop IS the invalidation; watch levels would be noise. */
  it("does not add watch levels on top of a plan's stop", () => {
    const triggers = composeInvalidation({
      bias: bias(),
      plan,
      earningsDate: null,
      nextEntry: nextEntry({ watchLevels: [watch("long", 88.5), watch("short", 112.25)] }),
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].condition).toContain("$214.00");
  });

  /*
   * Concrete triggers claim the slots first. A list longer than this stops
   * being read, and module flips are the least actionable thing in it.
   */
  it("caps the list, and never lets module flips crowd out prices", () => {
    const flips = ["a", "b", "c", "d", "e"].map((id) =>
      metric(id, "bullish", { label: id, nextTrigger: "flips" })
    );
    const triggers = composeInvalidation({
      bias: bias({ watchNext: flips }),
      plan: null,
      earningsDate: "2026-08-18",
      nextEntry: nextEntry({
        entries: [{ ...plannedEntry, primary: true, triggerPrice: 95.4 }],
        watchLevels: [watch("long", 88.5), watch("short", 112.25)],
      }),
    });
    expect(triggers).toHaveLength(5);
    expect(triggers.filter((t) => t.kind === "price")).toHaveLength(3);
    expect(triggers.filter((t) => t.kind === "event")).toHaveLength(1);
    expect(triggers.filter((t) => t.kind === "evidence")).toHaveLength(1);
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

  /* An unavailable next-entry read degrades to the previous behaviour. */
  it("survives a next-entry section that has nothing to offer", () => {
    const triggers = composeInvalidation({
      bias: bias(),
      plan: null,
      earningsDate: null,
      nextEntry: unavailable("insufficient-history", "no structure yet"),
    });
    expect(triggers).toEqual([]);
  });
});

describe("composeTrustLine — folding must not hide the conclusion", () => {
  /*
   * THE RULE. A reader who never opens the fold must still learn that the
   * read has no track record. A summary that only announced "caveats apply"
   * would turn layering into hiding.
   */
  it("says there is no record, not merely that a caveat exists", () => {
    const line = composeTrustLine({
      gradeLabel: "descriptive",
      validatedWeightPct: 0,
      forward: { scored: null, open: 250, edgeVsBaselinePct: null },
    });
    expect(line).toContain("Describes conditions, forecasts nothing");
    expect(line).toContain("No scored track record yet");
    expect(line).toContain("250 calls are still inside their window");
  });

  it("reports the measured edge once calls have been scored", () => {
    const line = composeTrustLine({
      gradeLabel: "mixed",
      validatedWeightPct: 62.4,
      forward: { scored: 140, open: 20, edgeVsBaselinePct: 0.31 },
    });
    expect(line).toContain("62% of the weight");
    expect(line).toContain("140 past calls scored");
    expect(line).toContain("beating the baseline by 0.31%");
  });

  it("says trailing, not beating, when the edge is negative", () => {
    const line = composeTrustLine({
      gradeLabel: "validated",
      validatedWeightPct: 100,
      forward: { scored: 90, open: 0, edgeVsBaselinePct: -0.44 },
    });
    expect(line).toContain("trailing the baseline by 0.44%");
  });

  it("does not imply a baseline comparison that was never made", () => {
    const line = composeTrustLine({
      gradeLabel: "mixed",
      validatedWeightPct: 50,
      forward: { scored: 10, open: 0, edgeVsBaselinePct: null },
    });
    expect(line).toContain("against no measured baseline");
  });

  it("handles a verdict with no forward record at all", () => {
    expect(
      composeTrustLine({ gradeLabel: "descriptive", validatedWeightPct: 0, forward: null })
    ).toContain("No track record is kept");
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
