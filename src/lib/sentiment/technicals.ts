import { TechnicalRead, ThesisDirection } from "@/types/market";
import {
  Candle,
  adx,
  atr,
  closes,
  directionalBias,
  ema,
  lastClose,
  macd,
  macdHistogramSeries,
  rollingVwap,
  rsi,
  rsiSeries,
  trendStructure,
  volumeRatio,
  bollingerBands,
  stochastic,
  obvTrend as obvTrendOf,
  supertrend,
  parabolicSar,
  ichimoku,
  fibonacciRetracement,
} from "../technicals/indicators";
import { classifyDivergence, DivergenceKind } from "../technicals/divergence";

/**
 * Turns raw indicator numbers into a directional read and plain-English
 * statements. The math lives in technicals/indicators.ts; this file holds
 * every judgment call about what the numbers MEAN.
 *
 * ── Why this is one composite read, not eight separate signals ─────────
 *
 * The dashboard deliberately gets ONE technical evidence entry in the market
 * thesis, not one per indicator. Eight entries would let technicals
 * outvote every positioning signal on the card by sheer count, which
 * inverts the point: this app's edge is derivatives positioning, and
 * technicals are here to CONFIRM OR CONTRADICT that read, not to replace
 * it. Six of these indicators are also different views of the same
 * underlying price series, so counting them separately would double-count
 * one piece of information.
 *
 * Thresholds below are conventional defaults (RSI 30/70, ADX 25, etc.) —
 * a defensible starting point, not settled science, same framing this app
 * already uses for FUNDING_BANDS and leans.ts.
 */

/** Above this ADX, the market is conventionally "trending" rather than ranging. */
const ADX_TRENDING = 25;
/** Below this ADX, directional readings carry much less weight. */
const ADX_RANGING = 20;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
/** RSI band treated as genuinely neutral rather than a mild lean. */
const RSI_NEUTRAL_LOW = 45;
const RSI_NEUTRAL_HIGH = 55;
/** Volume multiple above which a move counts as genuinely participated-in. */
const VOLUME_CONFIRMING = 1.2;
/** Volume multiple below which a move looks unconvinced. */
const VOLUME_WEAK = 0.7;

/** Minimum bars before any technical read is attempted at all. */
const MIN_CANDLES = 60;

/** Stochastic %K extremes — same fade-the-extreme convention as RSI (below). */
const STOCH_OVERBOUGHT = 80;
const STOCH_OVERSOLD = 20;

/**
 * MACD histogram must exceed this fraction of price to count as a vote.
 *
 * Without it, a histogram of -1.8e-15 — floating-point noise from two EMAs
 * that have mathematically converged — registers as a full bearish vote. A
 * steady linear uptrend hits exactly that case, and it flipped the read
 * from broadly bullish to barely bullish.
 */
const MACD_EPSILON_PCT = 1e-5;

/**
 * The maximum number of indicators that can vote: the original six (EMA
 * alignment, MACD, trend structure, VWAP, RSI, ADX bias) plus seven more
 * (Bollinger, Stochastic, OBV, Supertrend, Parabolic SAR, Ichimoku,
 * Fibonacci). Used to scale strength by participation so a 2-of-13 verdict
 * can't read as confidently as a 13-of-13.
 *
 * ── Fade vs. follow — why the new votes don't all point the same way ────
 *
 * Bollinger and Stochastic are OSCILLATORS: they vote against the extreme,
 * the same "fade the crowd" convention RSI already uses in this file (and
 * that marketThesis.ts uses for crowded funding) — price pinned to the
 * upper band or a stochastic near 100 reads as stretched, not as
 * confirmation to keep going.
 *
 * OBV, Supertrend and Parabolic SAR are TREND-FOLLOWING: they vote WITH
 * whatever direction they're currently reading, because that is what each
 * is designed to measure (volume confirming the move, or a live
 * trail-stop's current side).
 *
 * Ichimoku votes with price's position relative to the cloud (a
 * trend-following read); inside the cloud is genuine indecision and casts
 * no vote, the same way RSI's neutral band doesn't.
 *
 * Fibonacci is neither — a price sitting at a retracement level says
 * nothing on its own about direction. It only votes by BORROWING the
 * existing trend direction (`directionalBias`) when price is actually
 * near a level, i.e. "the trend's pullback found support/resistance where
 * theory says it should," never as a stand-alone signal.
 */
const MAX_VOTES = 13;

export function buildTechnicalRead(candles: Candle[]): TechnicalRead | null {
  if (candles.length < MIN_CANDLES) return null;

  const cl = closes(candles);
  const price = lastClose(candles);
  if (price === null || price <= 0) return null;

  const rsiValue = rsi(cl);
  const macdResult = macd(cl);
  const adxValue = adx(candles);
  const atrValue = atr(candles);
  const vwap = rollingVwap(candles);
  const volRatio = volumeRatio(candles);
  const structure = trendStructure(candles);
  const bias = directionalBias(candles);

  const bands = bollingerBands(cl);
  const stoch = stochastic(candles);
  const obvDirection = obvTrendOf(candles);
  const st = supertrend(candles);
  const sar = parabolicSar(candles);
  const cloud = ichimoku(candles);
  const fib = fibonacciRetracement(candles);

  const rsiDivergence = classifyDivergence(cl, rsiSeries(cl));
  const macdDivergence = classifyDivergence(cl, macdHistogramSeries(cl));

  const ema20 = ema(cl, 20);
  const ema50 = ema(cl, 50);
  const ema200 = ema(cl, 200);

  let emaAlignment: TechnicalRead["emaAlignment"] = null;
  if (ema20 !== null && ema50 !== null && ema200 !== null) {
    if (price > ema20 && price > ema50 && price > ema200) emaAlignment = "above-all";
    else if (price < ema20 && price < ema50 && price < ema200) emaAlignment = "below-all";
    else emaAlignment = "mixed";
  }

  /*
   * Direction is a simple vote across the readings that genuinely have one.
   * Each contributes at most one vote so no single indicator dominates, and
   * indicators that are absent (null) or neutral simply don't vote — the
   * same "missing data must not read as neutral-and-still-count" rule the
   * rest of this app follows.
   */
  const votes: ThesisDirection[] = [];

  if (emaAlignment === "above-all") votes.push("bullish");
  else if (emaAlignment === "below-all") votes.push("bearish");

  if (macdResult && Math.abs(macdResult.histogram) > price * MACD_EPSILON_PCT) {
    votes.push(macdResult.histogram > 0 ? "bullish" : "bearish");
  }

  if (structure === "higher-highs") votes.push("bullish");
  else if (structure === "lower-lows") votes.push("bearish");

  if (vwap !== null) votes.push(price > vwap ? "bullish" : "bearish");

  /*
   * RSI votes only OUTSIDE its neutral band, and NOT at the extremes.
   * Beyond 70/30 it stops being a trend-confirmation signal and becomes an
   * exhaustion warning — the same "fade the extreme" logic marketThesis.ts
   * already applies to crowded funding. Counting an overbought RSI as
   * bullish would double down exactly where the risk is highest.
   */
  if (rsiValue !== null) {
    if (rsiValue >= RSI_OVERBOUGHT) votes.push("bearish");
    else if (rsiValue <= RSI_OVERSOLD) votes.push("bullish");
    else if (rsiValue > RSI_NEUTRAL_HIGH) votes.push("bullish");
    else if (rsiValue < RSI_NEUTRAL_LOW) votes.push("bearish");
  }

  // ADX has no direction of its own, so it only votes via +DI/-DI, and only
  // when the trend is actually strong enough for that to mean something.
  if (bias && adxValue !== null && adxValue >= ADX_TRENDING) {
    votes.push(bias === "up" ? "bullish" : "bearish");
  }

  // Bollinger — fades the extreme, same convention as RSI above: pinned to
  // a band reads as stretched, not as license to keep pushing that way.
  let bollingerPosition: TechnicalRead["bollingerPosition"] = null;
  if (bands) {
    bollingerPosition = price > bands.upper ? "above-upper" : price < bands.lower ? "below-lower" : "inside";
    if (bollingerPosition === "above-upper") votes.push("bearish");
    else if (bollingerPosition === "below-lower") votes.push("bullish");
  }

  // Stochastic — same fade-the-extreme rule, only voting outside its bands.
  if (stoch !== null) {
    if (stoch.k >= STOCH_OVERBOUGHT) votes.push("bearish");
    else if (stoch.k <= STOCH_OVERSOLD) votes.push("bullish");
  }

  // OBV, Supertrend, Parabolic SAR, Ichimoku — all trend-FOLLOWING, so they
  // vote WITH their current reading rather than fading it.
  if (obvDirection) votes.push(obvDirection === "up" ? "bullish" : "bearish");
  if (st) votes.push(st.direction === "up" ? "bullish" : "bearish");
  if (sar) votes.push(sar.direction === "up" ? "bullish" : "bearish");
  if (cloud && cloud.priceVsCloud !== "inside") {
    votes.push(cloud.priceVsCloud === "above" ? "bullish" : "bearish");
  }

  // Fibonacci never votes on its own — see this file's header. It only
  // borrows the prevailing trend direction, and only when price is
  // actually sitting at a retracement level right now.
  if (fib && fib.nearestLevel !== null && bias) {
    votes.push(bias === "up" ? "bullish" : "bearish");
  }

  const bullVotes = votes.filter((v) => v === "bullish").length;
  const bearVotes = votes.filter((v) => v === "bearish").length;
  const total = bullVotes + bearVotes;

  let direction: ThesisDirection = "neutral";
  if (total > 0) {
    if (bullVotes > bearVotes) direction = "bullish";
    else if (bearVotes > bullVotes) direction = "bearish";
  }

  /*
   * strength = how lopsided the vote is x how many indicators voted at all,
   * damped when the market isn't actually trending. Deliberately the same
   * agreement-x-participation shape marketThesis.ts already uses for
   * conviction, for the same reason: without the participation term a
   * unanimous 2-of-6 verdict scores identically to a unanimous 6-of-6 one.
   *
   * That was a real bug, not a hypothetical — a flat, choppy series where
   * only EMA and VWAP could vote scored 100 while a clean uptrend scored 33.
   *
   * ADX being null (undefined trend strength) damps too. Not knowing the
   * regime is a reason for less confidence, not the same confidence.
   */
  const agreement = total > 0 ? Math.max(bullVotes, bearVotes) / total : 0.5;
  const directionalEdge = total === 0 ? 0 : agreement * 2 - 1;
  const participation = total / MAX_VOTES;
  const rangingDamp = adxValue === null || adxValue < ADX_RANGING ? 0.6 : 1;
  const strength = Math.round(
    Math.max(0, Math.min(100, directionalEdge * participation * rangingDamp * 100))
  );

  return {
    direction,
    strength,
    summary: buildSummary(direction, strength, adxValue, emaAlignment, structure),
    rsi: rsiValue,
    macdHistogram: macdResult ? macdResult.histogram : null,
    emaAlignment,
    adx: adxValue,
    atrPct: atrValue !== null ? (atrValue / price) * 100 : null,
    volumeRatio: volRatio,
    vwapPosition: vwap === null ? null : price > vwap ? "above" : "below",
    trendStructure: structure,
    bollingerBandwidthPct: bands ? bands.bandwidthPct : null,
    bollingerPosition,
    stochasticK: stoch ? stoch.k : null,
    obvTrend: obvDirection,
    supertrendDirection: st ? st.direction : null,
    parabolicSarDirection: sar ? sar.direction : null,
    ichimokuPosition: cloud ? cloud.priceVsCloud : null,
    fibonacciNearestLevel: fib ? fib.nearestLevel : null,
    rsiDivergence,
    macdDivergence,
  };
}

function buildSummary(
  direction: ThesisDirection,
  strength: number,
  adxValue: number | null,
  emaAlignment: TechnicalRead["emaAlignment"],
  structure: TechnicalRead["trendStructure"]
): string {
  const regime =
    adxValue === null
      ? "Trend strength unclear"
      : adxValue >= ADX_TRENDING
        ? "Price is in a defined trend"
        : adxValue < ADX_RANGING
          ? "Price is ranging rather than trending"
          : "Trend is developing but not yet established";

  if (direction === "neutral") {
    return `${regime}, with no clear directional bias in the technical picture.`;
  }

  const where =
    emaAlignment === "above-all"
      ? "trading above its 20, 50 and 200-day averages"
      : emaAlignment === "below-all"
        ? "trading below its 20, 50 and 200-day averages"
        : "mixed against its moving averages";

  const structureText =
    structure === "higher-highs"
      ? " and building higher highs"
      : structure === "lower-lows"
        ? " and cutting lower lows"
        : "";

  const conviction = strength >= 60 ? "broadly" : strength >= 30 ? "modestly" : "weakly";

  return `${regime}. Technicals lean ${conviction} ${direction} — ${where}${structureText}.`;
}

/**
 * The plain-English confirmation bullets shown on the Market Thesis card.
 *
 * Phrased RELATIVE to the thesis the rest of the dashboard already built, so
 * each line says whether price action backs that read or argues against it —
 * which is the whole point of the feature. Never restates a raw indicator
 * value as its own headline.
 *
 * Returns at most 5 lines, ordered most-important first.
 */
export function technicalConfirmation(read: TechnicalRead, dominant: ThesisDirection): string[] {
  const lines: string[] = [];
  const agrees = read.direction !== "neutral" && read.direction === dominant;
  const conflicts = read.direction !== "neutral" && dominant !== "neutral" && read.direction !== dominant;

  // 1. The headline: does price action back the positioning read or not.
  if (dominant === "neutral") {
    lines.push(
      read.direction === "neutral"
        ? "Positioning and price action are both non-committal — nothing here argues for a directional read."
        : `Positioning is mixed, but price action leans ${read.direction} — technicals are the only side currently taking a view.`
    );
  } else if (agrees) {
    lines.push(`Price action confirms the ${dominant} thesis — technicals and positioning point the same way.`);
  } else if (conflicts) {
    lines.push(
      `Price action argues against the ${dominant} thesis — technicals lean ${read.direction}, against how traders are positioned.`
    );
  } else {
    lines.push(`Price action is neutral, neither confirming nor contradicting the ${dominant} thesis.`);
  }

  // 2. Moving-average structure — the clearest "is the trend intact" read.
  if (read.emaAlignment === "above-all") {
    lines.push("Price is above its 20, 50 and 200-day moving averages, supporting continuation higher.");
  } else if (read.emaAlignment === "below-all") {
    lines.push("Price is below its 20, 50 and 200-day moving averages, supporting continuation lower.");
  } else if (read.emaAlignment === "mixed") {
    lines.push("Price is caught between its moving averages — no clean trend structure to lean on.");
  }

  // 3. Momentum — extremes first (exhaustion/washout warnings carry more
  //    weight than a divergence), then any genuine RSI/MACD divergence
  //    against price (only surfaced when the algorithm actually finds one —
  //    see technicals/divergence.ts), then a plain read.
  if (read.macdHistogram !== null && read.rsi !== null) {
    const momentumUp = read.macdHistogram > 0;
    const divergence = read.rsiDivergence ?? read.macdDivergence;
    if (read.rsi >= RSI_OVERBOUGHT) {
      lines.push(
        `Momentum is stretched (RSI ${read.rsi.toFixed(0)}) — historically closer to exhaustion than to a fresh leg up.`
      );
    } else if (read.rsi <= RSI_OVERSOLD) {
      lines.push(
        `Momentum is washed out (RSI ${read.rsi.toFixed(0)}) — the kind of level that has more often preceded relief than further downside.`
      );
    } else if (divergence?.kind === "regular-bullish") {
      lines.push(
        "Price is making a lower low but momentum is making a higher low — a bullish divergence warning that downside may be losing force, not yet a trend change."
      );
    } else if (divergence?.kind === "regular-bearish") {
      lines.push(
        "Price is making a higher high but momentum is making a lower high — a bearish divergence warning that upside may be losing force, not yet a trend change."
      );
    } else if (divergence?.kind === "hidden-bullish") {
      lines.push(
        "Momentum dipped on this pullback but price held a higher low — hidden bullish divergence, consistent with the uptrend continuing."
      );
    } else if (divergence?.kind === "hidden-bearish") {
      lines.push(
        "Momentum pushed higher on this bounce but price held a lower high — hidden bearish divergence, consistent with the downtrend continuing."
      );
    } else {
      lines.push(`Momentum is ${momentumUp ? "improving" : "deteriorating"}, consistent with the current price structure.`);
    }
  }

  // 4. Volume — does the move have participation behind it.
  if (read.volumeRatio !== null) {
    if (read.volumeRatio >= VOLUME_CONFIRMING) {
      lines.push(
        `Volume is running ${read.volumeRatio.toFixed(1)}x its recent average — the current move is backed by real participation.`
      );
    } else if (read.volumeRatio <= VOLUME_WEAK) {
      lines.push(
        `Volume is only ${read.volumeRatio.toFixed(1)}x its recent average — this move is not yet backed by conviction.`
      );
    }
  }

  // 5. Trend-strength caveat, which reframes everything above when weak.
  if (read.adx !== null && read.adx < ADX_RANGING && lines.length < 5) {
    lines.push(
      `Trend strength is weak (ADX ${read.adx.toFixed(0)}) — in a range like this, directional signals tend to mean-revert rather than follow through.`
    );
  } else if (read.adx !== null && read.adx >= ADX_TRENDING && lines.length < 5) {
    lines.push(`Trend strength is firm (ADX ${read.adx.toFixed(0)}), so directional signals carry more weight than usual here.`);
  }

  return lines.slice(0, 5);
}

/**
 * Whether price action backs the dominant positioning-based thesis, and how
 * much to trust that backing:
 *   - "confirms": direction agrees, and no live divergence undercuts it.
 *   - "weakens": direction agrees, but a REGULAR (reversal-warning)
 *     divergence opposes it — momentum isn't actually confirming the move.
 *   - "contradicts": direction actively opposes the thesis.
 *   - "not-yet-confirmed": technicals have no view, or there's no thesis to
 *     confirm in the first place.
 */
export type TechnicalAgreement = "confirms" | "weakens" | "contradicts" | "not-yet-confirmed";

/**
 * The structured judgment `technicalConfirmation`'s prose headline is built
 * from, exposed separately so a UI can color-code "does price action back
 * the rest of the metrics or fight them" without parsing sentences.
 *
 * Hidden divergence never downgrades an agreeing read — it's a
 * trend-CONTINUATION signal, not a warning (see technicals/divergence.ts's
 * header). Only a REGULAR divergence pointed against the dominant direction
 * moves an otherwise-agreeing read from "confirms" to "weakens."
 */
export function technicalAgreement(read: TechnicalRead, dominant: ThesisDirection): TechnicalAgreement {
  if (read.direction === "neutral" || dominant === "neutral") return "not-yet-confirmed";
  if (read.direction !== dominant) return "contradicts";

  const opposingKind: DivergenceKind = dominant === "bullish" ? "regular-bearish" : "regular-bullish";
  const opposed = read.rsiDivergence?.kind === opposingKind || read.macdDivergence?.kind === opposingKind;
  return opposed ? "weakens" : "confirms";
}
