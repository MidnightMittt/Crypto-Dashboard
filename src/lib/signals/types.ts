export type Verdict = "bullish" | "bearish" | "neutral";

/**
 * The uniform contract every metric on this dashboard answers to:
 * "is this bullish, bearish, or neutral, and why?"
 *
 * ── What `confidence` is, and is NOT ───────────────────────────────────
 *
 * It is an EVIDENCE-QUALITY score: how much support this read has, built
 * from how complete the underlying data is, how well independent sources
 * agree, and whether any backtest covers it.
 *
 * It is NOT the probability of a price move. Nothing in this app has been
 * calibrated well enough to publish odds — see SqueezeRisk's own note in
 * types/market.ts that "labelling it a probability would imply a backtest
 * that does not exist". 80% confidence means "this read rests on solid,
 * agreeing data", never "price rises 80% of the time".
 *
 * The UI must always render it under a label that says so.
 */
export interface MetricVerdict {
  /** Stable key, used for weighting and for diffing against a prior snapshot. */
  id: string;
  label: string;
  verdict: Verdict;
  /** 0-100 evidence quality. Read the note above before surfacing this anywhere. */
  confidence: number;
  /** Plain-English account of what drove the confidence number. */
  confidenceBasis: string;
  /** One sentence: why this verdict, citing the real value behind it. */
  explanation: string;
  /** One sentence: why a trader should care about this metric at all. */
  whyItMatters: string;
  /** When the underlying data was observed. */
  asOf: number;
  /**
   * Related readings that point the other way. Populated rather than
   * smoothed over — the spec's "if signals conflict, say they conflict".
   */
  conflicts: string[];
}

export type RiskLevel = "low" | "medium" | "high";

/** One line of the "what changed since last update" diff. */
export interface BiasChange {
  label: string;
  from: Verdict;
  to: Verdict;
}

/**
 * The whole-market roll-up. `score` runs 0-100 where 50 is genuinely
 * neutral, built by weighting each MetricVerdict — NOT an average of
 * unweighted opinions, and NOT a probability.
 */
export interface MarketBias {
  asset: string;
  score: number;
  verdict: Verdict;
  /** Aggregate evidence quality across contributing metrics. */
  confidence: number;
  headline: string;
  /** Ranked by weight x confidence, so the strongest-supported reasons lead. */
  topBullish: MetricVerdict[];
  topBearish: MetricVerdict[];
  /** Empty on the first run for an asset, which the UI states plainly. */
  changes: BiasChange[];
  /** True when there is no prior snapshot to diff against yet. */
  isFirstReading: boolean;
  riskLevel: RiskLevel;
  riskRationale: string;
  /** Every contributing verdict, for the per-metric display. */
  metrics: MetricVerdict[];
  updatedAt: number;
}
