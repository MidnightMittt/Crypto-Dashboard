import { Bar } from "@/lib/research/types";
import { replayWindows } from "@/lib/research/exitDesign";
import { DEFAULT_WIDTHS_PCT, narrowestViable, stopGrid } from "@/lib/research/stopViability";
import {
  Distinguishability,
  RuleComparison,
  assessDistinguishability,
  judgeRule,
} from "./detectability";

/**
 * THE RULES THAT GOVERN EVERY ORDER, PUT ON TRIAL.
 *
 * The research register is trustworthy because it stands at one live method
 * against eleven rejections. The rules deciding actual position sizes have
 * never had that treatment — they were chosen once and inherited since.
 *
 * This ledger tries to measure them, and its most common output is a refusal.
 * That is the design working, not failing: `detectability` establishes what
 * this history could resolve BEFORE any comparison is reported, and on the
 * samples available most rule settings cannot be told apart from each other.
 *
 * Two refusals matter more than any verdict here:
 *
 *   1. A rule that cannot be measured says so, with the missing input named.
 *      Three of the four rules below are in that state. Listing only the
 *      measurable one would imply the plan is better audited than it is.
 *   2. Symbols are never POOLED. Two names' entry windows overlap the same
 *      market, so stacking their windows inflates the sample without adding
 *      independent evidence — the exact error this module exists to prevent.
 *      Each symbol is judged alone and the verdicts are counted.
 */

/** Sample standard deviation of the paired per-window differences. */
function sdOf(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const ss = xs.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

export interface FloorMeasurement {
  symbol: string;
  holdSessions: number;
  comparisons: RuleComparison[];
  action: "keep" | "retire" | "untestable";
  sentence: string;
  /** Stop width the current floor selects, and what each alternative selects. */
  selectedWidthPct: number | null;
  reason?: string;
}

/**
 * Measure the survival floor against alternative values on one symbol.
 *
 * The floor is not applied to returns directly — it SELECTS a stop width (the
 * narrowest clearing the floor), and the width is what changes outcomes. So
 * the comparison replays the width each candidate floor would have chosen,
 * over the same entry windows, and pairs the results window by window.
 *
 * A candidate that selects the same width as the current floor is reported as
 * changing nothing, rather than as a zero-difference measurement. Those are
 * different claims: one says the setting is inert here, the other implies two
 * genuinely different stops performed identically.
 */
export function measureFloorRule(
  symbol: string,
  bars: readonly Bar[],
  holdSessions: number,
  currentFloorPct: number,
  candidateFloorsPct: readonly number[]
): FloorMeasurement {
  const empty = (reason: string): FloorMeasurement => ({
    symbol,
    holdSessions,
    comparisons: [],
    action: "untestable",
    sentence: reason,
    selectedWidthPct: null,
    reason,
  });

  /*
   * The grid is built AT the horizon asked for, never at the default set.
   * `narrowestViable` filters cells by exact horizon, so a grid that does not
   * contain this hold returns null — indistinguishable from "no width
   * survives", which is the opposite conclusion. Passing the horizon in makes
   * the mismatch impossible rather than merely unlikely.
   */
  const grid = stopGrid(symbol, bars, DEFAULT_WIDTHS_PCT, [holdSessions]);
  if (!grid) return empty(`Too little history in ${symbol} for a stop grid.`);

  const currentCell = narrowestViable(grid, holdSessions, currentFloorPct);
  if (!currentCell) {
    return empty(
      `No stop width survives ${currentFloorPct}% of ${holdSessions}-session holds in ${symbol}, ` +
        `so the current floor does not select a stop here and there is nothing to compare against. ` +
        `That is a reason not to trade this name at this horizon, not a defect in the rule.`
    );
  }

  const currentOutcomes = replayWindows(bars, holdSessions, [], currentCell.widthPct);
  if (!currentOutcomes) return empty(`Too few forward windows in ${symbol} to replay a stop.`);

  const others = candidateFloorsPct.filter((f) => f !== currentFloorPct);
  const comparisons: RuleComparison[] = [];

  for (const floor of others) {
    const cell = narrowestViable(grid, holdSessions, floor);
    // A floor selecting no width, or the same width, is inert rather than measurable.
    if (!cell || cell.widthPct === currentCell.widthPct) continue;

    const altOutcomes = replayWindows(bars, holdSessions, [], cell.widthPct);
    if (!altOutcomes || altOutcomes.length !== currentOutcomes.length) continue;

    const diffs = altOutcomes.map((v, i) => v - currentOutcomes[i]);
    const sdDiff = sdOf(diffs);
    if (sdDiff === null) continue;

    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const currentMean = mean([...currentOutcomes]);
    const alternativeMean = mean([...altOutcomes]);

    const verdict: Distinguishability | null = assessDistinguishability({
      observedDiff: alternativeMean - currentMean,
      sdDiff,
      // Overlapping windows: the honest count, not the entry count.
      independentN: Math.floor(diffs.length / holdSessions),
      comparisons: others.length,
    });
    if (!verdict) continue;

    comparisons.push({
      rule: "survival_floor",
      current: currentFloorPct,
      alternative: floor,
      currentMean,
      alternativeMean,
      verdict,
    });
  }

  const judged = judgeRule(comparisons);
  return {
    symbol,
    holdSessions,
    selectedWidthPct: currentCell.widthPct,
    comparisons,
    action: judged.action,
    sentence:
      comparisons.length === 0
        ? `Every alternative floor selects the same ${currentCell.widthPct}% stop in ${symbol}, so ` +
          `the floor's exact value changes nothing here and cannot be measured on this name.`
        : judged.sentence,
  };
}

/** A rule the plan enforces, and whether this codebase can currently test it. */
export interface RegisteredRule {
  id: string;
  statement: string;
  current: number;
  candidates: readonly number[];
  measurable: boolean;
  /** When not measurable, the input that is missing — never a vague apology. */
  blockedBy?: string;
}

/**
 * The rules the pre-trade auditor enforces.
 *
 * Three of four are unmeasurable today and each names what it would take.
 * They are listed anyway: a ledger showing only its one measurable rule would
 * read as an audit of the plan, when it audits a quarter of it.
 */
export const RULE_REGISTER: readonly RegisteredRule[] = [
  {
    id: "survival_floor",
    statement:
      "A stop must survive at least 70% of holds at the intended horizon, or the trade is refused.",
    current: 70,
    candidates: [50, 60, 70, 80, 90],
    measurable: true,
  },
  {
    id: "deployment_cap",
    statement: "No more than 70% of account equity is deployed at once.",
    current: 0.7,
    candidates: [0.5, 0.6, 0.7, 0.8, 1.0],
    measurable: false,
    blockedBy:
      "Testing a deployment cap needs the sequence of positions the account actually held, " +
      "with entry and exit dates, so the alternative cap can be replayed against the same " +
      "opportunity set. The positioning store records daily snapshots, not the round trips, " +
      "so the counterfactual — which trade would have been skipped — cannot be reconstructed.",
  },
  {
    id: "max_beta_exposure",
    statement: "Total portfolio beta to the market stays under 1.5x.",
    current: 1.5,
    candidates: [1.0, 1.25, 1.5, 2.0, 3.0],
    measurable: false,
    blockedBy:
      "Same missing input as the deployment cap, plus a beta series per held name at the time " +
      "held rather than as measured today. Betas drift, and using a current beta to judge a " +
      "past exposure would test the rule against numbers it never saw.",
  },
  {
    id: "earnings_buffer",
    statement: "No new position within 3 sessions of an earnings date.",
    current: 3,
    candidates: [0, 1, 3, 5, 10],
    measurable: false,
    blockedBy:
      "This one is measurable in principle and worth doing: it needs historical earnings DATES " +
      "per symbol, which the Nasdaq source supplies only for the next event. Without a dated " +
      "history there is no way to mark which past windows sat inside the buffer.",
  },
];
