import { MetricVerdict, Verdict } from "@/lib/signals/types";
import { TechnicalRead } from "@/types/market";
import { HarmonicEvidence } from "@/lib/signals/harmonicEvidence";
import { formatPrice } from "@/lib/utils/format";

/**
 * CHART EVIDENCE FOR THE LIVE TICKER PATH.
 *
 * The deep technical layer (RSI, MACD, EMA alignment, ADX, Bollinger,
 * supertrend, Ichimoku, divergence — all inside `buildTechnicalRead`) and the
 * harmonic engine already existed and were fully tested; they simply only ran
 * on the crypto aggregator path. These two adapters translate their outputs
 * into the `MetricVerdict` contract so a searched ticker gets the same chart
 * intelligence the crypto page has always had.
 *
 * ── Why adapters instead of reusing `evaluateTechnicals` ──────────────
 *
 * The crypto evaluator is welded to `AggregateMarketData` and the live
 * exchange context. What it CLAIMS, though, is portable, and both rules it
 * enforces are reproduced here exactly so the two paths can never disagree
 * about the same chart:
 *
 *   1. Below strength 20 the read reports NEUTRAL regardless of direction —
 *      a barely-leaning composite is noise wearing a sign.
 *   2. A weak ADX (< 20) is a named conflict, because directional signals in
 *      a ranging tape tend to mean-revert rather than follow through.
 */

const NEUTRAL_BELOW_STRENGTH = 20;
const WEAK_ADX = 20;

export function technicalsMetric(t: TechnicalRead, asOf: number): MetricVerdict {
  const verdict: Verdict =
    t.strength < NEUTRAL_BELOW_STRENGTH || t.direction === "neutral"
      ? "neutral"
      : t.direction === "bullish"
        ? "bullish"
        : "bearish";

  const conflicts: string[] = [];
  if (t.adx !== null && t.adx < WEAK_ADX) {
    conflicts.push(
      `Trend strength is weak (ADX ${t.adx.toFixed(0)}), so directional signals here tend to mean-revert rather than follow through.`
    );
  }
  /*
   * Only REGULAR divergence argues against the verdict — hidden divergence is
   * a continuation signal that agrees with the trend, and treating it as a
   * conflict would invert its meaning.
   */
  if (t.rsiDivergence?.kind === "regular-bearish" && verdict === "bullish") {
    conflicts.push("Momentum is diverging bearishly against price — the move is running on fewer buyers than it was.");
  }
  if (t.rsiDivergence?.kind === "regular-bullish" && verdict === "bearish") {
    conflicts.push("Momentum is diverging bullishly against price — sellers are losing force even as price falls.");
  }

  return {
    id: "technicals",
    label: "Price Action",
    verdict,
    /*
     * Strength doubles as confidence here, exactly as on the crypto path:
     * it already counts how many independent indicator votes agree, and is
     * already damped by ADX inside buildTechnicalRead itself.
     */
    confidence: Math.round(t.strength),
    confidenceBasis: `${t.strength}/100 of the indicator votes agree on this direction; ADX ${t.adx === null ? "unavailable" : t.adx.toFixed(0)} ${t.adx !== null && t.adx < WEAK_ADX ? "(ranging — the read is damped)" : ""}`.trim(),
    explanation: t.summary,
    whyItMatters:
      "Every other reading measures conditions around the asset. This is the one measuring what price itself is actually doing — RSI, MACD, moving-average alignment, volatility bands and trend structure, combined into one vote.",
    asOf,
    conflicts,
    nextTrigger: `Strength ${t.strength}/100 — below ${NEUTRAL_BELOW_STRENGTH} this reports neutral regardless of direction.`,
  };
}

/**
 * The best harmonic pattern, as DISPLAYED evidence.
 *
 * Deliberately non-voting: `harmonics` is not in METRIC_ROLES, so its weight
 * is zero on both bases. That is not caution for its own sake — the
 * incremental-value study run on the production harmonic engine measured
 * limited additional edge over the existing structure evidence, and a module
 * whose measured contribution is small does not get to move the score. It
 * still earns its place on the page: a completion zone with a price range is
 * exactly the kind of level a trader can set an alert on.
 */
export function harmonicMetric(h: HarmonicEvidence, asOf: number): MetricVerdict {
  const zone = `${formatPrice(h.przLow)}–${formatPrice(h.przHigh)}`;
  const stateLine =
    h.status === "confirmed"
      ? `price has reached the zone and shown a ${h.structureReaction === "rejection" ? "rejection — the reversal reaction the pattern calls for" : "reaction that is still forming"}`
      : h.przTested
        ? "price is testing the zone now"
        : h.distanceAtr > 0
          ? `price is about ${h.distanceAtr.toFixed(1)} average daily ranges away from it`
          : "price is inside the zone";

  return {
    id: "harmonics",
    label: "Harmonic Pattern",
    verdict: h.direction,
    confidence: Math.round(h.geometryQuality * 60), // capped: geometry precision, never certainty
    confidenceBasis: `Leg-fit precision ${(h.geometryQuality * 100).toFixed(0)}% with ${h.przConvergenceCount} independent measurements converging on the zone. Capped deliberately — geometry quality is not a win probability.`,
    explanation: `A ${h.direction} ${h.pattern} pattern projects a completion zone at ${zone}, and ${stateLine}. ${
      h.regimeAlignment === "counter-trend"
        ? "It argues AGAINST the prevailing trend, which is the lower-odds side of these patterns."
        : h.regimeAlignment === "aligned"
          ? "It agrees with the prevailing trend."
          : ""
    }`.trim(),
    whyItMatters:
      "Harmonic zones are price areas where several ratio measurements of earlier swings converge. They do not vote in the score — their measured extra edge over ordinary support/resistance was small — but a mapped completion zone is a concrete level to plan around rather than a prediction.",
    asOf,
    conflicts:
      h.regimeAlignment === "counter-trend"
        ? ["This pattern trades against the prevailing trend, and counter-trend completions fail more often."]
        : [],
    nextTrigger: `resolves at the ${zone} zone — a rejection there argues ${h.direction === "bullish" ? "up" : "down"}; a clean break through it voids the pattern`,
  };
}
