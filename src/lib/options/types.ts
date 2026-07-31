/**
 * Options Intelligence Engine — core provider interfaces.
 *
 * Phase 0 scaffolding: interfaces and shared types only, no implementations
 * yet. Mirrors this app's existing "adapter interface, swappable
 * implementation" pattern — see exchanges/adapters/types.ts's LiveAdapter and
 * providers/types.ts's MarketDataProvider — so an account provider backed by
 * an unofficial Robinhood client can be swapped for manual entry, and a
 * Tradier-backed options-data provider can be swapped for Polygon/Finnhub/
 * etc., without touching anything downstream that calls them.
 *
 * This module is entirely separate from the crypto dashboard's types in
 * types/market.ts — no shared types, no shared state. The two domains never
 * couple.
 */

export interface WatchlistSymbol {
  symbol: string;
  name?: string;
}

export interface EquityPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface OptionsPosition {
  /** Underlying symbol. */
  symbol: string;
  optionType: "call" | "put";
  strike: number;
  /** ISO date. */
  expiration: string;
  /** Positive = long, negative = short. */
  quantity: number;
  averageCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface AccountSnapshot {
  watchlist: WatchlistSymbol[];
  equityPositions: EquityPosition[];
  optionsPositions: OptionsPosition[];
  buyingPower: number;
  accountValue: number;
  updatedAt: number;
  /**
   * Which implementation produced this. Surfaced in the UI so a
   * manual-entry fallback is never mistaken for a live account sync — the
   * same "never let a degraded source look like the real thing" rule this
   * app already applies to spot-price fallback chains and provider-sourced
   * exchange snapshots.
   */
  source: "robinhood" | "manual";
}

/**
 * Account/positions/watchlist provider.
 *
 * A Robinhood-backed implementation (via an unofficial client — see
 * scripts/check-robinhood.mjs) is the primary target, but this interface is
 * exactly why that can be swapped for manual entry if the unofficial client
 * turns out to be unreliable — device-verification challenges that can't be
 * automated, a breaking change in Robinhood's private API, or ToS
 * enforcement — without touching any downstream code.
 */
export interface AccountProvider {
  id: string;
  getSnapshot(): Promise<AccountSnapshot | null>;
}

// ── Options market data ─────────────────────────────────────────────────

export interface OptionQuote {
  /** Underlying symbol. */
  symbol: string;
  optionType: "call" | "put";
  strike: number;
  /** ISO date. */
  expiration: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  /**
   * Greeks are `null`, never a guess, when the provider doesn't publish
   * them for a given contract (e.g. thin/illiquid strikes) — same
   * null-means-not-published convention used throughout the crypto side of
   * this app.
   */
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
}

export interface OptionsChain {
  symbol: string;
  underlyingPrice: number;
  /** ISO dates, ascending. */
  expirations: string[];
  quotes: OptionQuote[];
  updatedAt: number;
}

/**
 * Market-data provider for options chains. Tradier is the v1 implementation
 * (see the phased plan); Polygon/Finnhub/CBOE/etc. implement this same
 * interface later without changing any caller.
 */
export interface OptionsDataProvider {
  id: string;
  isConfigured(): boolean;
  getChain(symbol: string): Promise<OptionsChain | null>;
}
