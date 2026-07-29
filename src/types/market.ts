// ─────────────────────────────────────────────────────────────────────────
// Core domain types. Every exchange adapter resolves to this shape.
//
// Design rule: a field is `number | null` when a venue may genuinely not
// publish it. `null` means "this exchange does not report this" and the UI
// renders it as "—". Nothing in this app ever substitutes an invented
// number for a missing one.
// ─────────────────────────────────────────────────────────────────────────

export type ExchangeType = "CEX" | "DEX";

/** Every registered exchange is live. Kept as a type for forward safety. */
export type ExchangeStatus = "live";

export type AssetSymbol =
  | "BTC" | "ETH" | "SOL" | "BNB" | "SUI"
  | "XRP" | "DOGE" | "LINK" | "ADA" | "AVAX";

export interface ExchangeMeta {
  id: string;
  name: string;
  type: ExchangeType;
  status: ExchangeStatus;
  color: string;
  docsUrl: string;
  assets: AssetSymbol[];
  /**
   * True when this venue has no direct adapter and is only reachable through
   * an aggregator. These are never reported as "unavailable" — their absence
   * just means no configured provider covered them this cycle.
   */
  providerOnly?: boolean;
}

/** A single exchange's current snapshot for one asset. */
export interface ExchangeSnapshot {
  exchangeId: string;
  asset: AssetSymbol;
  fundingRatePct: number; // per-interval rate, e.g. 0.0125 = 0.0125%
  fundingIntervalHours: number; // 1, 4, or 8 depending on venue
  nextFundingAt: number; // unix ms
  openInterestUsd: number;
  /** null when the venue exposes no OI history endpoint. */
  openInterestChange24hPct: number | null;
  volume24hUsd: number;
  /** null when the venue publishes no positioning data (most DEXs). */
  longShortRatio: number | null;
  price: number;
  priceChange24hPct: number;
  /** Where this snapshot came from — shown in the UI for transparency. */
  source?: "direct" | "coinalyze" | "defillama" | "coingecko";
  /** Recent funding history for the card sparkline. Empty if unavailable. */
  sparkline: number[];
  fundingHistory: FundingPoint[];
  updatedAt: number;
}

export interface FundingPoint {
  t: number; // unix ms
  fundingRatePct?: number;
  openInterestUsd?: number;
  price?: number;
}

export type Timeframe = "15m" | "1H" | "4H" | "12H" | "1D" | "1W";

/** Aggregated, cross-exchange view for one asset (or the whole market). */
export interface AggregateMarketData {
  asset: AssetSymbol | "MARKET";
  weightedFundingRatePct: number;
  fundingAnnualizedPct: number;
  fundingChange24hPct: number | null;
  totalOpenInterestUsd: number;
  oiChange24hPct: number | null;
  oiPercentile: number | null;
  longShortRatio: number | null;
  leverageHeatScore: number | null;
  compositeSentimentScore: number;
  priceChange24hPct: number;
  exchanges: ExchangeSnapshot[];
  /** Venues that were queried but returned nothing, for UI transparency. */
  unavailableExchanges: string[];
  /** Spot reference price (DexScreener), for basis. Null if unavailable. */
  spotPriceUsd: number | null;
  /** Spot source description, e.g. "raydium · solana". */
  spotSource: string | null;
  /** (perp - spot) / spot * 100. Positive = perps above spot. */
  basisPct: number | null;
  /** Widest % gap across responding spot sources. High = don't trust basis. */
  spotDisagreementPct: number | null;
  /** How many independent spot sources answered. */
  spotSourceCount: number;
  /** Locally recorded time series — this app's own observations. */
  history: LocalHistoryPoint[];
  /** Hours of local history collected so far. */
  historyHours: number;
  updatedAt: number;
}

/** One recorded observation from this app's own polling. */
export interface LocalHistoryPoint {
  t: number;
  totalOpenInterestUsd: number;
  weightedFundingRatePct: number;
  price: number;
  longShortRatio: number | null;
  venueCount: number;
}

export interface FearGreed {
  value: number;
  classification: string;
  updatedAt: number;
}

export interface SentimentBand {
  min: number;
  max: number;
  label: string;
  description: string;
}

// ── Alerts ─────────────────────────────────────────────────────────────

export type AlertMetric =
  | "funding_above"
  | "funding_below"
  | "oi_change_above"
  | "funding_flips_positive"
  | "funding_flips_negative"
  | "price_flat_oi_rising"
  | "funding_oi_divergence";

export type AlertChannel = "browser" | "discord" | "telegram" | "email" | "sound";

export interface AlertRule {
  id: string;
  label: string;
  asset: AssetSymbol | "MARKET";
  metric: AlertMetric;
  threshold?: number;
  channels: AlertChannel[];
  enabled: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
}

export interface AlertFiring {
  ruleId: string;
  message: string;
  t: number;
}
