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
  /** Plain-English reading, e.g. "Below all 3 MAs" — never a bare number without meaning. */
  detail: string;
}

/** A dimension's own directional lean, before it is compared to the thesis. */
type Lean = "bullish" | "bearish" | "neutral" | null;

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
  dimensions.push({ label: "RSI", stance: stanceOf(rsiLean, dominant), detail: rsiDetail });

  // ── MACD ─────────────────────────────────────────────────────────────
  const macdLean: Lean =
    read.macdHistogram === null ? null : read.macdHistogram > 0 ? "bullish" : read.macdHistogram < 0 ? "bearish" : "neutral";
  dimensions.push({
    label: "MACD",
    stance: stanceOf(macdLean, dominant),
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
  dimensions.push({ label: "Volume", stance: volumeStance, detail: volumeDetail });

  return dimensions;
}
