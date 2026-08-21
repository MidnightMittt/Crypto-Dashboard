/**
 * WHAT THIS DATA COULD DETECT, ANSWERED BEFORE WHAT IT SAYS.
 *
 * A trading plan carrying 48 numbered rules, none ever retired, is folklore
 * accumulating. Measuring each rule's chosen value against its alternatives
 * is the right instinct — the research register is trustworthy precisely
 * because it stands at one live method against eleven rejections, and the
 * rules governing every order have never had that treatment.
 *
 * But the sketch that prompted this would have printed
 * `best_by_expectancy: 0.60` on `independent_n: 14`. Fourteen observations,
 * five candidate values per rule, across 48 rules is several thousand
 * implicit comparisons on a sample that cannot support one. A ledger built
 * that way would retire load-bearing rules with confidence, carrying the
 * site's authority while being statistically empty — worse than the folklore
 * it replaces, because folklore does not claim to be measured.
 *
 * So this module answers the prior question. Given the spread of outcomes and
 * the number of INDEPENDENT windows, what is the smallest difference that
 * could be told apart from noise? Most rules will come back "cannot
 * distinguish 0.60 from 0.70 here", which is a true and actionable answer:
 * it says the rule is untestable at current history, not that it is wrong.
 *
 * A verdict is emitted only where the observed difference clears that bar.
 */

/** Two-sided significance. The conventional 5%, stated rather than assumed. */
export const ALPHA = 0.05;

/** Power: the chance of seeing a real effect of exactly the detectable size. */
export const POWER = 0.8;

/**
 * z(1 - alpha/2) + z(power), the constant in the detectable-effect formula.
 *
 * 1.959964 + 0.841621. Hard-coded rather than computed from an inverse-normal
 * routine because both values are fixed by the constants above, and a
 * hand-checkable literal is better here than a general function nobody will
 * verify.
 */
export const Z_SUM = 2.801585;

export type Distinguishability =
  | {
      distinguishable: true;
      observedDiff: number;
      minDetectable: number;
      independentN: number;
      sentence: string;
    }
  | {
      distinguishable: false;
      observedDiff: number;
      minDetectable: number;
      independentN: number;
      /** Independent windows needed to detect the difference actually observed. */
      requiredN: number | null;
      sentence: string;
    };

/**
 * The smallest difference this sample could tell apart from noise.
 *
 * Paired form — `sdDiff` is the standard deviation of the PER-WINDOW
 * differences between the two rule settings, not of either setting's returns.
 * The comparison is paired because both settings are evaluated on the same
 * entry windows, and using the unpaired form would understate the power
 * available by ignoring that the two share their market path.
 *
 * Null when the inputs cannot support the calculation at all.
 */
export function minDetectableEffect(sdDiff: number, independentN: number): number | null {
  if (!Number.isFinite(sdDiff) || sdDiff < 0) return null;
  if (!Number.isInteger(independentN) || independentN < 2) return null;
  return (Z_SUM * sdDiff) / Math.sqrt(independentN);
}

/**
 * Independent windows needed to detect an effect of `effect`.
 *
 * The actionable half. "Cannot distinguish these" is useful; "cannot
 * distinguish these, and would need 4,906 windows rather than 14" tells you
 * the rule is not merely untested but untestable on any history this account
 * will accumulate — which is itself a finding about the rule.
 */
export function requiredIndependentN(sdDiff: number, effect: number): number | null {
  if (!Number.isFinite(sdDiff) || sdDiff <= 0) return null;
  if (!Number.isFinite(effect) || effect === 0) return null;
  return Math.ceil(((Z_SUM * sdDiff) / Math.abs(effect)) ** 2);
}

/**
 * Whether an observed difference is larger than this sample could produce by
 * chance — and, when it is not, what it would take.
 *
 * `comparisons` is how many candidate values were tried for this rule. With
 * five settings the chance of one clearing a 5% bar by luck alone is roughly
 * one in four, so the bar is raised by a Bonferroni factor. Conservative on
 * purpose: this ledger exists to stop rules being retired on noise, and the
 * error worth avoiding is the confident-but-wrong one.
 */
export function assessDistinguishability(input: {
  observedDiff: number;
  sdDiff: number;
  independentN: number;
  comparisons?: number;
}): Distinguishability | null {
  const { observedDiff, sdDiff, independentN } = input;
  const comparisons = Math.max(1, Math.floor(input.comparisons ?? 1));

  const base = minDetectableEffect(sdDiff, independentN);
  if (base === null || !Number.isFinite(observedDiff)) return null;

  // Bonferroni on the significance half only: the alpha leg of Z_SUM scales
  // with the number of settings tried, the power leg does not.
  const inflation = comparisons > 1 ? Math.sqrt(Math.log(comparisons) / Math.log(2)) : 1;
  const minDetectable = base * inflation;

  const n = independentN;
  if (Math.abs(observedDiff) >= minDetectable) {
    return {
      distinguishable: true,
      observedDiff,
      minDetectable,
      independentN: n,
      sentence:
        `The ${fmt(observedDiff)} difference exceeds the ${fmt(minDetectable)} this sample could ` +
        `produce by chance across ${comparisons} setting${comparisons === 1 ? "" : "s"} on ${n} ` +
        `independent windows. The difference is real at this sample size; whether it is large ` +
        `enough to change how you trade is a separate question.`,
    };
  }

  const requiredN = requiredIndependentN(sdDiff * inflation, observedDiff);
  return {
    distinguishable: false,
    observedDiff,
    minDetectable,
    independentN: n,
    requiredN,
    sentence:
      `The ${fmt(observedDiff)} difference is inside the ${fmt(minDetectable)} this sample could ` +
      `produce by chance on ${n} independent windows, so the settings CANNOT BE TOLD APART here. ` +
      (requiredN === null
        ? "No sample size would settle a zero difference."
        : `Detecting a difference this size would need about ${requiredN.toLocaleString()} ` +
          `independent windows. ` +
          (requiredN > n * 20
            ? "That is far beyond any history this account will accumulate, so the rule is not " +
              "merely untested — it is untestable at this effect size, which is itself the finding."
            : "Keep the current value and revisit once the record is deeper.")),
  };
}

function fmt(v: number): string {
  return `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(2)}pp`;
}

/** One rule's chosen value against one alternative, with the power question answered first. */
export interface RuleComparison {
  rule: string;
  current: number;
  alternative: number;
  /** Mean outcome under each, in percentage points. */
  currentMean: number;
  alternativeMean: number;
  verdict: Distinguishability;
}

/**
 * A rule's verdict across every alternative tried.
 *
 * `retire` is reserved for the case where SOME alternative is
 * distinguishably better. Anything else is `keep` — including the common
 * case where nothing can be told apart, because the absence of evidence
 * against a rule is not evidence for retiring it.
 */
export function judgeRule(comparisons: readonly RuleComparison[]): {
  action: "keep" | "retire" | "untestable";
  sentence: string;
} {
  if (comparisons.length === 0) {
    return { action: "untestable", sentence: "No alternatives were measured for this rule." };
  }

  const better = comparisons.filter(
    (c) => c.verdict.distinguishable && c.alternativeMean > c.currentMean
  );
  if (better.length > 0) {
    const best = better.reduce((a, b) => (b.alternativeMean > a.alternativeMean ? b : a));
    return {
      action: "retire",
      sentence:
        `Setting ${best.alternative} beat the current ${best.current} by ` +
        `${fmt(best.alternativeMean - best.currentMean)}, and the gap clears what this sample ` +
        `could produce by chance. This value should be revisited rather than inherited.`,
    };
  }

  const anyDistinguishable = comparisons.some((c) => c.verdict.distinguishable);
  if (!anyDistinguishable) {
    return {
      action: "untestable",
      sentence:
        `None of the ${comparisons.length} alternatives can be told apart from the current value ` +
        `on this history. That is not support for the rule — it means the rule is currently ` +
        `unfalsifiable here, and its value rests on judgement rather than on measurement.`,
    };
  }

  return {
    action: "keep",
    sentence:
      `Every distinguishable alternative was WORSE than the current value. The rule is doing ` +
      `measurable work rather than being carried.`,
  };
}
