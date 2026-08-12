import { CapabilityKey, InstrumentMeta, CONTINUOUS_SESSION, US_EQUITY_SESSION } from "./types";

/**
 * THE INSTRUMENT UNIVERSE — configuration, not implementation.
 *
 * Adding a market must never require an engine change. An instrument is
 * fully described by three things:
 *
 *   1. `meta`        — what it is (asset class, session, currency, listing window)
 *   2. `source`      — where its bars come from (provider id + that provider's symbol)
 *   3. `capabilities`— which evidence families it can serve beyond OHLCV
 *
 * Everything downstream — validation, feature extraction, session keying,
 * the panel estimator, grading — reads only those. There is no switch on
 * ticker anywhere in the platform, and adding SPY required no change to any
 * of it.
 *
 * ── Designed for delisted instruments, which do not exist yet ───────────
 *
 * `delistedT` is present and honoured by validation from day one, even
 * though every instrument below is live. Survivorship bias is the single
 * largest remaining correctness risk in this platform, and it is introduced
 * by the UNIVERSE, not by the estimator — a study run on "the ETFs that
 * exist today" silently conditions on having survived, and no statistical
 * machinery can detect that.
 *
 * Building the field in now means adding a dead instrument later is a
 * configuration entry rather than a schema migration, and the listing-window
 * validation that guards it is already written and tested.
 */

/** Identifies which fetcher supplies an instrument's bars. Kept a plain string so a new provider is a new ingest script, not a type change. */
export type ProviderId = "okx" | "yahoo";

export interface InstrumentConfig {
  meta: InstrumentMeta;
  source: {
    provider: ProviderId;
    /** The provider's own symbol, which frequently differs from our stable id. */
    symbol: string;
  };
  /**
   * Evidence families this instrument can serve. `ohlcv` is universal;
   * everything else is declared explicitly so a module requiring an absent
   * capability is SKIPPED rather than silently handed a default.
   */
  capabilities: CapabilityKey[];
}

/** Common metadata for a US-listed ETF. Factored out so a new ETF is one line rather than twelve. */
function usEtf(opts: {
  symbol: string;
  name: string;
  inception: string;
  delisted?: string;
}): InstrumentConfig {
  return {
    meta: {
      // Stable internal id, deliberately NOT the bare ticker: tickers are
      // recycled across delisted companies, and keying on one would
      // eventually splice two unrelated histories together.
      id: `${opts.symbol}.US`,
      displaySymbol: opts.symbol,
      assetClass: "equity-etf",
      sessionModel: US_EQUITY_SESSION,
      // Yahoo's adjusted close accounts for splits and distributions. An
      // unadjusted ETF series would silently corrupt every return computed
      // from it, so the declaration is required rather than assumed.
      adjustment: "splits-and-dividends",
      inceptionT: Date.parse(opts.inception),
      delistedT: opts.delisted ? Date.parse(opts.delisted) : null,
      quoteCurrency: "USD",
    },
    source: { provider: "yahoo", symbol: opts.symbol },
    capabilities: ["ohlcv"],
  };
}

/** Crypto perpetual, for the instruments already in the platform. */
function cryptoPerp(opts: { symbol: string; inception: string }): InstrumentConfig {
  return {
    meta: {
      id: `${opts.symbol}-USD-PERP`,
      displaySymbol: opts.symbol,
      assetClass: "crypto",
      sessionModel: CONTINUOUS_SESSION,
      adjustment: "none",
      inceptionT: Date.parse(opts.inception),
      delistedT: null,
      quoteCurrency: "USD",
    },
    source: { provider: "okx", symbol: `${opts.symbol}-USDT-SWAP` },
    capabilities: ["ohlcv", "funding", "openInterest"],
  };
}

/**
 * The registered universe.
 *
 * Five ETFs, chosen to prove the architecture rather than to maximise
 * statistical power: four broad indices with near-identical schedules plus
 * one sector fund. They share a session model, so any bug in session keying
 * shows up as a collision rather than hiding; and they are heavily
 * correlated, so the panel estimator's cross-sectional discount should be
 * clearly visible when it runs on them.
 *
 * Deliberately NOT expanded further until this foundation is validated.
 */
export const UNIVERSE: InstrumentConfig[] = [
  cryptoPerp({ symbol: "BTC", inception: "2019-01-01T00:00:00Z" }),
  cryptoPerp({ symbol: "ETH", inception: "2019-01-01T00:00:00Z" }),

  usEtf({ symbol: "SPY", name: "SPDR S&P 500", inception: "1993-01-22T00:00:00Z" }),
  usEtf({ symbol: "QQQ", name: "Invesco QQQ", inception: "1999-03-10T00:00:00Z" }),
  usEtf({ symbol: "DIA", name: "SPDR Dow Jones Industrial Average", inception: "1998-01-14T00:00:00Z" }),
  usEtf({ symbol: "IWM", name: "iShares Russell 2000", inception: "2000-05-22T00:00:00Z" }),
  usEtf({ symbol: "XLF", name: "Financial Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
];

export function findInstrument(id: string): InstrumentConfig | null {
  return UNIVERSE.find((c) => c.meta.id === id) ?? null;
}

export function instrumentsByProvider(provider: ProviderId): InstrumentConfig[] {
  return UNIVERSE.filter((c) => c.source.provider === provider);
}

/** Instruments tradeable at an instant, honouring both ends of the listing window. The delisting half is unexercised today and deliberately present. */
export function liveAt(t: number): InstrumentConfig[] {
  return UNIVERSE.filter((c) => t >= c.meta.inceptionT && (c.meta.delistedT === null || t <= c.meta.delistedT));
}

/**
 * Structural checks on the registry itself, run as a test rather than at
 * import time so a malformed entry fails the build rather than the app.
 */
export function validateUniverse(configs: InstrumentConfig[] = UNIVERSE): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of configs) {
    if (ids.has(c.meta.id)) problems.push(`Duplicate instrument id "${c.meta.id}".`);
    ids.add(c.meta.id);
    if (!Number.isFinite(c.meta.inceptionT)) problems.push(`${c.meta.id}: inceptionT is not a valid date.`);
    if (c.meta.delistedT !== null && c.meta.delistedT <= c.meta.inceptionT) {
      problems.push(`${c.meta.id}: delistedT is not after inceptionT.`);
    }
    if (!c.capabilities.includes("ohlcv")) problems.push(`${c.meta.id}: every instrument must declare "ohlcv".`);
    if (c.meta.assetClass !== "crypto" && c.meta.adjustment === "none") {
      problems.push(`${c.meta.id}: a non-crypto instrument declaring adjustment "none" is almost certainly wrong — unadjusted equity prices corrupt returns.`);
    }
  }
  return problems;
}
