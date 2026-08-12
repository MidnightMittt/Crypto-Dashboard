import { Bar } from "@/lib/research/types";
import { MetricVerdict, Verdict } from "@/lib/signals/types";

/**
 * RISK-ON / RISK-OFF — the top of the intelligence hierarchy.
 *
 * Everything below this level inherits from it. A sector that is leading in a
 * risk-off tape is a different proposition from the same sector leading in a
 * risk-on one, and a trade plan taken against the regime needs a better
 * reason than one taken with it.
 *
 * ── Measured from PAIRS, never from levels ────────────────────────────
 *
 * Each signal below is one asset divided by another, chosen so that the two
 * legs share almost everything except the appetite for risk. High yield
 * against Treasuries isolates credit appetite from the level of rates.
 * Discretionary against staples isolates the consumer's willingness to spend
 * from the consumer's existence. Semiconductors against the index isolates
 * appetite for the highest-beta corner of equities from equities themselves.
 *
 * A pair cancels the common factor and leaves the preference, which is the
 * only thing "risk appetite" can mean operationally. Reading the level of any
 * one of these instead would mostly measure the market.
 *
 * ── Emits MetricVerdict, so nothing here is a parallel engine ─────────
 *
 * These are ordinary evidence modules. They obey the same contract as
 * funding, breadth and market structure, carry the same confidence
 * semantics, and are consumed by the same surfaces. The hierarchy is a
 * reading order for the user, not a second scoring system.
 */

/** Roughly one quarter. Long enough that a single week cannot flip the read. */
const REGIME_SESSIONS = 63;
/** Roughly one month, for the "and is it still true" half. */
const REGIME_RECENT_SESSIONS = 21;

export interface RegimePair {
  id: string;
  label: string;
  /** The leg that rises when risk appetite rises. */
  riskOn: string;
  /** The leg that rises when it falls. */
  riskOff: string;
  /** Why this particular pair isolates appetite rather than direction. */
  rationale: string;
}

/**
 * Three pairs, from three independent corners of the market: credit, the
 * consumer, and equity beta. Deliberately few. A fourth correlated pair would
 * add apparent agreement without adding information, which is the failure the
 * signal philosophy warns about most directly.
 */
export const REGIME_PAIRS: RegimePair[] = [
  {
    id: "regimeCredit",
    label: "Credit Appetite",
    riskOn: "HYG",
    riskOff: "TLT",
    rationale:
      "High-yield credit against long Treasuries. Both are duration-sensitive, so the rate move cancels and what is left is whether investors are being paid to take default risk and taking it.",
  },
  {
    id: "regimeConsumer",
    label: "Consumer Appetite",
    riskOn: "XLY",
    riskOff: "XLP",
    rationale:
      "Discretionary against staples. Both are the same consumer in the same economy; the ratio is whether that consumer is buying optional things, which turns before earnings do.",
  },
  {
    id: "regimeBeta",
    label: "Equity Beta Appetite",
    riskOn: "SMH",
    riskOff: "SPY",
    rationale:
      "Semiconductors against the index. Semis are the highest-beta liquid expression of the equity market, so this measures willingness to hold the volatile end rather than equities in general.",
  },
];

export type RiskRegime = "risk-on" | "risk-off" | "mixed";

export interface RegimeRead {
  regime: RiskRegime;
  /** How many of the pairs agree with the headline, out of how many reported. */
  agreeing: number;
  total: number;
  headline: string;
  metrics: MetricVerdict[];
  asOf: number;
}

function changePct(bars: Bar[], sessions: number): number | null {
  if (bars.length <= sessions) return null;
  const last = bars[bars.length - 1].close;
  const prior = bars[bars.length - 1 - sessions].close;
  return prior > 0 ? ((last - prior) / prior) * 100 : null;
}

/**
 * One pair as an evidence module.
 *
 * Confidence rises with the SIZE of the spread relative to a quarter's
 * typical move, and is halved when the quarter and the month disagree —
 * a pair that led risk-on for three months and has reversed this month is
 * genuinely less informative about right now than one doing the same thing
 * on both horizons, and the number should say so rather than the prose.
 */
export function evaluateRegimePair(
  pair: RegimePair,
  riskOnBars: Bar[],
  riskOffBars: Bar[],
  asOf: number
): MetricVerdict | null {
  const onQ = changePct(riskOnBars, REGIME_SESSIONS);
  const offQ = changePct(riskOffBars, REGIME_SESSIONS);
  const onM = changePct(riskOnBars, REGIME_RECENT_SESSIONS);
  const offM = changePct(riskOffBars, REGIME_RECENT_SESSIONS);
  if (onQ === null || offQ === null || onM === null || offM === null) return null;

  const quarterSpread = onQ - offQ;
  const monthSpread = onM - offM;
  const agree = Math.sign(quarterSpread) === Math.sign(monthSpread);

  const verdict: Verdict = quarterSpread > 0 ? "bullish" : quarterSpread < 0 ? "bearish" : "neutral";

  /*
   * 10 percentage points over a quarter is treated as a full-strength spread.
   * Stated plainly: that is a judgement, not a calibrated constant, chosen
   * because it is roughly the scale these pairs move when a regime genuinely
   * turns. It caps rather than thresholds — nothing switches on it, it only
   * decides how loudly a real spread is allowed to speak.
   */
  const strength = Math.min(1, Math.abs(quarterSpread) / 10);
  const confidence = Math.round(strength * (agree ? 70 : 35));

  const direction = quarterSpread > 0 ? "risk-ON" : "risk-OFF";

  return {
    id: pair.id,
    label: pair.label,
    verdict,
    confidence,
    confidenceBasis: agree
      ? `The quarter (${fmt(quarterSpread)}) and the month (${fmt(monthSpread)}) point the same way, so the read is not resting on one window.`
      : `The quarter reads ${fmt(quarterSpread)} but the month reads ${fmt(monthSpread)} — the two horizons disagree, so confidence is halved. A turning pair is weaker evidence about now than a persistent one.`,
    // Magnitude only: the direction is already carried by the verb, and a
    // signed "+1.6pp" after "underperformed" reads as a contradiction.
    explanation: `${pair.riskOn} has ${quarterSpread >= 0 ? "outperformed" : "underperformed"} ${pair.riskOff} by ${Math.abs(quarterSpread).toFixed(1)}pp over the quarter — ${direction}.`,
    whyItMatters: pair.rationale,
    asOf,
    evidenceFor: [
      `${pair.riskOn} ${fmt(onQ)} vs ${pair.riskOff} ${fmt(offQ)} over ~3 months`,
      `${pair.riskOn} ${fmt(onM)} vs ${pair.riskOff} ${fmt(offM)} over ~1 month`,
    ],
    supporting: [
      { label: "Quarter spread", value: fmt(quarterSpread) },
      { label: "Month spread", value: fmt(monthSpread) },
      { label: "Risk-on leg", value: pair.riskOn },
      { label: "Risk-off leg", value: pair.riskOff },
    ],
    conflicts: agree
      ? []
      : [`The one-month spread (${fmt(monthSpread)}) points the opposite way to the quarter — this pair is in the middle of turning.`],
    nextTrigger: `flips when ${pair.riskOn} stops ${quarterSpread >= 0 ? "out" : "under"}performing ${pair.riskOff} over a quarter`,
  };
}

/**
 * The regime, from however many pairs reported.
 *
 * `mixed` is a real answer, not a failure to decide. When credit says one
 * thing and the consumer says another, that disagreement is the finding —
 * forcing it to a side would hide the single most useful thing a regime read
 * can tell you, which is that the market has not made up its mind.
 */
export function buildRegime(metrics: MetricVerdict[], asOf: number): RegimeRead | null {
  const reporting = metrics.filter((m) => m.verdict !== "neutral");
  if (metrics.length === 0) return null;

  const on = reporting.filter((m) => m.verdict === "bullish").length;
  const off = reporting.filter((m) => m.verdict === "bearish").length;

  const regime: RiskRegime = on > off ? "risk-on" : off > on ? "risk-off" : "mixed";
  const agreeing = regime === "risk-on" ? on : regime === "risk-off" ? off : Math.max(on, off);

  const named = (v: Verdict) =>
    reporting.filter((m) => m.verdict === v).map((m) => m.label).join(" and ");

  const headline =
    regime === "mixed"
      ? reporting.length === 0
        ? "Every risk pair is flat. There is no appetite signal in either direction right now, which is itself a reason not to size up."
        : `The market has not made up its mind. ${named("bullish")} say risk-on; ${named("bearish")} say risk-off. A split regime is the case where position size matters more than direction.`
      : regime === "risk-on"
        ? `Risk-ON, on ${agreeing} of ${reporting.length} independent pairs. ${named("bullish")} ${agreeing === 1 ? "is" : "are"} favouring the risk-seeking leg. Long setups inherit a tailwind; short setups are fighting the tape.`
        : `Risk-OFF, on ${agreeing} of ${reporting.length} independent pairs. ${named("bearish")} ${agreeing === 1 ? "is" : "are"} favouring the defensive leg. Treat long setups as counter-trend and demand better evidence for them.`;

  return { regime, agreeing, total: reporting.length, headline, metrics, asOf };
}

const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
