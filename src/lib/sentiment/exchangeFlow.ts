import { ExchangeFlowSummary } from "@/types/market";

/**
 * Turns a current balance + a past balance into a netflow reading.
 *
 * Split from the fetch/storage layer for the same reason every other
 * derived signal in sentiment/ is: pure computation, testable against fixed
 * input, no network call or clock dependency.
 *
 * "Balanced" isn't zero — it's a dead zone scaled to the CURRENT balance
 * rather than a fixed USD amount, because a fixed threshold wouldn't mean
 * the same thing at different balance sizes: 50 BTC of movement is noise
 * against a quarter-million-BTC wallet but not against a small one. 0.1% is
 * a starting point, not settled science — the same honest framing this
 * codebase already uses for METRIC_WEIGHTS (lib/signals/scoring.ts) and
 * chartLean's flat-price thresholds.
 */
const BALANCED_THRESHOLD_PCT = 0.1;

export function classifyExchangeFlow(params: {
  asset: "BTC" | "ETH";
  currentBalanceNative: number;
  currentT: number;
  prior: { t: number; balanceNative: number } | null;
  priceUsd: number;
  venues: string[];
  trackedAddressCount: number;
}): ExchangeFlowSummary | null {
  const { asset, currentBalanceNative, currentT, prior, priceUsd, venues, trackedAddressCount } =
    params;

  // No prior snapshot yet (cold start, or not enough history accumulated) —
  // there's nothing to diff against. Null is the honest answer, not zero.
  if (!prior || !(currentBalanceNative > 0) || !(priceUsd > 0)) return null;

  const windowHours = (currentT - prior.t) / 3_600_000;
  if (windowHours <= 0) return null;

  const netflowNative = currentBalanceNative - prior.balanceNative;
  const netflowUsd = netflowNative * priceUsd;

  const netflowPctOfBalance =
    prior.balanceNative > 0 ? (Math.abs(netflowNative) / prior.balanceNative) * 100 : 0;

  // <=, not <: exactly at the threshold reads as "balanced", matching
  // chartLean's convention that the quiet reading wins ties.
  const direction: ExchangeFlowSummary["direction"] =
    netflowPctOfBalance <= BALANCED_THRESHOLD_PCT
      ? "balanced"
      : netflowNative > 0
        ? "inflow"
        : "outflow";

  return {
    asset,
    netflowUsd,
    netflowNative,
    currentBalanceUsd: currentBalanceNative * priceUsd,
    windowHours,
    direction,
    venues,
    trackedAddressCount,
  };
}
