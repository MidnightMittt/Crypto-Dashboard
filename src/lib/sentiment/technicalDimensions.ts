import { TechnicalRead, ThesisDirection } from "@/types/market";
import { DivergenceKind } from "@/lib/technicals/divergence";
import {
  RSI_NEUTRAL_HIGH,
  RSI_NEUTRAL_LOW,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  VOLUME_CONFIRMING,
  VOLUME_WEAK,
} from "./technicals";

/**
 * Splits the already-computed `TechnicalRead` into the handful of named
 * dimensions a trader actually scans — Trend, Structure, RSI, MACD,
 * Divergence, Volume — and states each one's stance toward the current
 * thesis.
 *
 * PURE PRESENTATION. Nothing here computes an indicator, casts a vote, or
 * influences a decision: every value is read straight off a `TechnicalRead`
 * that `buildTechnicalRead` already produced, and every threshold is
 * imported from technicals.ts rather than redeclared. The existing
 * `technicalAgreement()` still owns the single composite verdict; this only
 * shows the trader WHICH parts of the read drive it, so "CONTRADICTS" stops
 * being an unexplained badge.
 *
 * Sharing the thresholds is the load-bearing detail. If this file hardcoded
 * its own RSI bands, a reading of 56 could render "RSI · confirms" beneath a
 * composite that never counted it — the grid would be quietly lying about
 * the verdict directly above it.
 */

/** Same four-state vocabulary `technicalAgreement()` already uses, plus an explicit no-data state. */
export type DimensionStance = "confirms" | "weakens" | "contradicts" | "neutral" | "unavailable";

export interface TechnicalDimension {
  label: string;
  stance: DimensionStance;
  /**
   * The indicator's OWN direction, independent of any thesis.
   *
   * `stance` answers "does this agree with the current thesis", which flips
   * whenever the thesis direction flips — even when the indicator itself
   * hasn't moved at all. `lean` answers "what is this indicator saying",
   * which changes only when the indicator does. That makes it both plainer
   * to read and structurally stable, which is why the UI leads with it.
   *
   * Always "neutral" for Volume: participation carries conviction, not
   * direction, and giving it one would fabricate a signal.
   */
  lean: Lean;
  /** Plain-English reading, e.g. "Below all 3 MAs" — never a bare number without meaning. */
  detail: string;
}

/** A dimension's own directional lean, before it is compared to the thesis. Null means no data. */
export type Lean = "bullish" | "bearish" | "neutral" | null;

/**
 * A lean only "confirms" or "contradicts" once there is a thesis direction
 * to agree with. When the thesis itself is neutral there is nothing to
 * confirm, so every dimension reads neutral rather than inventing agreement.
 */
function stanceOf(lean: Lean, dominant: ThesisDirection): DimensionStance {
  if (lean === null) return "unavailable";
  if (lean === "neutral" || dominant === "neutral") return "neutral";
  return lean === dominant ? "confirms" : "contradicts";
}

/** Human-readable divergence naming — the spec is explicit that a trader shouldn't have to decode an abbreviation. */
const DIVERGENCE_LABEL: Record<DivergenceKind, string> = {
  "regular-bullish": "Bullish divergence",
  "regular-bearish": "Bearish divergence",
  "hidden-bullish": "Hidden bullish divergence",
  "hidden-bearish": "Hidden bearish divergence",
};

const DIVERGENCE_LEAN: Record<DivergenceKind, Lean> = {
  "regular-bullish": "bullish",
  "regular-bearish": "bearish",
  // Hidden divergence signals CONTINUATION of the prevailing move, not
  // reversal — the opposite reading of its regular counterpart.
  "hidden-bullish": "bullish",
  "hidden-bearish": "bearish",
};

export function technicalDimensions(read: TechnicalRead, dominant: ThesisDirection): TechnicalDimension[] {
  const dimensions: TechnicalDimension[] = [];

  // ── Trend: price vs its moving averages ──────────────────────────────
  const emaLean: Lean =
    read.emaAlignment === "above-all"
      ? "bullish"
      : read.emaAlignment === "below-all"
        ? "bearish"
        : read.emaAlignment === "mixed"
          ? "neutral"
          : null;
  dimensions.push({
    label: "Trend",
    stance: stanceOf(emaLean, dominant),
    lean: emaLean,
    detail:
      read.emaAlignment === "above-all"
        ? "Above all 3 moving averages"
        : read.emaAlignment === "below-all"
          ? "Below all 3 moving averages"
          : read.emaAlignment === "mixed"
            ? "Caught between moving averages"
            : "No data",
  });

  // ── Structure: swing highs/lows ──────────────────────────────────────
  const structureLean: Lean =
    read.trendStructure === "higher-highs"
      ? "bullish"
      : read.trendStructure === "lower-lows"
        ? "bearish"
        : read.trendStructure === "sideways"
          ? "neutral"
          : null;
  dimensions.push({
    label: "Structure",
    stance: stanceOf(structureLean, dominant),
    lean: structureLean,
    detail:
      read.trendStructure === "higher-highs"
        ? "Higher highs"
        : read.trendStructure === "lower-lows"
          ? "Lower lows"
          : read.trendStructure === "sideways"
            ? "Sideways range"
            : "No data",
  });

  // ── RSI ──────────────────────────────────────────────────────────────
  // Mirrors buildTechnicalRead's own vote order exactly: the overbought/
  // oversold extremes are read as MEAN-REVERSION (stretched, so a fade),
  // which is the opposite lean from the mild 45-55 band trend read.
  let rsiLean: Lean = null;
  let rsiDetail = "No data";
  if (read.rsi !== null) {
    const v = read.rsi;
    if (v >= RSI_OVERBOUGHT) {
      rsiLean = "bearish";
      rsiDetail = `${v.toFixed(0)} — overbought`;
    } else if (v <= RSI_OVERSOLD) {
      rsiLean = "bullish";
      rsiDetail = `${v.toFixed(0)} — oversold`;
    } else if (v > RSI_NEUTRAL_HIGH) {
      rsiLean = "bullish";
      rsiDetail = `${v.toFixed(0)} — leaning strong`;
    } else if (v < RSI_NEUTRAL_LOW) {
      rsiLean = "bearish";
      rsiDetail = `${v.toFixed(0)} — leaning weak`;
    } else {
      rsiLean = "neutral";
      rsiDetail = `${v.toFixed(0)} — neutral`;
    }
  }
  dimensions.push({ label: "RSI", stance: stanceOf(rsiLean, dominant), lean: rsiLean, detail: rsiDetail });

  // ── MACD ─────────────────────────────────────────────────────────────
  const macdLean: Lean =
    read.macdHistogram === null ? null : read.macdHistogram > 0 ? "bullish" : read.macdHistogram < 0 ? "bearish" : "neutral";
  dimensions.push({
    label: "MACD",
    stance: stanceOf(macdLean, dominant),
    lean: macdLean,
    detail:
      read.macdHistogram === null
        ? "No data"
        : read.macdHistogram > 0
          ? "Histogram positive"
          : read.macdHistogram < 0
            ? "Histogram negative"
            : "Histogram flat",
  });

  // ── Divergence ───────────────────────────────────────────────────────
  // RSI divergence leads; MACD is the fallback when RSI shows none, since
  // showing two divergence rows would double-count one concept.
  const divergence = read.rsiDivergence ?? read.macdDivergence;
  const divergenceSource = read.rsiDivergence ? "RSI" : "MACD";
  dimensions.push({
    label: "Divergence",
    stance: divergence ? stanceOf(DIVERGENCE_LEAN[divergence.kind], dominant) : "neutral",
    lean: divergence ? DIVERGENCE_LEAN[divergence.kind] : "neutral",
    detail: divergence ? `${DIVERGENCE_LABEL[divergence.kind]} (${divergenceSource})` : "None meaningful",
  });

  // ── Volume ───────────────────────────────────────────────────────────
  // Deliberately NOT directional. Volume says how well-participated the
  // move is, so it can only strengthen or weaken conviction — it never
  // argues bullish or bearish on its own, and mapping it to a direction
  // would fabricate a signal the indicator doesn't carry.
  let volumeStance: DimensionStance = "unavailable";
  let volumeDetail = "No data";
  if (read.volumeRatio !== null) {
    const r = read.volumeRatio;
    volumeDetail = `${r.toFixed(1)}x average`;
    volumeStance = r >= VOLUME_CONFIRMING ? "confirms" : r <= VOLUME_WEAK ? "weakens" : "neutral";
  }
  dimensions.push({
    label: "Volume",
    stance: volumeStance,
    // Never directional by design — see TechnicalDimension.lean.
    lean: read.volumeRatio === null ? null : "neutral",
    detail: volumeDetail,
  });

  return dimensions;
}

/* ───────────────────────────────────────────────────────────────────────
 * ABSOLUTE TIMEFRAME READS
 *
 * The confirmation display used to render one thesis-RELATIVE badge
 * ("CONFIRMS"/"CONTRADICTS") computed against `thesis.dominant`. That value
 * has no deadband — it flips whenever bullWeight and bearWeight cross, which
 * was measured at ~8 times a day — so the badge churned even on days no
 * candle changed direction.
 *
 * These read each timeframe on its own terms instead. "DAILY: BEARISH" is
 * both plainer English and structurally stable: a daily read can only change
 * when a daily bar closes.
 * ─────────────────────────────────────────────────────────────────────── */

export type TimeframeLabel = "Daily" | "4H";

export interface TimeframeRead {
  timeframe: TimeframeLabel;
  /** The timeframe's own direction — never relative to a thesis. */
  direction: Lean;
  /** 0-100, as computed by buildTechnicalRead. */
  strength: number | null;
  /** BULLISH / BEARISH / NEUTRAL. */
  label: string;
  /** How convincing the read is, in words rather than a bare number. */
  qualifier: string;
}

/**
 * Strength bands. `buildTechnicalRead`'s strength already folds in how
 * lopsided the vote was AND how many indicators actually voted, so a low
 * number genuinely means "little to go on" rather than "balanced".
 */
function strengthQualifier(strength: number | null): string {
  if (strength === null) return "no data";
  if (strength >= 60) return "strong";
  if (strength >= 35) return "moderate";
  if (strength >= 15) return "weak";
  return "very weak";
}

export function timeframeRead(timeframe: TimeframeLabel, read: TechnicalRead | null): TimeframeRead {
  if (!read) {
    return { timeframe, direction: null, strength: null, label: "NO DATA", qualifier: "no data" };
  }
  const direction: Lean = read.direction;
  return {
    timeframe,
    direction,
    strength: read.strength,
    label: direction === "bullish" ? "BULLISH" : direction === "bearish" ? "BEARISH" : "NEUTRAL",
    qualifier: strengthQualifier(read.strength),
  };
}

/**
 * One sentence stating whether the two swing timeframes agree.
 *
 * Alignment is the single most useful thing a multi-timeframe display can
 * say, and leaving the reader to compare two badges is exactly the
 * ambiguity this replaces.
 */
export function multiTimeframeVerdict(daily: TimeframeRead, fourHour: TimeframeRead): { aligned: boolean; sentence: string } {
  if (daily.direction === null || fourHour.direction === null) {
    const present = daily.direction !== null ? daily : fourHour.direction !== null ? fourHour : null;
    return {
      aligned: false,
      sentence: present
        ? `${present.timeframe} is ${present.label.toLowerCase()}; the other timeframe has no read available.`
        : "No technical read is available on either timeframe.",
    };
  }

  if (daily.direction === "neutral" && fourHour.direction === "neutral") {
    return { aligned: true, sentence: "Both timeframes are neutral — no directional edge on either chart." };
  }
  if (daily.direction === fourHour.direction) {
    return { aligned: true, sentence: `Both timeframes are ${daily.direction} — aligned.` };
  }
  if (daily.direction === "neutral" || fourHour.direction === "neutral") {
    const directional = daily.direction === "neutral" ? fourHour : daily;
    const flat = daily.direction === "neutral" ? daily : fourHour;
    return {
      aligned: false,
      sentence: `${directional.timeframe} is ${directional.direction} while ${flat.timeframe} is flat — partial agreement only.`,
    };
  }
  return {
    aligned: false,
    // The case that matters most: genuinely opposed swing timeframes.
    sentence: `Daily is ${daily.direction} but 4H is ${fourHour.direction} — the timeframes conflict.`,
  };
}
