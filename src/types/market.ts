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
  /**
   * Net positioning at peer-to-pool venues. Null when none reported.
   *
   * Deliberately separate from `longShortRatio`. That field is an ACCOUNT
   * ratio — how many traders sit on each side — which is the only positioning
   * an order book can meaningfully publish, since its notional is balanced by
   * construction. This one is NOTIONAL: at a peer-to-pool venue the pool
   * takes the other side, so dollars long and dollars short genuinely differ.
   *
   * The two answer different questions and must never be averaged.
   */
  poolExposure: PoolExposureSummary | null;
  /**
   * Percentile rank of current funding against the trailing recorded window.
   *
   * Available more often than `oiPercentile`: funding is an OI-weighted
   * average so coverage changes barely move it, whereas total open interest is
   * a sum that shifts whenever the venue set does.
   */
  fundingPercentile: number | null;
  /** How much venues disagree on the cost of leverage. Null with under 2 venues. */
  fundingDivergence: FundingDivergence | null;
  /** Positioning split by venue type. Null unless both CEX and DEX reported. */
  cexDex: CexDexSplit | null;
  /** How primed the market is for a forced unwind, and on which side. */
  squeezeRisk: SqueezeRisk | null;
  /**
   * Observed forced-close volume over the trailing window. Null unless
   * Coinalyze is configured — this is the only source in this app that
   * publishes actual liquidation data, as opposed to `squeezeRisk`, which is
   * a forward-looking heuristic about conditions that PRECEDE a squeeze.
   * This is a record of unwinds that have ALREADY happened.
   */
  liquidations: LiquidationSummary | null;
  /**
   * Order-book depth and aggressive buy/sell flow, OKX only. Null unless
   * OKX responds for this asset. This is a genuinely different signal from
   * `longShortRatio` (resting account positions) and `liquidations` (forced
   * closes): book imbalance describes standing orders, and flow describes
   * aggressive taker volume that just executed — neither is a position.
   */
  orderFlow: OrderFlowSummary | null;
  /**
   * Net movement of coins into or out of a small set of known, verified
   * exchange wallets. Only ever populated for BTC and ETH — see
   * ExchangeFlowSummary for why this can't extend to the other 8 assets, and
   * why it's a partial signal rather than a comprehensive netflow figure.
   */
  exchangeFlow: ExchangeFlowSummary | null;
  /**
   * Whether the balance fetcher for THIS asset is actually configured —
   * true for BTC always (keyless), true for ETH only when ETHERSCAN_API_KEY
   * is set. Exists so the UI can tell "no key" apart from "still building
   * history" instead of hedging between both in one message — the ambiguity
   * that message caused genuine confusion the first time this shipped.
   * Meaningless (false) for every non-BTC/ETH asset.
   */
  exchangeFlowConfigured: boolean;
  /**
   * Crypto OPTIONS positioning from Deribit — the dominant venue for BTC/ETH
   * options by a wide margin. Genuinely different from everything else on
   * this dashboard, which is entirely perpetual futures: put/call ratio and
   * max pain describe options-market structure, not perp positioning, and
   * must not be read as another flavor of longShortRatio or squeezeRisk.
   * Only ever populated for BTC and ETH — Deribit doesn't list options on
   * the other 8 assets.
   */
  deribitOptions: DeribitOptionsSummary | null;
  /** Locally recorded time series — this app's own observations. */
  history: LocalHistoryPoint[];
  /** Hours of local history collected so far. */
  historyHours: number;
  updatedAt: number;
}

/** One time bucket of forced-close volume, summed across contributing venues. */
export interface LiquidationBucket {
  t: number; // unix ms, start of the bucket
  longUsd: number;
  shortUsd: number;
}

/**
 * Observed long vs short liquidation volume over a trailing window.
 *
 * "dominantSide" describes what ALREADY HAPPENED, not what's coming next —
 * "long" means longs got forced out more (a downside flush), which is
 * backward-looking market history, not a prediction. Pair it with
 * `squeezeRisk` (forward-looking: how primed the market is for the NEXT
 * unwind) rather than conflating the two.
 */
export interface LiquidationSummary {
  /** Oldest first. */
  history: LiquidationBucket[];
  totalLongUsd: number;
  totalShortUsd: number;
  dominantSide: "long" | "short" | "balanced";
  /** Longs' share of total liquidation volume, 0-100. */
  longSharePct: number;
  /** Venue ids behind the figure, so the UI can name its sources. */
  venues: string[];
  windowHours: number;
}

/** Resting order-book depth, one side. */
export interface OrderBookSide {
  usd: number;
}

/**
 * Top-of-book depth summed to a fixed number of price levels per side.
 * Positive imbalancePct means more resting buy-side depth than sell-side.
 *
 * This describes STANDING orders waiting to be filled, not trades that
 * already happened — the opposite tense from `cvdHistory` below, which is
 * built from executed taker volume.
 */
export interface OrderBookImbalance {
  bid: OrderBookSide;
  ask: OrderBookSide;
  /** (bid.usd - ask.usd) / (bid.usd + ask.usd) * 100. */
  imbalancePct: number;
  /** Price levels summed per side. */
  depthLevels: number;
}

/** One hourly bucket's aggressive buy/sell volume and running cumulative delta. */
export interface CvdPoint {
  t: number;
  buyUsd: number;
  sellUsd: number;
  /** Running (buy - sell) total from the start of the window through this point. */
  cumulativeUsd: number;
}

/**
 * Order-book depth and aggressive taker flow, OKX only.
 *
 * `cvdHistory` is a genuine cumulative volume delta — the direction and
 * math are the same as a tick-level CVD chart — but it is built from
 * OKX's HOURLY pre-aggregated taker volume, not individual trades, because
 * this app is serverless and cannot hold the persistent connection a tick
 * feed would need. It cannot see structure inside an hour the way a live
 * order-flow terminal can. Treat it as a coarse, honest proxy, not a
 * replacement for one.
 */
export interface OrderFlowSummary {
  bookImbalance: OrderBookImbalance | null;
  /** Oldest first. */
  cvdHistory: CvdPoint[];
  totalBuyUsd: number;
  totalSellUsd: number;
  dominantFlow: "buyers" | "sellers" | "balanced";
  /** Buyers' share of total taker volume, 0-100. */
  buyerSharePct: number;
  windowHours: number;
  venue: string;
}

/**
 * Net flow of coins into or out of a small, hand-verified set of known
 * major-exchange wallet addresses — currently just Binance's largest BTC and
 * ETH wallets. See providers/exchangeFlows/addresses.ts for how each address
 * was confirmed and why the list is short.
 *
 * This is NOT the comprehensive exchange netflow that CryptoQuant or
 * Glassnode publish — those are built from thousands of labeled addresses
 * behind a paid API this app doesn't have. This tracks a small, real,
 * currently-active sample and will undercount total flow by a wide margin.
 * Read it as "what a few of the biggest known wallets did", not "what every
 * exchange did" — directionally informative, not a total.
 *
 * Computed as a balance delta (now vs. `windowHours` ago), not from
 * individual transactions, which is why only a single net figure exists —
 * splitting it into separate inflow/outflow totals would imply per-
 * transaction granularity this approach doesn't have.
 *
 * Positive netflow = tracked balances grew (coins moving toward exchanges,
 * historically read as latent sell pressure). Negative = tracked balances
 * shrank (moving to self-custody, read as accumulation).
 */
export interface ExchangeFlowSummary {
  asset: "BTC" | "ETH";
  netflowUsd: number;
  /** Same figure in the native unit (BTC or ETH), often the more readable one. */
  netflowNative: number;
  currentBalanceUsd: number;
  windowHours: number;
  direction: "inflow" | "outflow" | "balanced";
  /** Exchange names behind the tracked addresses, e.g. ["Binance"]. */
  venues: string[];
  trackedAddressCount: number;
}

/**
 * BTC/ETH options positioning, sourced entirely from Deribit — options
 * market share there is large enough that other venues (OKX, Bybit,
 * Delta Exchange) don't move these figures meaningfully, so this isn't
 * cross-venue aggregated the way funding/OI are.
 *
 * `putCallRatio` and `maxPain` are both computed for ONE specific expiry
 * (`expiry`, the nearest one with enough open interest to be meaningful),
 * not blended across every listed expiry — max pain in particular is only a
 * coherent concept for a single settlement date. `totalOpenInterestUsd` is
 * the only field that aggregates across all expiries.
 */
export interface DeribitOptionsSummary {
  asset: "BTC" | "ETH";
  /** ISO date the ratio/max-pain figures below are computed for. */
  expiry: string;
  /** Put open interest / call open interest, for `expiry` only. */
  putCallRatio: number;
  /**
   * The strike where option writers collectively lose the least (and,
   * mechanically, the largest cluster of option buyers would be furthest
   * from profitable) if the underlying settled there at `expiry`. A
   * heuristic about where OI clusters, not a prediction — see the
   * narration this feeds for the standard caveat about reading too much
   * directional intent into it.
   */
  maxPain: number;
  /** At-the-money implied vol for `expiry`, annualized percentage. */
  atmIvPct: number | null;
  /** Open interest across every listed expiry, in contracts (1 = 1 BTC or 1 ETH notional). */
  totalOpenInterestContracts: number;
  totalOpenInterestUsd: number;
  updatedAt: number;
}

/** Notional long/short exposure aggregated across peer-to-pool venues. */
export interface PoolExposureSummary {
  longUsd: number;
  shortUsd: number;
  /**
   * (long - short) / (long + short) * 100. Positive means the traders are
   * net long, which is the same as saying the pool is net short.
   */
  netSkewPct: number;
  /** Venue ids behind the figure, so the UI can name its sources. */
  venues: string[];
}

/** Cross-venue disagreement on funding, all figures per-8h normalized. */
export interface FundingDivergence {
  /** OI-weighted standard deviation across venues, in bps. */
  dispersionBps: number;
  /** Widest gap between any two venues, in bps. */
  spreadBps: number;
  highestVenue: { id: string; name: string; bps: number };
  lowestVenue: { id: string; name: string; bps: number };
  venueCount: number;
}

/** One side of the CEX/DEX comparison. */
export interface VenueSegment {
  openInterestUsd: number;
  /** OI-weighted per-8h funding for this segment, in bps. */
  fundingBps: number;
  venueCount: number;
}

export interface CexDexSplit {
  cex: VenueSegment;
  dex: VenueSegment;
  /** CEX share of combined open interest, 0-100. */
  cexOiSharePct: number;
  /** DEX funding minus CEX funding, in bps. Positive = on-chain longs pay more. */
  fundingGapBps: number;
}

/** One auditable input to the squeeze score. */
export interface SqueezeComponent {
  label: string;
  /** 0-100 contribution before weighting. */
  score: number;
  weight: number;
  /** Plain-language statement of what this input observed. */
  detail: string;
}

export interface SqueezeRisk {
  /**
   * 0-100 heuristic score — NOT a probability.
   *
   * A weighted ranking of conditions that have historically preceded
   * liquidation cascades. It has never been calibrated against outcomes, so 72
   * means "more of the setup is present than at 50", not "72% chance".
   * Labelling it a probability would imply a backtest that does not exist.
   */
  score: number;
  /** Which side is exposed if positioning unwinds. */
  side: "long" | "short" | "balanced";
  /** Every input, so the score can be audited rather than trusted. */
  components: SqueezeComponent[];
}

/** One recorded observation from this app's own polling. */
export interface LocalHistoryPoint {
  t: number;
  totalOpenInterestUsd: number;
  weightedFundingRatePct: number;
  price: number;
  longShortRatio: number | null;
  venueCount: number;
  /**
   * Recorded so the OI and Leverage Heat gauges can show their own trail.
   *
   * Both are DERIVED scores, not raw observations — a percentile rank and a
   * weighted composite. Neither can be recomputed after the fact from the
   * other fields here, because each depends on the full trailing window and
   * the venue set as it was at the time. If they aren't stored when computed,
   * their history is unrecoverable.
   *
   * Optional because points recorded before this existed don't have them.
   */
  oiPercentile?: number | null;
  leverageHeatScore?: number | null;
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
