import { TradePlan, TradePlanRefusal, TRADE_PLAN_REFUSAL_TEXT } from "@/lib/signals/tradePlan";
import { EarningsVetoResult } from "@/lib/markets/earningsVeto";

/**
 * WHAT WOULD MAKE ME PASS — the conditions under which not trading is the
 * decision.
 *
 * Deliberately distinct from the invalidation section, which answers "what
 * would end this thesis once I am in". These are conditions that apply
 * BEFORE entry: the reasons to leave a setup alone even though the engine
 * likes the direction. An experienced trader carries a list like this; the
 * engine has been enforcing one silently at the gate, and this simply says
 * it out loud.
 *
 * ── Composed, never invented ──────────────────────────────────────────
 *
 * Every rule below is derived from a value the engine measured. The largest
 * source is `TRADE_PLAN_REFUSAL_TEXT`, ten refusal reasons whose prose was
 * already written when the gate was built — a rule that fired is quoted, and
 * the rules that did NOT fire are reported as conditions to watch, since the
 * gate is checked on every rebuild and a setup that passes today can fail
 * tomorrow on the same test.
 *
 * There is deliberately no generic trading advice here. "Do not trade
 * against the trend" is true and useless; it is not derived from this
 * asset's readings and would be filler dressed as intelligence.
 */

export interface PassRule {
  /** True when this condition is ALREADY met — a reason to pass right now. */
  active: boolean;
  rule: string;
  /** Why, in the engine's own measured terms. */
  because: string;
}

export interface PassRuleInputs {
  plan: TradePlan | null;
  refusal: TradePlanRefusal | null;
  earnings: EarningsVetoResult | null;
  direction: "bullish" | "bearish" | "neutral";
  /** Expected move the options market prices over its horizon, in percent. */
  expectedMovePct: number | null;
  /** What the plan's first target needs, in percent. */
  firstTargetPct: number | null;
}

export function buildPassRules(inputs: PassRuleInputs): PassRule[] {
  const { plan, refusal, earnings, direction, expectedMovePct, firstTargetPct } = inputs;
  const rules: PassRule[] = [];

  /*
   * THE GATE THAT ACTUALLY FIRED, quoted in full. This is the highest-value
   * rule on the list because it is not hypothetical — it is the reason there
   * is no plan on the page right now.
   */
  if (refusal) {
    rules.push({
      active: true,
      rule: "Pass on this setup entirely, today.",
      because: TRADE_PLAN_REFUSAL_TEXT[refusal],
    });
  }

  /*
   * NO DIRECTION IS ITSELF A RULE, and this branch exists because leaving it
   * out made the whole section disappear on exactly the ticker that needed
   * it most. A neutral read produces no plan and therefore no refusal to
   * quote, so the list came back empty and the panel rendered nothing —
   * indistinguishable from a page that was broken.
   *
   * It is also the honest content. When the evidence for up and the evidence
   * for down cancel, passing is not a fallback; it is the recommendation.
   */
  if (!plan && !refusal && direction === "neutral") {
    rules.push({
      active: true,
      rule: "Pass until the evidence picks a side.",
      because:
        "The readings for up and the readings for down currently cancel out, so there is no direction to build a plan around. That is a finding rather than a failure — a coin-flip entry taken at full size is how a neutral tape costs money.",
    });
  }

  // ── Do not chase ──
  if (plan) {
    /*
     * The plan's own MISSED threshold, not a round number. Past this the
     * entry a reader is looking at no longer exists at the risk it was
     * measured with, so taking it at market is a different trade wearing
     * this one's risk/reward.
     */
    const chaseLevel =
      direction === "bearish" ? plan.entryLow - plan.missedDistance : plan.entryHigh + plan.missedDistance;
    rules.push({
      active: false,
      rule:
        direction === "bearish"
          ? `Do not chase below ${chaseLevel.toFixed(2)}.`
          : `Do not chase above ${chaseLevel.toFixed(2)}.`,
      because: `The plan's risk and reward were measured from an entry at ${plan.entryLow.toFixed(2)}–${plan.entryHigh.toFixed(2)}. Past this level the setup reads as missed: the same stop is now further away, so the trade no longer pays what the page says it pays.`,
    });

    rules.push({
      active: false,
      rule: `Do not take it if price closes past the stop at ${plan.stopPrice.toFixed(2)} before you are in.`,
      because: `The stop represents a structural level, not a distance. Once price has closed through it the level has already failed, and the setup that level defined no longer exists.`,
    });
  }

  // ── Events ──
  if (earnings) {
    rules.push({
      active: true,
      rule: `Do not open before earnings on ${earnings.date}.`,
      because: `${earnings.sessions} ${earnings.sessions === 1 ? "session" : "sessions"} away. A stop is a statement about structure, and an earnings gap jumps stops rather than trading through them — the printed risk was never the risk available across that date.`,
    });
  }

  /*
   * ── The options market's own ceiling ───────────────────────────────
   *
   * Only stated when the target genuinely exceeds what is priced. A target
   * comfortably inside the expected move is not a reason to pass, and
   * printing this rule anyway would train readers to skip the section.
   */
  if (expectedMovePct !== null && firstTargetPct !== null && firstTargetPct > expectedMovePct) {
    rules.push({
      active: true,
      rule: "Do not size this as a base case — the target needs volatility to expand.",
      because: `The options market prices a move of about ±${expectedMovePct.toFixed(1)}% over its whole horizon, while the first target needs +${firstTargetPct.toFixed(1)}%. Reaching it requires more movement than is currently priced, not merely the right direction.`,
    });
  }

  return rules;
}
