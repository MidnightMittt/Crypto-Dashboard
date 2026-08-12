/**
 * UNIVERSAL RESEARCH ENGINE — core contracts.
 *
 * The engine below must never learn which asset it is analysing. Every
 * instrument reaches it as bars plus metadata, and every capability beyond
 * plain OHLCV arrives through one extension mechanism rather than a
 * per-asset schema. See docs/RESEARCH_PLATFORM.md for the reasoning and for
 * the measured evidence that motivated it.
 *
 * Nothing here imports from src/lib outside this folder, and nothing in the
 * existing app imports from here yet. That isolation is deliberate: the
 * abstraction is proven against BTC/ETH before anything depends on it.
 */

// ── Time ────────────────────────────────────────────────────────────────

export type Timeframe = "1h" | "4h" | "1D" | "1W";

/** Nominal span of one bar. Used for window arithmetic, never for session logic — a "1D" equity bar spans 24h of clock but 6.5h of trading. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
};

// ── Bars ────────────────────────────────────────────────────────────────

/**
 * One OHLCV bar. The only price shape the engine understands.
 *
 * `t` is the bar's CLOSE timestamp, not its open. Every point-in-time guard
 * in this codebase compares a decision time against a bar's knowability, and
 * a bar is knowable at its close — labelling by open would make every such
 * comparison off by one bar in the unsafe direction.
 */
export interface Bar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Null where genuinely unavailable (spot FX has no consolidated volume) rather than zero, which would be a lie a volume filter could act on. */
  volume: number | null;
}

// ── Sessions ────────────────────────────────────────────────────────────

/**
 * How a series must be interpreted in time. This exists because the single
 * most dangerous assumption in the original engine was invisible: that
 * markets trade continuously.
 *
 * `gapsPossible` is not documentation — the execution engine branches on it.
 * A continuous market can be assumed to trade through every price between
 * two ticks, so a stop resting inside a bar's range fills at the stop. A
 * session market can leap over a stop overnight and fill at the next open,
 * which is materially worse and, if ignored, silently inflates every
 * backtest result.
 */
export interface SessionModel {
  kind: "continuous" | "session-based";
  gapsPossible: boolean;
  /** Trading periods per calendar year at daily resolution. Drives annualisation and percentile-baseline sizing. */
  barsPerYear: number;
  /** IANA zone the session is defined in. "UTC" for continuous markets. */
  timezone: string;
  label: string;
}

/** 24/7, no gaps — crypto. */
export const CONTINUOUS_SESSION: SessionModel = {
  kind: "continuous",
  gapsPossible: false,
  barsPerYear: 365,
  timezone: "UTC",
  label: "24/7 continuous",
};

/** US cash equities and equity ETFs: ~252 sessions, overnight and weekend gaps, opening auction. */
export const US_EQUITY_SESSION: SessionModel = {
  kind: "session-based",
  gapsPossible: true,
  barsPerYear: 252,
  timezone: "America/New_York",
  label: "US equity RTH",
};

/**
 * FX majors: continuously quoted Sunday 17:00 ET to Friday 17:00 ET.
 * Classified session-based rather than continuous because the weekend
 * closure produces real Sunday-open gaps, which is the property that
 * matters to execution — the intraweek continuity does not make those gaps
 * disappear.
 */
export const FX_SESSION: SessionModel = {
  kind: "session-based",
  gapsPossible: true,
  barsPerYear: 260,
  timezone: "UTC",
  label: "FX 24/5",
};

// ── Instruments ─────────────────────────────────────────────────────────

/**
 * Deliberately coarse. This exists only to carry DEFAULTS (session model,
 * cost model, typical volatility). It must never gate which evidence runs —
 * that is the capability system's job, and conflating the two is what makes
 * asset taxonomies rot. Style attributes like "growth"/"value" are
 * cross-sectional grouping labels, not classes, and do not belong here.
 */
export type AssetClass = "crypto" | "equity" | "equity-etf" | "index" | "bond" | "commodity" | "fx";

/** Whether a price series has been corrected for corporate actions. Unadjusted equity history silently corrupts every return computed from it, so this is required rather than optional. */
export type PriceAdjustment = "none" | "splits" | "splits-and-dividends";

export interface InstrumentMeta {
  /** Stable internal identifier. NEVER a bare exchange ticker: tickers are reused across delisted companies, which would silently splice two unrelated histories together. */
  id: string;
  displaySymbol: string;
  assetClass: AssetClass;
  sessionModel: SessionModel;
  adjustment: PriceAdjustment;
  /** First instant the instrument genuinely existed. Guards against providers back-filling synthetic history before inception. */
  inceptionT: number;
  /** Set when the instrument stopped trading. Retained deliberately: excluding dead instruments IS survivorship bias. */
  delistedT: number | null;
  quoteCurrency: string;
}

// ── Capabilities ────────────────────────────────────────────────────────

/**
 * Evidence families beyond OHLCV. A key present for an instrument means the
 * data source can serve that family for it; absent means it cannot, and any
 * module requiring it is skipped rather than special-cased.
 *
 * Deliberately a plain string union rather than a per-asset-class schema.
 * Adding "earnings" later touches this line and the module that needs it —
 * no asset class, and no engine code, has to change.
 */
export type CapabilityKey =
  // universal
  | "ohlcv"
  // crypto
  | "funding"
  | "openInterest"
  | "liquidations"
  | "onChainFlow"
  | "stablecoinSupply"
  // equity (not yet served — declared so modules can be written against them)
  | "earnings"
  | "sectorMembership"
  | "shortInterest"
  | "optionsFlow"
  // macro
  | "macroRates"
  | "economicReleases";

/**
 * Everything the research engine may read about a market. The sole entry
 * point — no module reaches around this to a provider.
 *
 * `bars(id, timeframe, until)` takes a cutoff rather than returning
 * everything and trusting callers to truncate. Point-in-time correctness
 * becomes the default rather than a discipline each caller must remember;
 * every look-ahead bug this project has hit came from a caller forgetting.
 */
export interface MarketDataSource {
  listInstruments(): InstrumentMeta[];
  meta(id: string): InstrumentMeta | null;
  /** Bars with close <= `until`, oldest first. Never returns a bar the caller could not have seen. */
  bars(id: string, timeframe: Timeframe, until: number): Bar[];
  hasCapability(id: string, key: CapabilityKey): boolean;
  /**
   * Point-in-time capability read. Returns null when unavailable, which is
   * indistinguishable-by-design from "instrument does not support this" —
   * callers must handle absence either way, so collapsing the two removes a
   * branch that could only ever be handled identically.
   */
  capability<T>(id: string, key: CapabilityKey, until: number): T | null;
}

// ── Modules ─────────────────────────────────────────────────────────────

/**
 * A `MarketDataSource` permanently bound to one decision instant.
 *
 * ── Why this type exists ────────────────────────────────────────────────
 *
 * `MarketDataSource.bars(id, timeframe, until)` takes the cutoff as an
 * ARGUMENT, which means any caller holding a source can pass `Infinity` and
 * read the entire future. Truncation was therefore a convention that
 * callers were trusted to honour — and convention has already failed once
 * on this project, which is why overlap correction had to be retrofitted.
 *
 * This interface removes the parameter. There is no `until` to pass, no
 * overload that accepts one, and no accessor exposing the underlying
 * source. A feature or module handed a `BoundedMarketView` cannot express
 * a request for future data — not "must not", but *cannot*. Look-ahead
 * becomes a type error rather than a code-review finding.
 */
export interface BoundedMarketView {
  /** The instant every read is bounded by. Readable for diagnostics; changing it is impossible. */
  readonly asOf: number;
  meta(id: string): InstrumentMeta | null;
  /** Bars with close <= the bound instant, oldest first. */
  bars(id: string, timeframe: Timeframe): Bar[];
  hasCapability(id: string, key: CapabilityKey): boolean;
  capability<T>(id: string, key: CapabilityKey): T | null;
}

/**
 * Binds a source to an instant, producing a view that cannot read past it.
 *
 * The returned object closes over `asOf` and never exposes it as a mutable
 * field or the source as a property, so there is no route back to the
 * unbounded API. This is the ONLY sanctioned way to hand market data to a
 * feature or evidence module.
 */
export function bindAsOf(source: MarketDataSource, asOf: number): BoundedMarketView {
  return {
    asOf,
    meta: (id) => source.meta(id),
    bars: (id, timeframe) => source.bars(id, timeframe, asOf),
    hasCapability: (id, key) => source.hasCapability(id, key),
    capability: <T,>(id: string, key: CapabilityKey) => source.capability<T>(id, key, asOf),
  };
}

/**
 * What a feature or module is handed.
 *
 * `source` is a BOUNDED view, not a raw `MarketDataSource`. That is the
 * structural guarantee: the context carries no API capable of requesting
 * data past `asOf`.
 */
export interface ResearchContext {
  instrument: InstrumentMeta;
  source: BoundedMarketView;
  /** The decision instant. Identical to `source.asOf`; kept for readability at call sites. */
  asOf: number;
}

/**
 * A unit of evidence. Declares its own requirements; the engine resolves
 * availability and skips it when unmet.
 *
 * This inversion is the point. Having each ASSET CLASS enumerate its modules
 * is O(classes x modules) to maintain and puts module knowledge inside the
 * asset taxonomy. Here, adding a module is a single new file, and graceful
 * degradation falls out of a filter instead of a switch.
 */
export interface EvidenceModule<TOut> {
  id: string;
  description: string;
  requires: CapabilityKey[];
  /** Returns null when the module ran but reached no conclusion — distinct from being skipped for missing data, which the runner records separately. */
  compute(ctx: ResearchContext): TOut | null;
}

export interface ModuleOutcome<TOut> {
  moduleId: string;
  status: "ok" | "skipped-missing-capability" | "no-conclusion" | "errored";
  value: TOut | null;
  /** Which requirements were absent, when skipped. Reported rather than swallowed so a silently-empty study is impossible to mistake for a negative result. */
  missing: CapabilityKey[];
  error?: string;
}

/**
 * Runs every module whose requirements the instrument satisfies.
 *
 * Errors are caught per module and recorded rather than thrown. One broken
 * module must not void an entire research run, and an errored module must
 * never be indistinguishable from one that legitimately had nothing to say.
 */
export function runModules<TOut>(
  modules: EvidenceModule<TOut>[],
  ctx: ResearchContext
): ModuleOutcome<TOut>[] {
  return modules.map((m) => {
    const missing = m.requires.filter((k) => !ctx.source.hasCapability(ctx.instrument.id, k));
    if (missing.length > 0) {
      return { moduleId: m.id, status: "skipped-missing-capability" as const, value: null, missing };
    }
    try {
      const value = m.compute(ctx);
      return {
        moduleId: m.id,
        status: value === null ? ("no-conclusion" as const) : ("ok" as const),
        value,
        missing: [],
      };
    } catch (err) {
      return {
        moduleId: m.id,
        status: "errored" as const,
        value: null,
        missing: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
