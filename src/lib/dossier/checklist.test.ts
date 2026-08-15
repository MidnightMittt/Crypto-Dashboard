import { describe, expect, it } from "vitest";
import { buildChecklist, ChecklistInputs } from "./checklist";
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
    basis: "edge",
    score: 70,
    verdict: "bullish",
    confidence: 75,
    agreement: 85,
    headline: "",
    topBullish: [],
    topBearish: [],
    opportunity: null,
    counterRisk: null,
    watchNext: [],
    changes: [],
    isFirstReading: false,
    riskLevel: "low",
    riskRationale: "",
    metrics: [],
    categories: [],
    trendStrength: null,
    updatedAt: 0,
    ...over,
  }) as MarketBias;

const plan = (over: Partial<TradePlan> = {}): TradePlan =>
  ({
    riskRewardRatio: 2.4,
    stars: 4,
    starRationale: "Stop sits beyond the drawdown winners endured.",
    ...over,
  }) as TradePlan;

const inputs = (over: Partial<ChecklistInputs> = {}): ChecklistInputs => ({
  bias: bias(),
  plan: plan(),
  refusal: null,
  earnings: null,
  // A known date by default, so the earnings row exercises its verified path
  // unless a case deliberately withholds it.
  nextEarningsDate: "2026-12-01",
  optionsAgrees: null,
  ...over,
});

describe("buildChecklist", () => {
  /*
   * THE HEADLINE IS NOT A NEW SCORE. It is the plan's own backtested star
   * rating, carried through with the sentence the engine wrote for it. A
   * composite computed in this module would sit beside bias.score with no
   * record of its own — the defect the dual-score consolidation removed.
   */
  it("carries the plan's existing rating rather than computing one", () => {
    const c = buildChecklist(inputs());
    expect(c.stars).toBe(4);
    expect(c.starRationale).toBe("Stop sits beyond the drawdown winners endured.");
  });

  /*
   * A one-star rating would claim a bad trade EXISTS. The gate's whole point
   * is that it does not, so the honest headline is the absence.
   */
  it("rates nothing when the gate refused a plan", () => {
    const c = buildChecklist(inputs({ plan: null, refusal: "negative-expectancy" }));
    expect(c.stars).toBeNull();
    // The headline already says "no setup to rate" in the largest type on the
    // card; the summary names the blockers instead of repeating it.
    expect(c.summary).not.toContain("No setup to rate");
    expect(c.summary).toContain("expectancy gate");
    const gate = c.rows.find((r) => r.label.includes("expectancy gate"))!;
    expect(gate.state).toBe("fail");
    expect(gate.detail.length).toBeGreaterThan(20);
  });

  it("ticks a reading that agrees with the call and crosses one that fights it", () => {
    const c = buildChecklist(
      inputs({
        bias: bias({
          verdict: "bullish",
          topBullish: [metric("breadth", "bullish", { label: "Market Breadth" })],
          topBearish: [metric("rs", "bearish", { label: "Relative Strength" })],
        }),
      })
    );
    expect(c.rows.find((r) => r.label === "Market Breadth")!.state).toBe("pass");
    expect(c.rows.find((r) => r.label === "Relative Strength")!.state).toBe("fail");
  });

  /*
   * THE ROW A CHECKLIST EXISTS FOR. Taking the top five from the agreeing
   * side alone fills every row with ticks and buries the single reading
   * arguing against the trade — turning a decision aid into a reassurance
   * device. The two sides are interleaved so the opposing case always
   * survives the cap.
   */
  it("never lets agreeing readings crowd out the one that disagrees", () => {
    const c = buildChecklist(
      inputs({
        bias: bias({
          verdict: "bullish",
          topBullish: Array.from({ length: 8 }, (_, i) => metric(`b${i}`, "bullish", { label: `Bull ${i}` })),
          topBearish: [metric("rs", "bearish", { label: "Relative Strength" })],
        }),
      })
    );
    expect(c.rows.some((r) => r.label === "Relative Strength" && r.state === "fail")).toBe(true);
  });

  /*
   * A neutral reading made no directional claim. Ticking it would credit it
   * with agreeing, crossing it would blame it for disagreeing, and both are
   * inventions. It still earns a row: a setup resting on modules that are
   * mostly abstaining is a different proposition from one they back.
   */
  it("treats a neutral reading as a caution, never a pass or a fail", () => {
    const c = buildChecklist(
      inputs({ bias: bias({ verdict: "bullish", metrics: [metric("vol", "neutral", { label: "Volatility" })] }) })
    );
    expect(c.rows.find((r) => r.label === "Volatility")!.state).toBe("caution");
  });

  it("ticks nothing when the engine made no directional call", () => {
    const c = buildChecklist(
      inputs({
        bias: bias({ verdict: "neutral", metrics: [metric("b", "bullish", { label: "Breadth" })] }),
      })
    );
    expect(c.rows.find((r) => r.label === "Breadth")!.state).toBe("caution");
  });

  it("stays scannable — caps the per-reading rows", () => {
    const many = Array.from({ length: 12 }, (_, i) => metric(`m${i}`, "bullish", { label: `M${i}` }));
    const c = buildChecklist(inputs({ bias: bias({ topBullish: many }) }));
    expect(c.rows.filter((r) => r.label.startsWith("M"))).toHaveLength(5);
  });

  it("fails the earnings row and names the date and distance", () => {
    const c = buildChecklist(inputs({ earnings: { date: "2026-08-20", sessions: 6 } }));
    const row = c.rows.find((r) => r.label.includes("earnings"))!;
    expect(row.state).toBe("fail");
    expect(row.detail).toContain("2026-08-20");
    expect(row.detail).toContain("6 sessions");
  });

  it("passes only when a date was actually retrieved, and cites it", () => {
    const c = buildChecklist(inputs({ earnings: null, nextEarningsDate: "2026-12-01" }));
    const row = c.rows.find((r) => r.label.includes("earnings"))!;
    expect(row.state).toBe("pass");
    expect(row.detail).toContain("2026-12-01");
  });

  /*
   * THE FAIL-OPEN GATE. This row used to render a green tick whenever the
   * calendar was silent, and a missing date looks exactly like a clear one.
   * The prose hedged honestly, but prose is not what gets scanned under time
   * pressure — the tick is, and it also fed the "N of 9 passed" headline, so
   * an unanswered question was counted as a satisfied safeguard. HUT, CIFR
   * and WULF are all live in this state.
   *
   * The veto deliberately still does not fire (a calendar outage must not
   * block every equity plan); what changed is that the checklist no longer
   * claims a check it never made.
   */
  it("does not count an unconfirmed earnings date as a passed check", () => {
    const c = buildChecklist(inputs({ earnings: null, nextEarningsDate: null }));
    const row = c.rows.find((r) => r.label.toLowerCase().includes("earnings"))!;
    expect(row.state).toBe("caution");
    expect(row.state).not.toBe("pass");
    expect(row.label).toContain("could not be confirmed");

    // And it must not inflate the headline count.
    const withDate = buildChecklist(inputs({ earnings: null, nextEarningsDate: "2026-12-01" }));
    expect(c.passed).toBe(withDate.passed - 1);
  });

  it("omits the earnings row where earnings are not a concept", () => {
    // Crypto: no issuer, no report. A question that does not apply is not a pass.
    const c = buildChecklist(inputs({ earnings: null, nextEarningsDate: undefined }));
    expect(c.rows.some((r) => r.label.toLowerCase().includes("earnings"))).toBe(false);
  });

  it("omits the options row entirely when the chain has no opinion", () => {
    expect(buildChecklist(inputs({ optionsAgrees: null })).rows.some((r) => r.label.includes("Options"))).toBe(false);
  });

  it("flags an options disagreement as a sizing decision, not a dismissal", () => {
    const c = buildChecklist(inputs({ optionsAgrees: false }));
    const row = c.rows.find((r) => r.label.includes("Options"))!;
    expect(row.state).toBe("fail");
    expect(row.detail).toContain("size smaller");
  });

  it("fails the agreement row when the modules contradict each other", () => {
    const c = buildChecklist(inputs({ bias: bias({ agreement: 20 }) }));
    const row = c.rows.find((r) => r.label.includes("agree with each other"))!;
    expect(row.state).toBe("fail");
    expect(row.detail).toContain("20%");
  });

  it("keeps agreement and evidence quality as separate rows", () => {
    // Unanimous but thin — the case where collapsing them would hide the risk.
    const c = buildChecklist(inputs({ bias: bias({ agreement: 100, confidence: 20 }) }));
    expect(c.rows.find((r) => r.label.includes("agree with each other"))!.state).toBe("pass");
    expect(c.rows.find((r) => r.label.includes("Evidence is strong"))!.state).toBe("fail");
  });

  it("counts passes against the real total and names the failures", () => {
    const c = buildChecklist(
      inputs({
        bias: bias({ verdict: "bullish", topBearish: [metric("rs", "bearish", { label: "Relative Strength" })] }),
        earnings: { date: "2026-08-20", sessions: 3 },
      })
    );
    expect(c.total).toBe(c.rows.length);
    expect(c.passed).toBe(c.rows.filter((r) => r.state === "pass").length);
    expect(c.summary).toContain("relative strength");
    expect(c.summary).toContain("checks fail");
  });

  it("says so plainly when nothing fails", () => {
    const c = buildChecklist(inputs({ bias: bias({ topBullish: [metric("b", "bullish", { label: "Breadth" })] }) }));
    expect(c.summary).toContain("none fail");
  });
});
