import { describe, expect, it } from "vitest";
import {
  RuleComparison,
  Z_SUM,
  assessDistinguishability,
  judgeRule,
  minDetectableEffect,
  requiredIndependentN,
} from "./detectability";

describe("minDetectableEffect", () => {
  /*
   * HAND-COMPUTED. Z_SUM = 1.959964 + 0.841621 = 2.801585.
   * With sd of per-window differences = 10pp and n = 14:
   *   MDE = 2.801585 x 10 / sqrt(14) = 28.01585 / 3.741657 = 7.4876
   *
   * That is the whole argument in one number. On the sample the ledger sketch
   * proposed, nothing smaller than about SEVEN AND A HALF POINTS can be told
   * from noise — so a "+0.4pp mean" verdict was never measurable.
   */
  it("matches the hand computation at the sample the ledger would have used", () => {
    expect(Z_SUM).toBeCloseTo(2.801585, 6);
    expect(minDetectableEffect(10, 14)).toBeCloseTo(7.4876, 3);
  });

  /* Power scales with the square root: four times the data halves the bar. */
  it("halves the detectable effect for four times the windows", () => {
    const a = minDetectableEffect(10, 14)!;
    const b = minDetectableEffect(10, 56)!;
    expect(b).toBeCloseTo(a / 2, 6);
  });

  it("refuses inputs that cannot support the calculation", () => {
    expect(minDetectableEffect(10, 1)).toBeNull();
    expect(minDetectableEffect(-1, 30)).toBeNull();
    expect(minDetectableEffect(10, 14.5)).toBeNull();
  });
});

describe("requiredIndependentN", () => {
  /*
   * THE NUMBER THAT SETTLES THE ARGUMENT. To detect the 0.4pp difference the
   * sketch reported, with sd 10pp:
   *   n = (2.801585 x 10 / 0.4)^2 = 70.0396^2 = 4905.5 -> 4906
   *
   * Fourteen windows were available. Nearly five thousand were needed.
   */
  it("computes the windows needed for the difference the sketch reported", () => {
    expect(requiredIndependentN(10, 0.4)).toBe(4906);
  });

  it("needs far fewer windows for a large effect", () => {
    expect(requiredIndependentN(10, 10)).toBe(8);
  });

  it("has no answer for a zero difference", () => {
    expect(requiredIndependentN(10, 0)).toBeNull();
  });
});

describe("assessDistinguishability", () => {
  /* The live case: a small difference on a thin sample cannot be told apart. */
  it("refuses to distinguish a 0.4pp difference on 14 windows", () => {
    const r = assessDistinguishability({ observedDiff: 0.4, sdDiff: 10, independentN: 14 })!;
    expect(r.distinguishable).toBe(false);
    expect(r.sentence).toContain("CANNOT BE TOLD APART");
    if (!r.distinguishable) {
      expect(r.requiredN).toBe(4906);
      // 4906 is far beyond 14 x 20, so it must say the rule is untestable.
      expect(r.sentence).toContain("untestable at this effect size");
    }
  });

  it("distinguishes an effect that clears the bar", () => {
    const r = assessDistinguishability({ observedDiff: 12, sdDiff: 10, independentN: 14 })!;
    expect(r.distinguishable).toBe(true);
    expect(r.sentence).toContain("exceeds the");
    // Real does not mean large enough to act on, and it says so.
    expect(r.sentence).toContain("whether it is large enough to change how you trade");
  });

  /*
   * FIVE SETTINGS PER RULE MEANS FIVE CHANCES TO GET LUCKY. The bar rises
   * with the number tried, because this ledger exists to stop rules being
   * retired on noise.
   */
  it("raises the bar when several settings were tried", () => {
    const one = assessDistinguishability({ observedDiff: 8, sdDiff: 10, independentN: 14, comparisons: 1 })!;
    const five = assessDistinguishability({ observedDiff: 8, sdDiff: 10, independentN: 14, comparisons: 5 })!;
    expect(five.minDetectable).toBeGreaterThan(one.minDetectable);
    // The same 8pp clears one comparison and fails five.
    expect(one.distinguishable).toBe(true);
    expect(five.distinguishable).toBe(false);
  });

  it("suggests waiting when the required sample is within reach", () => {
    const r = assessDistinguishability({ observedDiff: 5, sdDiff: 10, independentN: 14 })!;
    if (!r.distinguishable) {
      expect(r.requiredN).toBeLessThan(14 * 20);
      expect(r.sentence).toContain("revisit once the record is deeper");
    }
  });
});

describe("judgeRule", () => {
  const cmp = (over: Partial<RuleComparison> = {}): RuleComparison => ({
    rule: "stop_survival_floor",
    current: 0.7,
    alternative: 0.6,
    currentMean: 2,
    alternativeMean: 2.4,
    verdict: assessDistinguishability({ observedDiff: 0.4, sdDiff: 10, independentN: 14 })!,
    ...over,
  });

  /*
   * THE CENTRAL REFUSAL. When nothing can be told apart, the answer is
   * "untestable" — never "keep, the rule is fine". Absence of evidence
   * against a rule is not evidence for it, and saying so is what stops the
   * ledger becoming a rubber stamp.
   */
  it("calls a rule untestable when no alternative can be told apart", () => {
    const j = judgeRule([cmp(), cmp({ alternative: 0.5 }), cmp({ alternative: 0.8 })]);
    expect(j.action).toBe("untestable");
    expect(j.sentence).toContain("not support for the rule");
    expect(j.sentence).toContain("unfalsifiable");
  });

  it("retires a rule only when an alternative is distinguishably better", () => {
    const better = cmp({
      alternative: 0.5,
      alternativeMean: 14,
      verdict: assessDistinguishability({ observedDiff: 12, sdDiff: 10, independentN: 14 })!,
    });
    const j = judgeRule([cmp(), better]);
    expect(j.action).toBe("retire");
    expect(j.sentence).toContain("clears what this sample could produce by chance");
  });

  /* A distinguishably WORSE alternative is evidence the rule earns its place. */
  it("keeps a rule whose distinguishable alternatives are all worse", () => {
    const worse = cmp({
      alternative: 0.5,
      alternativeMean: -12,
      verdict: assessDistinguishability({ observedDiff: -14, sdDiff: 10, independentN: 14 })!,
    });
    const j = judgeRule([worse]);
    expect(j.action).toBe("keep");
    expect(j.sentence).toContain("doing measurable work");
  });

  it("has nothing to say about a rule with no alternatives measured", () => {
    expect(judgeRule([]).action).toBe("untestable");
  });
});
