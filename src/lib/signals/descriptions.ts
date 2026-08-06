import { Category } from "./types";

/**
 * "What this measures", one line per metric id — the one piece of tooltip
 * copy that ISN'T already computed by an evaluator (whyItMatters and
 * nextTrigger are read straight off the live MetricVerdict; this is static
 * because "what funding rate measures" doesn't change reading to reading).
 */
export const METRIC_DESCRIPTIONS: Record<string, string> = {
  funding: "The periodic payment between long and short perpetual holders — positive means longs pay shorts.",
  openInterest: "Total value of open perpetual futures positions across venues.",
  squeezeRisk: "A composite score of conditions that have historically preceded forced-liquidation cascades.",
  longShort: "The ratio of long to short accounts across reporting venues.",
  basis: "The gap between perpetual futures price and spot price.",
  orderFlow: "Aggressive taker buy vs. sell volume on OKX over a rolling window.",
  spotCvd: "Aggressive taker buy vs. sell volume on OKX's SPOT market (not perp) over a rolling window — real, unleveraged demand.",
  liquidations: "Forced position closes over the trailing window, split by side.",
  options: "The ratio of open put contracts to open call contracts on Deribit.",
  exchangeFlow: "Net coin movement into or out of a tracked set of known exchange wallets.",
  coinbasePremium: "How Coinbase's spot price compares to the broader market's blended spot price.",
  technicals: "A composite read of price action — moving averages, momentum, and trend structure.",
  stablecoins: "7-day change in total stablecoin supply — a proxy for capital entering or leaving crypto.",
  fearGreed: "A composite of volatility, momentum, and volume into a single crowd-sentiment index.",
  etfFlows: "Net daily inflow or outflow across US spot ETFs for this asset.",
  spotPerpVolume: "Spot trading turnover compared to perpetual futures turnover on the same venue.",
  sectorBreadth: "Share of a tracked basket of crypto sectors (Layer 1, DeFi, AI, Meme, and others) with positive 24h market-cap change.",
  macroLiquidity: "Fed/Treasury liquidity flow (reverse repo + Treasury cash) combined with financial-conditions and yield-curve stress, from FRED.",
};

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  positioning: "How traders are positioned with leverage right now — funding, open interest, long/short skew, squeeze risk, basis, and forced liquidations.",
  marketStructure: "Whether real trend, momentum, and participation confirm the move — price action, sector breadth, taker flow, spot CVD, spot-vs-perp turnover, and Coinbase premium.",
  leadingDrivers: "The macro and liquidity backdrop upstream of anything crypto-native — Fed/Treasury liquidity conditions, ETF flows, and stablecoin supply.",
  risk: "Fragility and hedging-demand signals — Fear & Greed extremes, options put/call skew, and whale exchange netflow.",
};
