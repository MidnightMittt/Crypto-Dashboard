import { CapabilityKey, InstrumentMeta, CONTINUOUS_SESSION, US_EQUITY_SESSION, FX_SESSION } from "./types";

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

/** Common metadata for a US-listed exchange-traded product. Factored out so a new fund is one line rather than twelve. */
/**
 * An intelligence-layer US listing — industry ETF proxy or constituent.
 *
 * DELIBERATELY NOT ADDED TO `UNIVERSE`. That list is the RESEARCH universe:
 * every member is a candidate for backtests and correlation studies, and its
 * composition is an evidence decision documented in this file. The industry
 * layer needs price series for eighty-odd names to measure relative strength,
 * which is a different job — none of them are backtested, none enter a
 * replay, and dropping them into the research universe would silently change
 * what "the universe" means in every study that reads it.
 *
 * Inception is declared as a FLOOR rather than a precise listing date, and
 * the floor is deliberately generous. The validator asserts only that no bar
 * precedes the declaration; 1962 predates every daily series this provider
 * serves, so it is an honest "listed at or after the start of the record".
 *
 * A tighter guess was tried first and the validator refused it — several of
 * these names list in the 1970s. That refusal was correct, and the fix is a
 * declaration that claims less, never a looser check.
 */
export function usListing(symbol: string, name: string): InstrumentConfig {
  return usEtf({ symbol, name, inception: "1962-01-01T00:00:00Z" });
}

function usEtf(opts: {
  symbol: string;
  name: string;
  inception: string;
  delisted?: string;
  /** Defaults to equity-etf; bond and commodity funds declare their own so correlation grouping is meaningful. */
  assetClass?: InstrumentMeta["assetClass"];
}): InstrumentConfig {
  return {
    meta: {
      // Stable internal id, deliberately NOT the bare ticker: tickers are
      // recycled across delisted companies, and keying on one would
      // eventually splice two unrelated histories together.
      id: `${opts.symbol}.US`,
      displaySymbol: opts.symbol,
      assetClass: opts.assetClass ?? "equity-etf",
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

/**
 * Spot FX major. Yahoo quotes these as `EURUSD=X`.
 *
 * Classified session-based rather than continuous: FX is quoted around the
 * clock on weekdays but closes for the weekend, and it is the weekend gap —
 * not the intraweek continuity — that execution has to model.
 */
function fxPair(opts: { pair: string; inception: string }): InstrumentConfig {
  return {
    meta: {
      id: `${opts.pair}.FX`,
      displaySymbol: opts.pair,
      assetClass: "fx",
      sessionModel: FX_SESSION,
      // A currency pair has no corporate actions to adjust for. "none" is
      // accurate here rather than a missing declaration.
      adjustment: "none",
      inceptionT: Date.parse(opts.inception),
      delistedT: null,
      quoteCurrency: opts.pair.slice(3),
    },
    source: { provider: "yahoo", symbol: `${opts.pair}=X` },
    capabilities: ["ohlcv"],
  };
}

/** Crypto spot, quoted by Yahoo. Distinct instruments from the OKX perpetuals, and deliberately given distinct ids. */
function cryptoSpot(opts: { symbol: string; inception: string }): InstrumentConfig {
  return {
    meta: {
      id: `${opts.symbol}-USD.SPOT`,
      displaySymbol: opts.symbol,
      assetClass: "crypto",
      sessionModel: CONTINUOUS_SESSION,
      adjustment: "none",
      inceptionT: Date.parse(opts.inception),
      delistedT: null,
      quoteCurrency: "USD",
    },
    source: { provider: "yahoo", symbol: `${opts.symbol}-USD` },
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
  // ── Existing crypto perpetuals (production dashboard) ────────────────
  cryptoPerp({ symbol: "BTC", inception: "2019-01-01T00:00:00Z" }),
  cryptoPerp({ symbol: "ETH", inception: "2019-01-01T00:00:00Z" }),

  // ── 1. Major US indices ──────────────────────────────────────────────
  usEtf({ symbol: "SPY", name: "SPDR S&P 500", inception: "1993-01-22T00:00:00Z" }),
  usEtf({ symbol: "QQQ", name: "Invesco QQQ", inception: "1999-03-10T00:00:00Z" }),
  usEtf({ symbol: "DIA", name: "SPDR Dow Jones Industrial Average", inception: "1998-01-14T00:00:00Z" }),
  usEtf({ symbol: "IWM", name: "iShares Russell 2000", inception: "2000-05-22T00:00:00Z" }),
  usEtf({ symbol: "VTI", name: "Vanguard Total Stock Market", inception: "2001-05-24T00:00:00Z" }),

  // ── 2. US Treasuries ─────────────────────────────────────────────────
  // The genuine diversifiers: duration risk is a different factor from
  // equity beta, and frequently anti-correlated with it.
  usEtf({ symbol: "TLT", name: "iShares 20+ Year Treasury", inception: "2002-07-22T00:00:00Z", assetClass: "bond" }),
  usEtf({ symbol: "IEF", name: "iShares 7-10 Year Treasury", inception: "2002-07-22T00:00:00Z", assetClass: "bond" }),
  usEtf({ symbol: "SHY", name: "iShares 1-3 Year Treasury", inception: "2002-07-22T00:00:00Z", assetClass: "bond" }),
  usEtf({ symbol: "TIP", name: "iShares TIPS Bond", inception: "2003-12-04T00:00:00Z", assetClass: "bond" }),

  // ── 3. Corporate credit ──────────────────────────────────────────────
  usEtf({ symbol: "LQD", name: "iShares Investment Grade Corporate", inception: "2002-07-22T00:00:00Z", assetClass: "bond" }),
  usEtf({ symbol: "HYG", name: "iShares High Yield Corporate", inception: "2007-04-04T00:00:00Z", assetClass: "bond" }),

  // ── 4. Commodities ───────────────────────────────────────────────────
  usEtf({ symbol: "GLD", name: "SPDR Gold Shares", inception: "2004-11-18T00:00:00Z", assetClass: "commodity" }),
  usEtf({ symbol: "SLV", name: "iShares Silver Trust", inception: "2006-04-21T00:00:00Z", assetClass: "commodity" }),
  usEtf({ symbol: "USO", name: "United States Oil Fund", inception: "2006-04-10T00:00:00Z", assetClass: "commodity" }),
  usEtf({ symbol: "DBA", name: "Invesco DB Agriculture", inception: "2007-01-05T00:00:00Z", assetClass: "commodity" }),

  // ── 5. FX majors ─────────────────────────────────────────────────────
  fxPair({ pair: "EURUSD", inception: "2003-12-01T00:00:00Z" }),
  fxPair({ pair: "USDJPY", inception: "2003-12-01T00:00:00Z" }),
  fxPair({ pair: "GBPUSD", inception: "2003-12-01T00:00:00Z" }),
  fxPair({ pair: "AUDUSD", inception: "2003-12-01T00:00:00Z" }),
  fxPair({ pair: "USDCAD", inception: "2003-12-01T00:00:00Z" }),
  fxPair({ pair: "USDCHF", inception: "2003-12-01T00:00:00Z" }),

  // ── 6. Crypto spot ───────────────────────────────────────────────────
  cryptoSpot({ symbol: "SOL", inception: "2020-04-10T00:00:00Z" }),
  cryptoSpot({ symbol: "BNB", inception: "2017-07-25T00:00:00Z" }),
  cryptoSpot({ symbol: "XRP", inception: "2014-08-04T00:00:00Z" }),

  /* ── Sector funds ───────────────────────────────────────────────────
   *
   * These were previously withheld, on the finding that five index ETFs
   * already measured at 1.17x the effective sample of one — more US equity
   * beta buys almost no independent evidence. That finding stands and is
   * not being reversed.
   *
   * It answers a different question from the one these serve. It is about
   * STATISTICAL POWER: how many independent observations a backtest has.
   * Rotation is about DISPERSION: which sectors are outperforming the index
   * and each other. The common market factor that makes them redundant as
   * extra samples is exactly the thing that cancels when you measure one
   * against another, and what is left over IS the rotation signal.
   *
   * So: still worth nothing as additional evidence for a market-direction
   * backtest, and load-bearing for measuring where capital is going. Both
   * are true, and neither is a reason to disturb the other. Nothing here is
   * added to any backtest replay.
   */
  usEtf({ symbol: "XLF", name: "Financial Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLK", name: "Technology Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLV", name: "Health Care Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLI", name: "Industrial Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLY", name: "Consumer Discretionary Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLP", name: "Consumer Staples Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLE", name: "Energy Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLU", name: "Utilities Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLB", name: "Materials Select Sector SPDR", inception: "1998-12-16T00:00:00Z" }),
  usEtf({ symbol: "XLRE", name: "Real Estate Select Sector SPDR", inception: "2015-10-08T00:00:00Z" }),
  usEtf({ symbol: "XLC", name: "Communication Services Select Sector SPDR", inception: "2018-06-19T00:00:00Z" }),
  /* First bar the provider actually serves is 2000-06-05 (the pre-VanEck
     HOLDRS lineage), not the 2011 VanEck relaunch. Declared to match the
     data rather than the fund history — the validator refused the mismatch,
     correctly. */
  usEtf({ symbol: "SMH", name: "Semiconductors", inception: "2000-06-05T00:00:00Z" }),
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
    // Only exchange-traded EQUITY products have corporate actions. FX pairs
    // and crypto genuinely have nothing to adjust for, so "none" is accurate
    // there rather than a missing declaration.
    const needsAdjustment = c.meta.assetClass === "equity" || c.meta.assetClass === "equity-etf" ||
      c.meta.assetClass === "bond" || c.meta.assetClass === "commodity" || c.meta.assetClass === "index";
    if (needsAdjustment && c.meta.adjustment === "none") {
      problems.push(`${c.meta.id}: an exchange-traded fund declaring adjustment "none" is almost certainly wrong — unadjusted prices corrupt returns through distributions and splits.`);
    }
  }
  return problems;
}
