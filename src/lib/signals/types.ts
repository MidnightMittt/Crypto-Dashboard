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
  /**
   * The concrete level at which this metric would change its own verdict,
   * e.g. "turns bullish above 0.04%/8h". Null when no meaningful threshold
   * exists (a metric already at an extreme, or one with no banded scale).
   *
   * Sourced from the SAME constants the verdict itself uses — see
   * `bandTrigger` in sentiment/bands.ts — so a stated trigger can never
   * drift from the logic it describes.
   */
  nextTrigger: string | null;
}

export type RiskLevel = "low" | "medium" | "high";

/**
 * The five groupings metrics roll up into before the overall score — a
 * layer between the flat 15-metric list and the single headline number.
 * `onchain` is spelled without punctuation to stay a valid object key;
 * display uses `CATEGORY_LABELS` in categories.ts.
 */
export type Category = "liquidity" | "momentum" | "derivatives" | "onchain" | "sentiment";

/** One category's rollup — same shape as MarketBias, one tier down. */
export interface CategoryScore {
  category: Category;
  label: string;
  score: number;
  verdict: Verdict;
  confidence: number;
  /** The single highest-ranked contributing metric's own explanation, reused verbatim. */
  topReason: string;
  /** Every metric feeding this category, for the "Why?" expansion. */
  metrics: MetricVerdict[];
}

export type TrendStrengthLabel = "Very Weak" | "Weak" | "Moderate" | "Strong" | "Very Strong";

export interface TrendStrength {
  label: TrendStrengthLabel;
  /** 0-100, the technicals.strength value this was bucketed from. */
  value: number;
}

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
  /**
   * 0-100: how much the metrics agree WITH EACH OTHER.
   *
   * Deliberately separate from `confidence`, which measures how good the
   * underlying evidence is. The two come apart in exactly the case worth
   * knowing about: a unanimous read built on thin data is high agreement
   * and low confidence, and collapsing them into one number would hide it.
   */
  agreement: number;
  headline: string;
  /** Ranked by weight x confidence, so the strongest-supported reasons lead. */
  topBullish: MetricVerdict[];
  topBearish: MetricVerdict[];
  /**
   * The best-supported metric AGREEING with the overall read — the clearest
   * asymmetry currently visible. Never a trade recommendation.
   */
  opportunity: MetricVerdict | null;
  /**
   * The best-supported metric ARGUING AGAINST the overall read: the most
   * likely reason this thesis turns out wrong.
   */
  counterRisk: MetricVerdict | null;
  /** Metrics closest to flipping, with the level that would do it. */
  watchNext: MetricVerdict[];
  /** Empty on the first run for an asset, which the UI states plainly. */
  changes: BiasChange[];
  /** True when there is no prior snapshot to diff against yet. */
  isFirstReading: boolean;
  riskLevel: RiskLevel;
  riskRationale: string;
  /** Every contributing verdict, for the per-metric display. */
  metrics: MetricVerdict[];
  /** The five category rollups this score was built from — see categories.ts. */
  categories: CategoryScore[];
  /** Null when no technical read is available (e.g. MARKET, or a fetch failure). */
  trendStrength: TrendStrength | null;
  /**
   * 0-100, DIRECTION-AGNOSTIC: how trustworthy and calm the picture is,
   * regardless of which way it leans. Deliberately distinct from `score`,
   * which IS directional — a health score that just repeated the bias
   * score under a new name would be redundant. See categories.ts.
   */
  healthScore: number;
  updatedAt: number;
}
