import { Bar } from "@/lib/research/types";
import { MetricVerdict, Verdict } from "@/lib/signals/types";

/**
 * EQUITY EVIDENCE MODULES — traditional-market evidence for the SAME engine.
 *
 * These emit `MetricVerdict`, the identical contract every crypto evaluator
 * already produces, so `buildMarketBias` scores an equity exactly the way it
 * scores BTC. There is no second decision engine and no equity-specific
 * scoring path; only the evidence differs, which is precisely the capability
 * split the architecture was built for.
 *
 * WHAT IS DELIBERATELY ABSENT. Funding, open interest, liquidations and
 * on-chain have no equity analogue and are simply not produced here — the
 * engine renormalises over the metrics it actually receives, so a missing
 * module is a smaller evidence base rather than a silent zero. Equally, ETF
 * flows, earnings, options flow and gamma are NOT implemented: no provider
 * for them is ingested, and emitting a verdict from data we do not have is
 * the one thing this codebase refuses to do.
 *
 * ON THRESHOLDS. There are no pre-existing equity bands to reuse, so rather
 * than invent round numbers every band below is a PERCENTILE of the measure's
 * own trailing history — the same discipline `atrPercentile` and the weekly
 * regime study's threshold calibration already apply. "Unusual for this
 * series" is a statement the data can support; "above 3%" is not.
 */

/** Sessions used for the medium-horizon comparisons. ~3 months, the standard relative-strength window. */
const RS_WINDOW = 60;
/** Sessions of trailing history the percentile bands are computed over. ~2 years. */
const BAND_HISTORY = 500;
/** A measure in the top/bottom third of its own history is a directional reading. */
const UPPER_PERCENTILE = 2 / 3;
const LOWER_PERCENTILE = 1 / 3;

export interface EquityInstrumentInput {
  symbol: string;
  bars: Bar[];
}

/** Trailing simple return over `n` sessions, as a percent. Null when history is short. */
function trailingReturnPct(bars: Bar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const then = bars[bars.length - 1 - n].close;
  const now = bars[bars.length - 1].close;
  return then > 0 ? ((now - then) / then) * 100 : null;
}

/**
 * Where `value` sits in `history`, 0-1. The basis for every band below:
 * a reading is directional because it is unusual FOR THIS SERIES, not
 * because it crossed a number someone picked.
 */
function percentileOf(value: number, history: number[]): number | null {
  if (history.length < 60) return null;

  let below = 0;
  let equal = 0;
  for (const h of history) {
    if (h < value) below++;
    else if (h === value) equal++;
  }

  /*
   * MID-RANK, not the count below.
   *
   * The naive `below / n` returns 0 when the value ties the entire
   * distribution — which is exactly what happens when two series move
   * identically and their relative strength is 0 at every point. That read
   * as the 0th percentile, i.e. a maximally BEARISH signal manufactured out
   * of zero variance. Caught by the "both rise together" test.
   *
   * Splitting the tied mass puts a value that equals everything at 0.5,
   * which is the honest answer: a measure with no variation carries no
   * directional information. Same failure mode, same fix, as the
   * zero-variance p-value in the panel estimator.
   */
  return (below + 0.5 * equal) / history.length;
}

/** Correct English ordinal — "71st", not "71th". User-facing copy, so it matters. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function verdictFromPercentile(p: number): Verdict {
  if (p >= UPPER_PERCENTILE) return "bullish";
  if (p <= LOWER_PERCENTILE) return "bearish";
  return "neutral";
}

/**
 * Confidence is how FAR from the middle the reading sits, scaled to 0-100,
 * then capped by how much history backed the percentile. A reading at the
 * 50th percentile carries no information and scores near zero; one at the
 * extreme scores high only if there was enough history to know it is extreme.
 */
function confidenceFrom(p: number, historyLength: number): number {
  const distance = Math.abs(p - 0.5) * 2; // 0 at the median, 1 at either tail
  const historyFactor = Math.min(1, historyLength / BAND_HISTORY);
  return Math.round(distance * historyFactor * 100);
}

/**
 * RELATIVE STRENGTH — is this instrument outperforming the benchmark?
 *
 * The single most load-bearing equity read there is: an index fund that lags
 * SPY in a rising market is not participating, and one that leads it in a
 * falling market is where money is hiding. Returns null for the benchmark
 * itself, because an instrument's strength relative to itself is definitionally
 * zero and rendering that as "neutral evidence" would pad the evidence base
 * with a non-observation.
 */
export function evaluateRelativeStrength(
  instrument: EquityInstrumentInput,
  benchmark: EquityInstrumentInput,
  asOf: number
): MetricVerdict | null {
  if (instrument.symbol === benchmark.symbol) return null;

  const rsNow = relativeStrengthAt(instrument.bars, benchmark.bars, instrument.bars.length - 1);
  if (rsNow === null) return null;

  // The comparison distribution: the same measure computed at every earlier
  // session, so "strong" means strong against this pair's own history.
  const history: number[] = [];
  const start = Math.max(RS_WINDOW, instrument.bars.length - BAND_HISTORY);
  for (let i = start; i < instrument.bars.length - 1; i++) {
    const v = relativeStrengthAt(instrument.bars, benchmark.bars, i);
    if (v !== null) history.push(v);
  }

  const p = percentileOf(rsNow, history);
  if (p === null) return null;

  const verdict = verdictFromPercentile(p);
  const lead = rsNow >= 0 ? "ahead of" : "behind";

  return {
    id: "equityRelativeStrength",
    label: "Relative Strength",
    verdict,
    confidence: confidenceFrom(p, history.length),
    confidenceBasis: `${history.length} prior sessions of this pair's own relative-strength history; current reading sits at the ${ordinal(Math.round(p * 100))} percentile of it.`,
    explanation: `Over ${RS_WINDOW} sessions ${instrument.symbol} is ${Math.abs(rsNow).toFixed(1)}pp ${lead} ${benchmark.symbol} — the ${ordinal(Math.round(p * 100))} percentile of its own history against that benchmark.`,
    whyItMatters:
      "An instrument that persistently lags its benchmark is not participating in the move, whatever its own chart says. Relative strength separates a rising tide from genuine demand.",
    asOf,
    conflicts: [],
    nextTrigger: triggerText(p, verdict),
  };
}

function relativeStrengthAt(instrument: Bar[], benchmark: Bar[], i: number): number | null {
  if (i < RS_WINDOW) return null;
  const inst = windowReturn(instrument, i, RS_WINDOW);
  // Align the benchmark by TIMESTAMP, never by index. Holiday calendars and
  // differing inception dates mean equal indices are not equal dates, and
  // comparing two different windows would silently manufacture a signal.
  const bench = benchmarkReturnAt(benchmark, instrument[i].t, instrument[i - RS_WINDOW].t);
  if (inst === null || bench === null) return null;
  return inst - bench;
}

function windowReturn(bars: Bar[], endIdx: number, n: number): number | null {
  const startIdx = endIdx - n;
  if (startIdx < 0) return null;
  const then = bars[startIdx].close;
  return then > 0 ? ((bars[endIdx].close - then) / then) * 100 : null;
}

/** Latest close at or before `t`. Null when the benchmark has no bar that old. */
function closeAtOrBefore(bars: Bar[], t: number): number | null {
  let found: number | null = null;
  for (const b of bars) {
    if (b.t > t) break;
    found = b.close;
  }
  return found;
}

function benchmarkReturnAt(benchmark: Bar[], endT: number, startT: number): number | null {
  const end = closeAtOrBefore(benchmark, endT);
  const start = closeAtOrBefore(benchmark, startT);
  if (end === null || start === null || start <= 0) return null;
  return ((end - start) / start) * 100;
}

/**
 * BREADTH — how much of the equity complex is participating?
 *
 * Honest scope note, stated in the output rather than buried here: this is
 * the share of a handful of broad ETFs trading above their own 50-session
 * average. That is a PROXY. Real breadth is the advance/decline line of index
 * constituents, which needs constituent data this platform does not ingest.
 * The proxy is directionally useful and is labelled as a proxy everywhere it
 * appears; it is not presented as the real thing.
 */
const BREADTH_MA = 50;

export function evaluateBreadth(universe: EquityInstrumentInput[], asOf: number): MetricVerdict | null {
  const readings = universe
    .map((u) => aboveOwnAverage(u.bars, BREADTH_MA))
    .filter((v): v is boolean => v !== null);

  if (readings.length < 3) return null;

  const share = readings.filter(Boolean).length / readings.length;
  const verdict: Verdict = share >= 0.65 ? "bullish" : share <= 0.35 ? "bearish" : "neutral";

  // Confidence is capped hard because the universe is small. Five instruments
  // cannot support the confidence a real advance/decline line would.
  const capped = Math.min(60, Math.round(Math.abs(share - 0.5) * 2 * 100));

  return {
    id: "equityBreadth",
    label: "Breadth (proxy)",
    verdict,
    confidence: capped,
    confidenceBasis: `${readings.length} broad ETFs, a PROXY for breadth rather than a constituent advance/decline line. Confidence is capped at 60 for that reason.`,
    explanation: `${Math.round(share * 100)}% of the ${readings.length} tracked equity ETFs are trading above their own ${BREADTH_MA}-session average.`,
    whyItMatters:
      "A rally carried by one or two names is fragile in a way the index level does not show. Broad participation is what separates a durable advance from a narrow one.",
    asOf,
    conflicts:
      share > 0.35 && share < 0.65
        ? ["Participation is split — neither broad enough to confirm strength nor narrow enough to warn."]
        : [],
    nextTrigger:
      verdict === "bullish"
        ? "turns neutral below 65% participation"
        : verdict === "bearish"
          ? "turns neutral above 35% participation"
          : "turns directional outside 35-65% participation",
  };
}

function aboveOwnAverage(bars: Bar[], n: number): boolean | null {
  if (bars.length < n + 1) return null;
  const window = bars.slice(-n);
  const avg = window.reduce((a, b) => a + b.close, 0) / window.length;
  return bars[bars.length - 1].close > avg;
}

/**
 * RISK APPETITE — credit versus duration.
 *
 * High-yield credit (HYG) outperforming long Treasuries (TLT) is the classic
 * risk-on tell: investors are being paid to take credit risk and are taking
 * it. The reverse is a flight to duration. This is one of the few genuinely
 * cross-asset reads available from price alone, and it is the equity
 * counterpart to the stablecoin/funding "is anyone willing to take risk"
 * question the crypto engine already asks.
 */
const RISK_WINDOW = 20;

export function evaluateRiskAppetite(
  credit: EquityInstrumentInput | undefined,
  duration: EquityInstrumentInput | undefined,
  asOf: number
): MetricVerdict | null {
  if (!credit || !duration) return null;

  const creditRet = trailingReturnPct(credit.bars, RISK_WINDOW);
  const durationRet = trailingReturnPct(duration.bars, RISK_WINDOW);
  if (creditRet === null || durationRet === null) return null;

  const spread = creditRet - durationRet;

  const history: number[] = [];
  const start = Math.max(RISK_WINDOW, credit.bars.length - BAND_HISTORY);
  for (let i = start; i < credit.bars.length; i++) {
    const c = windowReturn(credit.bars, i, RISK_WINDOW);
    const d = benchmarkReturnAt(duration.bars, credit.bars[i].t, credit.bars[i - RISK_WINDOW].t);
    if (c !== null && d !== null) history.push(c - d);
  }

  const p = percentileOf(spread, history);
  if (p === null) return null;

  const verdict = verdictFromPercentile(p);

  return {
    id: "equityRiskAppetite",
    label: "Risk Appetite",
    verdict,
    confidence: confidenceFrom(p, history.length),
    confidenceBasis: `${history.length} prior sessions of the same credit-minus-duration spread; the current reading is at its ${ordinal(Math.round(p * 100))} percentile.`,
    explanation: `Over ${RISK_WINDOW} sessions ${credit.symbol} is ${spread >= 0 ? "outperforming" : "underperforming"} ${duration.symbol} by ${Math.abs(spread).toFixed(1)}pp — ${verdict === "bullish" ? "money is being paid to take credit risk and is taking it" : verdict === "bearish" ? "capital is rotating into duration, the classic defensive move" : "neither side is decisively favoured"}.`,
    whyItMatters:
      "Credit turns before equity does more often than not. When high yield stops keeping up with Treasuries, the bid for risk is weakening regardless of where the index is trading.",
    asOf,
    conflicts: [],
    nextTrigger: triggerText(p, verdict),
  };
}

function triggerText(p: number, verdict: Verdict): string {
  if (verdict === "bullish") return `turns neutral below the ${Math.round(UPPER_PERCENTILE * 100)}th percentile of its own history`;
  if (verdict === "bearish") return `turns neutral above the ${Math.round(LOWER_PERCENTILE * 100)}th percentile of its own history`;
  return `turns directional outside the ${Math.round(LOWER_PERCENTILE * 100)}th-${Math.round(UPPER_PERCENTILE * 100)}th percentile band (currently ${ordinal(Math.round(p * 100))})`;
}

/**
 * Everything the equity capability set can currently produce. Nulls are
 * dropped rather than replaced with placeholders, so the engine sees the
 * evidence that exists and renormalises over it.
 */
export function buildEquityEvidence(opts: {
  instrument: EquityInstrumentInput;
  benchmark: EquityInstrumentInput;
  universe: EquityInstrumentInput[];
  credit?: EquityInstrumentInput;
  duration?: EquityInstrumentInput;
  asOf: number;
}): MetricVerdict[] {
  return [
    evaluateRelativeStrength(opts.instrument, opts.benchmark, opts.asOf),
    evaluateBreadth(opts.universe, opts.asOf),
    evaluateRiskAppetite(opts.credit, opts.duration, opts.asOf),
    evaluateVolatilityRegime(opts.instrument, opts.asOf),
    evaluateTrendQuality(opts.instrument, opts.asOf),
  ].filter((m): m is MetricVerdict => m !== null);
}

/* ═══════════════════════════════════════════════════════════════════════
 * VOLATILITY REGIME and TREND QUALITY
 *
 * Both are computable honestly from ingested OHLCV alone, which is why they
 * are here and options flow is not. They widen the equity evidence base from
 * three modules to five so a Markets decision does not rest on relative
 * strength almost by itself.
 * ═══════════════════════════════════════════════════════════════════════ */

const ATR_WINDOW = 14;
const TREND_WINDOW = 60;

/** Average true range over `n` bars ending at `endIdx`, as a percent of price. */
function atrPctAt(bars: Bar[], endIdx: number, n: number): number | null {
  if (endIdx < n) return null;
  let sum = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) {
    const prev = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev));
  }
  const price = bars[endIdx].close;
  return price > 0 ? (sum / n / price) * 100 : null;
}

/**
 * VOLATILITY REGIME — is this market calm or stressed, for itself?
 *
 * Direction, and why it is defensible. Volatility is not directional in
 * general, but in EQUITY indices the negative volatility-return relationship
 * is among the most robust facts in the literature: vol expands into
 * drawdowns and compresses through advances. So an elevated reading is
 * treated as a headwind and a compressed one as benign.
 *
 * Confidence is deliberately halved against the other modules. This is a
 * conditional regularity, not a mechanism, and it should never outweigh a
 * direct read like relative strength. Overstating it would be the
 * indicator-bloat the charter warns against.
 */
export function evaluateVolatilityRegime(
  instrument: EquityInstrumentInput,
  asOf: number
): MetricVerdict | null {
  const bars = instrument.bars;
  const now = atrPctAt(bars, bars.length - 1, ATR_WINDOW);
  if (now === null) return null;

  const history: number[] = [];
  const start = Math.max(ATR_WINDOW, bars.length - BAND_HISTORY);
  for (let i = start; i < bars.length - 1; i++) {
    const v = atrPctAt(bars, i, ATR_WINDOW);
    if (v !== null) history.push(v);
  }

  const p = percentileOf(now, history);
  if (p === null) return null;

  // Inverted against the generic mapping: HIGH volatility is the bearish end.
  const verdict: Verdict = p >= UPPER_PERCENTILE ? "bearish" : p <= LOWER_PERCENTILE ? "bullish" : "neutral";

  return {
    id: "equityVolatilityRegime",
    label: "Volatility Regime",
    verdict,
    confidence: Math.round(confidenceFrom(p, history.length) / 2),
    confidenceBasis: `${history.length} prior sessions of this instrument's own ATR history. Confidence is halved deliberately: the volatility-return relationship is a conditional regularity, not a mechanism.`,
    explanation: `${instrument.symbol}'s 14-session ATR is ${now.toFixed(2)}% of price — the ${ordinal(Math.round(p * 100))} percentile of its own history. ${verdict === "bearish" ? "Elevated volatility is a headwind; equity vol expands into drawdowns." : verdict === "bullish" ? "Compressed volatility is the benign regime equity advances usually occur in." : "Volatility is unremarkable for this instrument."}`,
    whyItMatters:
      "Position size and stop distance both scale with volatility, so the same trade is a different risk in a different regime. In equities specifically, expanding volatility tends to accompany falling prices.",
    asOf,
    conflicts: [],
    nextTrigger: triggerText(p, verdict === "bearish" ? "bullish" : verdict === "bullish" ? "bearish" : "neutral"),
  };
}

/**
 * TREND QUALITY — is the move a trend, or a round trip that happens to end
 * somewhere?
 *
 * Kaufman's efficiency ratio: net displacement divided by the total distance
 * travelled. 1.0 is a straight line, near 0 is chop. The same measure
 * `features.ts` already publishes as `efficiency_20d`, so this is a house
 * statistic rather than a new one.
 *
 * The efficiency ratio is DIRECTIONLESS, so it is used the honest way: the
 * SIGN of the net move sets the verdict, and efficiency scales the
 * confidence. "Up and clean" is strong evidence; "up but choppy" is the same
 * direction with much less to say for itself. Using efficiency alone as a
 * verdict would claim a direction the measure does not contain.
 */
export function evaluateTrendQuality(
  instrument: EquityInstrumentInput,
  asOf: number
): MetricVerdict | null {
  const bars = instrument.bars;
  if (bars.length < TREND_WINDOW + 1) return null;

  const window = bars.slice(-(TREND_WINDOW + 1));
  const net = window[window.length - 1].close - window[0].close;
  let distance = 0;
  for (let i = 1; i < window.length; i++) distance += Math.abs(window[i].close - window[i - 1].close);
  if (distance <= 0) return null;

  const efficiency = Math.abs(net) / distance; // 0..1
  const netPct = window[0].close > 0 ? (net / window[0].close) * 100 : 0;

  /*
   * A deadband on efficiency, not on the return. A 0.5% move over 60
   * sessions is directionally up, but calling it a bullish trend because the
   * sign happens to be positive is exactly the false precision the engine is
   * supposed to avoid. Below the floor the module reports neutral and says
   * why.
   */
  const EFFICIENCY_FLOOR = 0.2;
  const verdict: Verdict =
    efficiency < EFFICIENCY_FLOOR ? "neutral" : netPct > 0 ? "bullish" : "bearish";

  return {
    id: "equityTrendQuality",
    label: "Trend Quality",
    verdict,
    confidence: Math.round(Math.min(1, efficiency / 0.6) * 100),
    confidenceBasis: `Kaufman efficiency ratio of ${efficiency.toFixed(2)} over ${TREND_WINDOW} sessions. Confidence scales with efficiency and reaches 100 at 0.60, a strongly directional path.`,
    explanation: `Over ${TREND_WINDOW} sessions ${instrument.symbol} moved ${netPct >= 0 ? "+" : ""}${netPct.toFixed(1)}% with an efficiency ratio of ${efficiency.toFixed(2)} — ${efficiency < EFFICIENCY_FLOOR ? "a round trip rather than a trend, so no direction is claimed" : efficiency > 0.4 ? "a clean, persistent path" : "a directional but choppy path"}.`,
    whyItMatters:
      "Direction alone does not say whether a move is worth following. The same net return produced by a straight line and by a round trip demand different trades; efficiency is what separates them.",
    asOf,
    conflicts:
      efficiency < EFFICIENCY_FLOOR
        ? [`Net move is ${netPct >= 0 ? "positive" : "negative"} but the path is inefficient — the sign is not evidence of a trend.`]
        : [],
    nextTrigger: `turns directional above an efficiency ratio of ${EFFICIENCY_FLOOR.toFixed(2)} (currently ${efficiency.toFixed(2)})`,
  };
}
