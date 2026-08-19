/**
 * THE DECLARED EQUITY PANEL — what "the panel" actually means.
 *
 * Cross-sectional research here ranks instruments against each other, and
 * every such claim is only as good as the answer to "against WHAT". Until
 * this file existed the answer was "whatever is in scripts/ingest/data",
 * which is the daily REFRESH SCOPE — a directory that accumulated whatever
 * any feature needed. It contained four crypto pairs, six bond funds, four
 * commodity funds, five broad index ETFs and twenty-five sector and thematic
 * ETFs alongside the operating companies.
 *
 * The consequence shipped: a page reading "cross-sectional momentum ·
 * 128-name panel" was ranking TLT and BTC-USD against NVDA, and WGMI — a
 * bitcoin-miner ETF — sat inside the long decile it displayed. Bitcoin also
 * trades 365 days a year, so its calendar inflated the period count for
 * every hypothesis in the family.
 *
 * ── The inclusion rule ────────────────────────────────────────────────
 *
 * A member is a US-LISTED OPERATING COMPANY: a firm with a business, whose
 * share price is a claim on that business. Excluded by KIND:
 *
 *   - Funds. An ETF is a basket of the panel, not a member of it. Including
 *     one both double-counts its holdings and dilutes the cross-section,
 *     because a diversified basket cannot occupy a tail of a ranking built
 *     to find single-name dispersion.
 *   - Non-equities. Crypto pairs, bonds and commodities are different asset
 *     classes on different calendars. Ranking them against equities is the
 *     category error that produced "bullish 96" gold reads before
 *     cross-asset instruments were removed from the equity snapshot.
 *
 * ── The honest caveat about WHEN this was declared ────────────────────
 *
 * This was written AFTER cross-sectional momentum was measured and found to
 * work, which is exactly the sequence that lets a panel be tuned into a
 * result. Three things bound that risk, and they are stated rather than
 * assumed:
 *
 *   1. The rule is about INSTRUMENT KIND, not returns. Whether TLT is a
 *      bond fund is checkable by anyone and cannot depend on how TLT did.
 *      This is the same reasoning that makes `excludeCorruptSeries` a
 *      statement about data rather than look-ahead.
 *   2. The change is applied to the WHOLE declared family at once, and the
 *      delta is published for every hypothesis including the ones it hurts.
 *   3. If momentum weakens or dies here, it ships weakened or dead. A panel
 *      declaration that could only ever help would not be a declaration.
 *
 * ── Membership is not a quality judgement ─────────────────────────────
 *
 * These 95 are the operating companies this platform happens to ingest, not
 * a considered universe. They skew large-cap, US-listed and — because the
 * list was assembled feature by feature — toward semiconductors, miners and
 * homebuilders. That tilt is a real limit on every cross-sectional claim
 * made from it, and it is why survivorship runs AGAINST those claims: names
 * that failed were never added.
 */

/**
 * US-listed operating companies. Foreign-domiciled issuers with US listings
 * (ASML, TSM, the gold and copper miners) are in: they are operating
 * businesses whose shares trade here, which is what the rule asks.
 */
export const EQUITY_PANEL: readonly string[] = [
  "ABT", "ADBE", "AEM", "AEP", "AMAT", "AMD", "AMGN", "ASML", "AU", "AVGO",
  "BA", "BIIB", "BKR", "BLK", "BSX", "BTDR", "CEG", "CFG", "CIFR", "CME",
  "COST", "CRM", "CSX", "D", "DHI", "DHR", "DUK", "FCX", "FDX", "FITB",
  "FTI", "GD", "GILD", "GOLD", "GS", "HAL", "HBAN", "HD", "HUT", "ICE",
  "INTC", "IREN", "ISRG", "KEY", "KGC", "KLAC", "LEN", "LHX", "LMT", "LOW",
  "LRCX", "LULU", "MARA", "MDT", "MS", "MSFT", "MTB", "MU", "NEE", "NEM",
  "NOC", "NOW", "NSC", "NVDA", "NVR", "ODFL", "ORCL", "PANW", "PHM", "PLTR",
  "QCOM", "REGN", "RF", "ROST", "RTX", "SCCO", "SCHW", "SLB", "SNOW", "SO",
  "SYK", "TECK", "TFC", "TGT", "TJX", "TSM", "TXN", "UNP", "UPS", "USB",
  "VRTX", "VST", "WMT", "WPM", "WULF",
] as const;

/**
 * Funds. Listed explicitly rather than pattern-matched: "is this an ETF" has
 * no reliable shape in a ticker, and a regex that guessed would eventually
 * either admit a fund or exile a company, silently, in a direction nobody
 * would notice.
 */
export const EXCLUDED_FUNDS: readonly string[] = [
  // Broad index
  "SPY", "QQQ", "DIA", "IWM", "VTI",
  // Sector SPDRs
  "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY",
  // Industry and thematic
  "SMH", "XBI", "COPX", "OIH", "GDX", "KRE", "ITB", "IGV", "IHI", "ITA",
  "IYT", "KCE", "XRT", "WGMI",
  // Fixed income
  "TLT", "IEF", "SHY", "LQD", "HYG", "TIP",
  // Commodity
  "GLD", "SLV", "USO", "DBA",
] as const;

/** Different asset class, different calendar. */
export const EXCLUDED_NON_EQUITY: readonly string[] = [
  "BTC-USD", "SOL-USD", "BNB-USD", "XRP-USD",
] as const;

/**
 * TRACKED, BUT DELIBERATELY OUTSIDE THE PANEL.
 *
 * These are the only exclusions here that are NOT about instrument kind.
 * Every name below is a US-listed operating company and satisfies the
 * inclusion rule above. They are held out for a different reason, and saying
 * so plainly matters more than the exclusion itself.
 *
 * ── Why ───────────────────────────────────────────────────────────────
 *
 * The panel was declared, and results were then computed and PUBLISHED on
 * it — cross-sectional momentum among them. Adding names later moves every
 * decile boundary underneath figures already on the site, so a reader
 * comparing two dates would be comparing two different experiments while the
 * page named only one.
 *
 * These six also share a mechanism: they are the datacenter/mining cohort,
 * which a control-basket test measured at +32.2bp/t=1.88 against index ETFs
 * at +7.0bp/t=1.80 — equal Sharpe on unequal magnitude, which is beta rather
 * than edge. Dropping six correlated high-beta names into a 95-name panel
 * would move the cross-section by more than their count suggests.
 *
 * ── What this is NOT ──────────────────────────────────────────────────
 *
 * Not a quality judgement, and not a claim they are untradeable — they are
 * precisely the names the overnight work is about, and they are ingested,
 * scanned, quoted and served like any other. They are absent from ONE thing:
 * the cross-sectional ranking.
 *
 * ── How a name leaves this list ───────────────────────────────────────
 *
 * Not by being moved into EQUITY_PANEL quietly. The exit is a VERSIONED
 * panel — a second declared composition, run alongside this one, with the
 * difference between them reported. That makes the effect of adding them
 * measurable instead of invisible, which is the whole reason this file
 * exists.
 */
export const TRACKED_OUTSIDE_PANEL: readonly string[] = [
  "APLD", "CLSK", "CORZ", "IONQ", "OKLO", "RIOT",
] as const;

const PANEL_SET: ReadonlySet<string> = new Set(EQUITY_PANEL);
const KNOWN: ReadonlySet<string> = new Set([
  ...EQUITY_PANEL,
  ...EXCLUDED_FUNDS,
  ...EXCLUDED_NON_EQUITY,
  ...TRACKED_OUTSIDE_PANEL,
]);

export function isPanelMember(symbol: string): boolean {
  return PANEL_SET.has(symbol);
}

/** True once a symbol has been classified either way. See `unclassified`. */
export function isClassified(symbol: string): boolean {
  return KNOWN.has(symbol);
}

/**
 * Symbols present in an ingest that nobody has classified yet.
 *
 * Callers MUST fail on a non-empty result rather than defaulting. Both
 * defaults are wrong in ways that hide: silently including would put the
 * next bond fund back in the ranking, and silently excluding would drop a
 * newly-ingested company out of the cross-section without a word. Adding an
 * instrument to the daily refresh is therefore a deliberate act of
 * classification, which is what this whole file is for.
 */
export function unclassified(symbols: readonly string[]): string[] {
  return symbols.filter((s) => !KNOWN.has(s)).sort();
}
