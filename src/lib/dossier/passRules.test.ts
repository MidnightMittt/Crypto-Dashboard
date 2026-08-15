import { describe, expect, it } from "vitest";
import { buildPassRules, PassRuleInputs } from "./passRules";
import { TradePlan } from "@/lib/signals/tradePlan";

const plan = (over: Partial<TradePlan> = {}): TradePlan =>
  ({
    entryLow: 218,
    entryHigh: 221,
    entryRef: 220,
    stopPrice: 214,
    target1Price: 240,
    missedDistance: 3,
    ...over,
  }) as TradePlan;

const inputs = (over: Partial<PassRuleInputs> = {}): PassRuleInputs => ({
  plan: plan(),
  refusal: null,
  earnings: null,
  direction: "bullish",
  expectedMovePct: null,
  firstTargetPct: null,
  ...over,
});

describe("buildPassRules", () => {
  /*
   * The gate's own reason, quoted in full. It is the only ACTIVE rule that
   * explains why the page is not showing a trade at all, so it has to carry
   * the engine's written argument rather than a summary of it.
   */
  it("quotes the refusal that actually fired, in full", () => {
    const rules = buildPassRules(inputs({ plan: null, refusal: "target-beyond-winners-reach" }));
    const fired = rules.find((r) => r.active)!;
    expect(fired.rule).toContain("Pass on this setup");
    expect(fired.because).toContain("75% of winning trades");
  });

  /*
   * The chase level comes from the plan's own MISSED distance, not a round
   * number: past it the same stop is further away, so the trade no longer
   * pays what the page says it pays.
   */
  it("derives the chase level from the plan's own missed distance", () => {
    const rules = buildPassRules(inputs({ plan: plan({ entryHigh: 221, missedDistance: 3 }) }));
    const chase = rules.find((r) => r.rule.includes("chase"))!;
    expect(chase.rule).toContain("224.00");
    expect(chase.active).toBe(false);
  });

  it("mirrors the chase direction for a short", () => {
    const rules = buildPassRules(
      inputs({ direction: "bearish", plan: plan({ entryLow: 218, missedDistance: 3 }) })
    );
    const chase = rules.find((r) => r.rule.includes("chase"))!;
    expect(chase.rule).toContain("below");
    expect(chase.rule).toContain("215.00");
  });

  it("names the earnings date as an active reason to stand aside", () => {
    const rules = buildPassRules(inputs({ earnings: { date: "2026-08-20", sessions: 1 } }));
    const e = rules.find((r) => r.rule.includes("earnings"))!;
    expect(e.active).toBe(true);
    expect(e.rule).toContain("2026-08-20");
    expect(e.because).toContain("1 session");
  });

  /*
   * A target inside the priced move is NOT a reason to pass. Printing the
   * rule anyway would make the section noise that readers learn to skip.
   */
  it("stays silent when the target sits inside the priced move", () => {
    const rules = buildPassRules(inputs({ expectedMovePct: 8, firstTargetPct: 3 }));
    expect(rules.some((r) => r.rule.includes("volatility to expand"))).toBe(false);
  });

  it("fires when the target exceeds what the options market prices", () => {
    const rules = buildPassRules(inputs({ expectedMovePct: 4.8, firstTargetPct: 11 }));
    const r = rules.find((x) => x.rule.includes("volatility to expand"))!;
    expect(r.active).toBe(true);
    expect(r.because).toContain("±4.8%");
    expect(r.because).toContain("+11.0%");
  });

  it("offers no plan-shaped rules when there is no plan", () => {
    const rules = buildPassRules(inputs({ plan: null }));
    expect(rules.some((r) => r.rule.includes("chase"))).toBe(false);
    expect(rules.some((r) => r.rule.includes("stop at"))).toBe(false);
  });

  /*
   * FOUND IN REVIEW, on AAPL. A neutral read produces no plan and therefore
   * no refusal to quote, so the list came back empty and the entire section
   * disappeared from the page — indistinguishable from a card that broke.
   * No direction IS a reason to pass, and saying so is both the honest
   * content and what keeps the section on the page.
   */
  it("treats 'no direction' as its own reason to stand aside", () => {
    const rules = buildPassRules(inputs({ plan: null, refusal: null, direction: "neutral" }));
    expect(rules).not.toHaveLength(0);
    const r = rules.find((x) => x.rule.includes("picks a side"))!;
    expect(r.active).toBe(true);
    expect(r.because).toContain("cancel out");
  });

  /*
   * No generic trading advice. Every rule traces to a measured value, so a
   * directional read with nothing else measured produces nothing here rather
   * than filler — the panel renders its own honest empty state.
   */
  it("produces nothing rather than platitudes when nothing measured applies", () => {
    expect(
      buildPassRules({
        plan: null,
        refusal: null,
        earnings: null,
        direction: "bullish",
        expectedMovePct: null,
        firstTargetPct: null,
      })
    ).toEqual([]);
  });
});
