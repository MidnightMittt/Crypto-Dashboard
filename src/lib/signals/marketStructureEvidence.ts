import { Bar } from "@/lib/research/types";
import { MetricVerdict, Verdict } from "@/lib/signals/types";
import { findSwingPoints } from "@/lib/technicals/divergence";

/**
 * MARKET STRUCTURE — the shared, asset-agnostic evidence module.
 *
 * Lives here rather than in markets/equityEvidence.ts because nothing about
 * it is equity-specific: it reads swing highs and lows off a bar series, and
 * a bar series is a bar series. The reference implementation for the evidence
 * contract should not be filed under one asset class.
 *
 * See docs/EVIDENCE_MODULE_CONTRACT.md for the contract this demonstrates,
 * and docs/ADDING_AN_EVIDENCE_MODULE.md for the pattern to copy.
 *
 * NOT YET CONSUMED BY CRYPTO. The crypto path still derives structure inside
 * `buildTechnicalRead`, where it is one of ~13 votes feeding the single
 * `technicals` metric, using a DIFFERENT detector (`trendStructure`). Routing
 * crypto through this module is three coupled behaviour changes — swap the
 * detector, remove the vote, add the metric — and must be landed together
 * with a measured backtest delta, never piecemeal. Applying it partially
 * would double-count structure, which is worse than either end state.
 */

/** Anything with bars. Deliberately not named after an asset class. */
export interface StructureInput {
  symbol: string;
  bars: Bar[];
}

/** Sessions of price examined for the swing sequence. ~6 months of dailies. */
const STRUCTURE_WINDOW = 120;
/** Fractal half-width. 3 matches the divergence detector's default, so both read the same pivots. */
const PIVOT_LOOKBACK = 3;

/**
 * MARKET STRUCTURE — is price making higher highs and higher lows, or the
 * opposite?
 *
 * The oldest read in technical analysis and still the most decision-relevant
 * one, because it is the only module here that describes the SHAPE of the
 * advance rather than its size or speed. A market up 10% on higher lows is a
 * different proposition from one up 10% that keeps undercutting its prior
 * low, and no return-based measure separates them.
 *
 * Reuses `findSwingPoints` from divergence.ts rather than detecting pivots
 * again. Two pivot detectors in one codebase is how a "higher low" in one
 * module quietly stops being a "higher low" in another — the same class of
 * duplication the execution-model work already had to unwind once.
 *
 * Both legs must agree. Higher highs with LOWER lows is a broadening range,
 * not an uptrend, and calling it bullish because one leg rose would be
 * exactly the kind of half-read the engine is supposed to refuse. It reports
 * neutral and names the expansion in its conflicts.
 */
export function evaluateMarketStructure(
  instrument: StructureInput,
  asOf: number,
  /**
   * Optional structural levels. When supplied, the module reports distance to
   * the nearest support and resistance as `supporting` measurements — so a UI
   * never reaches into the zone array to compute "3.2% away" for itself.
   * Absent, the module still produces a complete verdict on the swing
   * sequence alone; a level provider being unavailable degrades the evidence,
   * it does not invalidate it.
   */
  levels?: { supportPct: number | null; resistancePct: number | null }
): MetricVerdict | null {
  const bars = instrument.bars.slice(-STRUCTURE_WINDOW);
  if (bars.length < STRUCTURE_WINDOW / 2) return null;

  const pivots = findSwingPoints(bars.map((b) => b.close), PIVOT_LOOKBACK);
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");

  // Two of each is the minimum that can express a SEQUENCE. One pivot is a
  // location, not a direction.
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs[highs.length - 1].value;
  const prevHigh = highs[highs.length - 2].value;
  const lastLow = lows[lows.length - 1].value;
  const prevLow = lows[lows.length - 2].value;

  const higherHighs = lastHigh > prevHigh;
  const higherLows = lastLow > prevLow;

  let verdict: Verdict;
  let shape: string;
  const conflicts: string[] = [];

  if (higherHighs && higherLows) {
    verdict = "bullish";
    shape = "higher highs and higher lows — an intact uptrend";
  } else if (!higherHighs && !higherLows) {
    verdict = "bearish";
    shape = "lower highs and lower lows — an intact downtrend";
  } else if (higherHighs && !higherLows) {
    verdict = "neutral";
    shape = "higher highs but lower lows — a broadening range, not a trend";
    conflicts.push("Highs are rising while lows are falling: volatility is expanding without direction.");
  } else {
    verdict = "neutral";
    shape = "lower highs and higher lows — compressing into a coil";
    conflicts.push("Range is narrowing; structure resolves on the break, and gives no direction until it does.");
  }

  /*
   * Confidence from how DECISIVE the sequence is, measured as the smaller of
   * the two legs' moves relative to the recent range. A higher high by 0.1%
   * is technically a higher high and tells a trader nothing; requiring both
   * legs to clear a meaningful fraction of the range is what separates
   * structure from noise. Capped at 75: two pivots is a real sequence but a
   * short one.
   */
  const rangeHigh = Math.max(...bars.map((b) => b.high));
  const rangeLow = Math.min(...bars.map((b) => b.low));
  const range = rangeHigh - rangeLow;
  const decisiveness =
    range > 0
      ? Math.min(Math.abs(lastHigh - prevHigh), Math.abs(lastLow - prevLow)) / range
      : 0;
  const confidence =
    verdict === "neutral" ? 0 : Math.min(75, Math.round(Math.min(1, decisiveness / 0.15) * 75));

  /*
   * REFERENCE IMPLEMENTATION — the pattern every future evidence module
   * follows. See docs/EVIDENCE_MODULE_CONTRACT.md.
   *
   * `evidenceFor` states each finding as a discrete claim, mirroring
   * `conflicts`. `supporting` carries the measurements. Between them the UI
   * can render structured evidence without parsing prose or touching raw
   * series — which is the rule the whole contract exists to enforce.
   *
   * Note what is NOT here: no score contribution and no risk contribution.
   * Those are derived by `contributionOf` in categories.ts, because a
   * module's weight depends on which OTHER modules reported, and only the
   * engine can see that.
   */
  const evidenceFor: string[] = [];
  if (verdict === "bullish") {
    evidenceFor.push(`Higher high confirmed — ${lastHigh.toFixed(2)} over ${prevHigh.toFixed(2)}`);
    evidenceFor.push(`Higher low confirmed — ${lastLow.toFixed(2)} over ${prevLow.toFixed(2)}`);
    evidenceFor.push(`Last swing low held; no structural break below ${prevLow.toFixed(2)}`);
  } else if (verdict === "bearish") {
    evidenceFor.push(`Lower high confirmed — ${lastHigh.toFixed(2)} under ${prevHigh.toFixed(2)}`);
    evidenceFor.push(`Lower low confirmed — ${lastLow.toFixed(2)} under ${prevLow.toFixed(2)}`);
    evidenceFor.push(`Last swing high rejected; no reclaim above ${prevHigh.toFixed(2)}`);
  }
  // Neutral states deliberately contribute NO supporting evidence. The
  // findings that matter there are the disagreement, and those are already
  // in `conflicts`. Padding a neutral verdict with observations would make
  // an absence of structure look like a body of evidence.

  const supporting: Array<{ label: string; value: string }> = [
    { label: "Swing highs", value: `${highs.length} in ${bars.length} sessions` },
    { label: "Swing lows", value: `${lows.length} in ${bars.length} sessions` },
    { label: "Last swing high", value: lastHigh.toFixed(2) },
    { label: "Last swing low", value: lastLow.toFixed(2) },
  ];
  if (levels?.supportPct !== null && levels?.supportPct !== undefined) {
    supporting.push({ label: "Nearest support", value: `${levels.supportPct.toFixed(1)}% below` });
  }
  if (levels?.resistancePct !== null && levels?.resistancePct !== undefined) {
    supporting.push({ label: "Nearest resistance", value: `${levels.resistancePct.toFixed(1)}% above` });
  }

  return {
    id: "marketStructure",
    label: "Market Structure",
    verdict,
    confidence,
    evidenceFor,
    supporting,
    confidenceBasis: `${highs.length} swing highs and ${lows.length} swing lows over ${bars.length} sessions. Confidence scales with how decisively both legs moved relative to the ${range > 0 ? `${((range / rangeLow) * 100).toFixed(0)}%` : "flat"} range, and is capped at 75 because a two-pivot sequence is short.`,
    explanation: `${instrument.symbol} is printing ${shape}. Last swing high ${lastHigh.toFixed(2)} vs prior ${prevHigh.toFixed(2)}; last swing low ${lastLow.toFixed(2)} vs prior ${prevLow.toFixed(2)}.`,
    whyItMatters:
      "Structure is the only read that describes the SHAPE of a move rather than its size. Two markets up the same amount are different trades if one is making higher lows and the other keeps undercutting them — and structure is what a stop is placed against.",
    asOf,
    conflicts,
    nextTrigger:
      verdict === "bullish"
        ? `breaks down below the last swing low of ${lastLow.toFixed(2)}`
        : verdict === "bearish"
          ? `breaks up above the last swing high of ${lastHigh.toFixed(2)}`
          : `resolves on a close outside ${lastLow.toFixed(2)}–${lastHigh.toFixed(2)}`,
  };
}
