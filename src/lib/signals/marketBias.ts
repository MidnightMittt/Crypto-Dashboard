import { BiasChange, MarketBias, MetricVerdict, RiskLevel, Verdict } from "./types";
import { agreementOf } from "./confidence";
import { computeWeightedScore, metricWeight, rankMetric } from "./scoring";
import { buildAllCategories, buildMarketHealth, buildTrendStrength, combineCategoryScores } from "./categories";
import { TechnicalRead } from "@/types/market";
import { RegimeTags } from "@/lib/technicals/regimes";

/**
 * Rolls every MetricVerdict into one answer: is the market leaning bullish,
 * bearish, or neither — and how much evidence stands behind that.
 *
 * `score` runs 0-100 with 50 exactly neutral. It is a WEIGHTED SUM OF
 * OPINIONS, not a probability and not a price target. Two things keep it
 * honest:
 *
 *   1. Each metric contributes its weight scaled by its own confidence, so
 *      a high-weight metric built on thin data can't dominate a
 *      well-evidenced one.
 *   2. Missing metrics are dropped and the remaining weights renormalized —
 *      never defaulted to neutral. Same rule buildMarketThesis uses;
 *      defaulting absent data to 50 would drag every reading toward the
 *      middle and make a data outage look like calm.
 */

/**
 * Risk is about how DANGEROUS conditions are, independent of direction —
 * a strongly bullish read in a crowded, volatile, conflicted market is a
 * high-risk bullish read, and collapsing those two ideas into one number
 * would hide exactly the thing worth knowing.
 */
function assessRisk(
  metrics: MetricVerdict[],
  technicals: TechnicalRead | null,
  squeezeScore: number | null
): { level: RiskLevel; rationale: string } {
  const reasons: string[] = [];
  let points = 0;

  const conflictCount = metrics.filter((m) => m.conflicts.length > 0).length;
  if (conflictCount >= 4) {
    points += 2;
    reasons.push(`${conflictCount} metrics carry internal contradictions`);
  } else if (conflictCount >= 2) {
    points += 1;
    reasons.push(`${conflictCount} metrics disagree with related signals`);
  }

  if (squeezeScore !== null && squeezeScore >= 70) {
    points += 2;
    reasons.push(`squeeze conditions are elevated (${squeezeScore}/100)`);
  } else if (squeezeScore !== null && squeezeScore >= 50) {
    points += 1;
    reasons.push(`squeeze conditions are building (${squeezeScore}/100)`);
  }

  if (technicals?.atrPct != null) {
    if (technicals.atrPct >= 4) {
      points += 2;
      reasons.push(`daily volatility is high (ATR ${technicals.atrPct.toFixed(1)}% of price)`);
    } else if (technicals.atrPct >= 2.5) {
      points += 1;
      reasons.push(`daily volatility is moderate (ATR ${technicals.atrPct.toFixed(1)}% of price)`);
    }
  }

  const level: RiskLevel = points >= 4 ? "high" : points >= 2 ? "medium" : "low";
  const rationale = reasons.length
    ? `${level === "high" ? "High" : level === "medium" ? "Medium" : "Low"} risk: ${reasons.join("; ")}.`
    : "Low risk: signals are consistent, volatility is contained, and no squeeze setup is building.";

  return { level, rationale };
}

/**
 * Never say "signals are mixed" or "conflicting" — that's a non-answer.
 * `score` is a continuous weighted pull; an EXACT tie (score === 50) is the
 * one case honestly described as "balanced" (both sides carry precisely
 * equal weight). Every other reading, including every other
 * "neutral"-VERDICT score (within DIRECTIONAL_THRESHOLD of 50, still not
 * an exact tie), has a real, nonzero lean — always name it and cite the
 * real metric driving it, never hedge it away.
 */
export function buildHeadline(
  verdict: Verdict,
  score: number,
  confidence: number,
  conflicted: boolean,
  topBullish: MetricVerdict | null,
  topBearish: MetricVerdict | null
): string {
  const strength = Math.abs(score - 50);

  if (score === 50) {
    return "Bullish and bearish evidence are evenly weighted right now — a genuinely flat read, not a close call.";
  }

  const direction = score > 50 ? "bullish" : "bearish";
  const leadMetric = direction === "bullish" ? topBullish : topBearish;
  const opposeMetric = direction === "bullish" ? topBearish : topBullish;
  const led = leadMetric ? ` (led by ${leadMetric.label})` : "";

  if (verdict === "neutral") {
    // Score leans a real direction but hasn't crossed the directional
    // threshold yet — still name the lean, never fall back to vague
    // "mixed"/"conflicting"/"uncertain" language.
    const against = opposeMetric
      ? ` — ${opposeMetric.label} is the strongest evidence still holding the other side back`
      : "";
    return `Leaning narrowly ${direction}${led}, not strong enough yet to act on${against}.`;
  }

  const qualifier = strength >= 20 ? "clearly" : strength >= 12 ? "moderately" : "modestly";
  const caveat =
    confidence < 40
      ? " — but the evidence behind it is thin, so treat it as a tilt rather than a setup"
      : conflicted
        ? ` — though ${opposeMetric ? `${opposeMetric.label} and other evidence disagree` : "some evidence disagrees"}, so conviction is limited`
        : "";

  return `Market is leaning ${qualifier} ${direction}${led}${caveat}.`;
}

export interface MarketBiasInputs {
  asset: string;
  metrics: MetricVerdict[];
  technicals: TechnicalRead | null;
  squeezeScore: number | null;
  /** Verdicts from the previous reading, keyed by metric id. Null on first run. */
  previous: Record<string, Verdict> | null;
  now: number;
  /**
   * Today's trend/volatility/range-bound classification (the same
   * classifyRegime() output the live regime badge and backtest bucketing
   * already use) — shifts CATEGORY_WEIGHTS via regimeWeights.ts before
   * combining. Defaults to null, which reproduces the exact pre-regime-
   * adjustment weighting; every existing caller not yet passing this sees
   * zero change.
   */
  regimeTags?: RegimeTags | null;
}

export function buildMarketBias(inputs: MarketBiasInputs): MarketBias | null {
  const { asset, metrics, technicals, squeezeScore, previous, now, regimeTags = null } = inputs;
  if (metrics.length === 0) return null;

  /*
   * The headline score is CATEGORY-weighted, not a flat per-metric sum:
   * group into Leveraged Positioning / Spot Demand / Market Stress /
   * Liquidity Map first, then combine those four via CATEGORY_WEIGHTS,
   * optionally shifted by today's market regime (regimeWeights.ts). See
   * categories.ts for the full taxonomy rationale.
   */
  const categories = buildAllCategories(metrics);
  const combined = combineCategoryScores(categories, regimeTags);
  if (!combined) return null;

  const { score, verdict, confidence } = combined;

  // Ranked by weight x confidence so the best-supported reasons lead, not
  // merely the loudest-sounding ones.
  const topBullish = metrics
    .filter((m) => m.verdict === "bullish")
    .sort((a, b) => rankMetric(b) - rankMetric(a))
    .slice(0, 5);
  const topBearish = metrics
    .filter((m) => m.verdict === "bearish")
    .sort((a, b) => rankMetric(b) - rankMetric(a))
    .slice(0, 5);

  const changes: BiasChange[] = [];
  if (previous) {
    for (const m of metrics) {
      const before = previous[m.id];
      if (before && before !== m.verdict) {
        changes.push({ label: m.label, from: before, to: m.verdict });
      }
    }
  }

  const conflicted = metrics.filter((m) => m.conflicts.length > 0).length >= 3;
  const risk = assessRisk(metrics, technicals, squeezeScore);

  /*
   * Agreement across the metrics themselves, NOT a restatement of
   * confidence. Liquidations is excluded because it is permanently neutral
   * by design, and counting a metric that can never take a side would
   * dilute every agreement figure identically and meaninglessly.
   */
  const agreement = Math.round(
    agreementOf(metrics.filter((m) => metricWeight(m.id) > 0).map((m) => m.verdict)) * 100
  );

  /*
   * Opportunity and counter-risk are the best-supported metric on each side
   * of the overall read. Both are existing verdicts, surfaced rather than
   * synthesized, so each traces back to a real number already on the page.
   * Null when the read is neutral: there is no thesis to support or oppose.
   */
  const aligned = verdict === "neutral" ? [] : verdict === "bullish" ? topBullish : topBearish;
  const opposing = verdict === "neutral" ? [] : verdict === "bullish" ? topBearish : topBullish;
  const opportunity = aligned[0] ?? null;
  const counterRisk = opposing[0] ?? null;

  /*
   * What to watch: metrics that both carry weight and can actually name the
   * level that would flip them. Ranked by weight so the ones that would move
   * the overall read most come first.
   */
  const watchNext = metrics
    .filter((m) => m.nextTrigger !== null && metricWeight(m.id) > 0)
    .sort((a, b) => metricWeight(b.id) - metricWeight(a.id))
    .slice(0, 4);

  return {
    asset,
    score,
    verdict,
    confidence,
    agreement,
    headline: buildHeadline(verdict, score, confidence, conflicted, topBullish[0] ?? null, topBearish[0] ?? null),
    topBullish,
    topBearish,
    opportunity,
    counterRisk,
    watchNext,
    changes,
    isFirstReading: previous === null,
    riskLevel: risk.level,
    riskRationale: risk.rationale,
    metrics,
    categories,
    trendStrength: buildTrendStrength(technicals),
    healthScore: buildMarketHealth(confidence, agreement, risk.level),
    updatedAt: now,
  };
}

/** Compact snapshot persisted between readings so "what changed" can be real. */
export function snapshotVerdicts(metrics: MetricVerdict[]): Record<string, Verdict> {
  return Object.fromEntries(metrics.map((m) => [m.id, m.verdict]));
}

export interface RankedReason extends MetricVerdict {
  side: "bullish" | "bearish";
}

/**
 * Merges `topBullish`/`topBearish` into ONE ranked list — the AI Market
 * Summary header's "top 5 reasons," interleaved by strength rather than
 * shown as two separate 5-max columns. Pure presentation logic: reuses
 * `rankMetric` (weight x confidence, the same ranking `topBullish`/
 * `topBearish` themselves were built with), no new signal.
 */
export function topReasons(bias: MarketBias, limit = 5): RankedReason[] {
  return [
    ...bias.topBullish.map((m) => ({ ...m, side: "bullish" as const })),
    ...bias.topBearish.map((m) => ({ ...m, side: "bearish" as const })),
  ]
    .sort((a, b) => rankMetric(b) - rankMetric(a))
    .slice(0, limit);
}
