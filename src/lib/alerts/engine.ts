import { AggregateMarketData, AlertRule } from "@/types/market";

export interface EvaluationContext {
  current: AggregateMarketData;
  /** Previous poll's aggregate, needed for "flip" and divergence rules. */
  previous?: AggregateMarketData;
}

/** Minimum gap between repeat firings of the same rule (ms). */
const COOLDOWN_MS = 5 * 60 * 1000;

export function evaluateRule(rule: AlertRule, ctx: EvaluationContext): string | null {
  if (!rule.enabled) return null;
  if (rule.lastTriggeredAt && Date.now() - rule.lastTriggeredAt < COOLDOWN_MS) return null;

  const { current, previous } = ctx;
  const funding = current.weightedFundingRatePct;

  switch (rule.metric) {
    case "funding_above":
      return funding > (rule.threshold ?? 0.08)
        ? `Funding is ${funding.toFixed(4)}% — above your ${rule.threshold}% threshold. Longs are paying up.`
        : null;

    case "funding_below":
      return funding < (rule.threshold ?? -0.08)
        ? `Funding is ${funding.toFixed(4)}% — below your ${rule.threshold}% threshold. Shorts are paying up.`
        : null;

    case "oi_change_above": {
      if (current.oiChange24hPct === null) return null;
      return current.oiChange24hPct > (rule.threshold ?? 10)
        ? `Open interest is up ${current.oiChange24hPct.toFixed(1)}% over 24h — leverage is building.`
        : null;
    }

    case "funding_flips_positive":
      if (!previous) return null;
      return previous.weightedFundingRatePct <= 0 && funding > 0
        ? `Funding just flipped positive (${funding.toFixed(4)}%). Positioning is rotating long.`
        : null;

    case "funding_flips_negative":
      if (!previous) return null;
      return previous.weightedFundingRatePct >= 0 && funding < 0
        ? `Funding just flipped negative (${funding.toFixed(4)}%). Positioning is rotating short.`
        : null;

    case "price_flat_oi_rising": {
      if (current.oiChange24hPct === null) return null;
      const priceChange = current.priceChange24hPct;
      const flat = Math.abs(priceChange) < 1.5;
      const oiRising = current.oiChange24hPct > 8;
      return flat && oiRising
        ? `Price is flat (${priceChange.toFixed(2)}%) while open interest climbs ${current.oiChange24hPct.toFixed(1)}%. Leverage is stacking without direction — squeeze setup.`
        : null;
    }

    case "funding_oi_divergence": {
      // Funding falling while OI rises (or vice versa) — positioning is
      // being added against the prevailing cost of carry.
      if (!previous) return null;
      const fundingDelta = funding - previous.weightedFundingRatePct;
      const oiDelta = current.totalOpenInterestUsd - previous.totalOpenInterestUsd;
      const diverging = Math.sign(fundingDelta) !== Math.sign(oiDelta) && Math.abs(fundingDelta) > 0.005;
      return diverging
        ? `Funding and open interest are diverging — funding ${fundingDelta > 0 ? "rising" : "falling"} while OI ${oiDelta > 0 ? "expands" : "contracts"}.`
        : null;
    }

    default:
      return null;
  }
}

export function evaluateAll(rules: AlertRule[], ctx: EvaluationContext) {
  return rules
    .map((rule) => ({ rule, message: evaluateRule(rule, ctx) }))
    .filter((r): r is { rule: AlertRule; message: string } => r.message !== null);
}

export const ALERT_PRESETS: Array<{ label: string; metric: AlertRule["metric"]; threshold?: number }> = [
  { label: "Funding above 0.08%", metric: "funding_above", threshold: 0.08 },
  { label: "Funding below -0.08%", metric: "funding_below", threshold: -0.08 },
  { label: "Open interest up >10% (24h)", metric: "oi_change_above", threshold: 10 },
  { label: "Funding flips positive", metric: "funding_flips_positive" },
  { label: "Funding flips negative", metric: "funding_flips_negative" },
  { label: "Price flat while OI rises", metric: "price_flat_oi_rising" },
  { label: "Funding / OI divergence", metric: "funding_oi_divergence" },
];
