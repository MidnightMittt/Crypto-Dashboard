import { resolveTicker, ResolvedTicker } from "./resolveTicker";
import { fetchQuoteHistory } from "./fetchQuoteHistory";
import { buildLiveAnalysis, LiveAnalysis } from "./liveAnalysis";
import { MetricVerdict } from "@/lib/signals/types";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { buildDossier } from "@/lib/dossier/buildDossier";
import { available, Section, TickerDossier, unavailable } from "@/lib/dossier/types";
import { fetchOptionsSummary } from "@/lib/dossier/providers/cboeOptions";
import { fetchTradierChain } from "@/lib/dossier/providers/tradierOptions";
import { crossConfirm } from "@/lib/dossier/providers/crossVenueOptions";
import { fetchInsiderSummary } from "@/lib/dossier/providers/edgarInsiders";
import { fetchShortVolume } from "@/lib/dossier/providers/finraShortVolume";
import { fetchNews, fetchSocial } from "@/lib/dossier/providers/attention";
import { fetchFundamentals } from "@/lib/dossier/providers/secFundamentals";
import { fetchStreet } from "@/lib/dossier/providers/nasdaqStreet";
import { fetchBackdrop } from "@/lib/dossier/providers/macroBackdrop";
import { RegimeRead } from "@/lib/markets/riskRegime";
import { RotationRead } from "@/lib/markets/rotation";
import { IndustryRead } from "@/lib/markets/industryIntelligence";
import marketContextJson from "@/data/marketContext.json";
import earningsCalendarJson from "@/data/earningsCalendar.json";
import intelligenceJson from "@/data/marketIntelligence.json";

/**
 * SEARCH, END TO END — resolve, fetch, score.
 *
 * The one entry point the UI calls. Kept separate from `liveAnalysis.ts`
 * (which is pure and testable with no network) so the engine can be tested
 * without stubbing HTTP, and separate from `resolveTicker.ts` (also pure) so
 * the routing rules can be tested without either.
 */

interface MarketContext {
  generatedAt: number;
  asOf: number;
  benchmarkSymbol: string;
  benchmarkCloses: Array<{ t: number; close: number }>;
  marketWide: MetricVerdict[];
}

const context = marketContextJson as unknown as MarketContext;

/**
 * The macro snapshot every ticker inherits. Read once at module load: it is
 * committed data that only changes when the daily job rebuilds it, so
 * re-reading per request would buy nothing.
 */
const intelligence = intelligenceJson as unknown as {
  regime: RegimeRead | null;
  rotation: RotationRead | null;
  industries: IndustryRead[];
};

export type TickerAnalysisResult =
  | { status: "ok"; analysis: LiveAnalysis; dossier: TickerDossier; resolved: ResolvedTicker }
  | { status: "redirect"; href: string; symbol: string }
  | { status: "error"; message: string; symbol: string };

export async function analyseTicker(raw: string): Promise<TickerAnalysisResult> {
  const resolved = resolveTicker(raw);

  if (resolved.kind === "invalid") {
    return { status: "error", message: resolved.reason, symbol: raw.trim().toUpperCase() };
  }

  /*
   * An index ETF already has a page built from validated, daily-refreshed
   * bars. Sending the user there rather than re-deriving a live version is
   * not a shortcut — the snapshot page is strictly better evidence, and two
   * pages disagreeing about SPY would be a defect.
   */
  if (resolved.kind === "precomputed-equity") {
    return { status: "redirect", href: resolved.href, symbol: resolved.symbol };
  }

  const isCrypto = resolved.kind === "crypto";

  /*
   * Every source in one round trip. The providers never throw — each
   * returns its own ok/reason — so one venue having a bad day costs one
   * section, never the page. Equity-only sources are skipped for crypto
   * with a typed null rather than a wasted request.
   */
  const [history, options, tradier, insiders, shortVolume, news, social] = await Promise.all([
    fetchQuoteHistory(resolved.providerSymbol),
    isCrypto ? null : fetchOptionsSummary(resolved.symbol),
    isCrypto ? null : fetchTradierChain(resolved.symbol),
    isCrypto ? null : fetchInsiderSummary(resolved.symbol),
    isCrypto ? null : fetchShortVolume(resolved.symbol),
    fetchNews(resolved.providerSymbol),
    isCrypto ? null : fetchSocial(resolved.symbol),
  ]);

  if (!history.ok) {
    return { status: "error", message: history.reason, symbol: resolved.symbol };
  }

  /*
   * SECOND OPTIONS VENUE. When both CBOE and Tradier answered, compare them
   * on the expiration both list and attach the result to the CBOE summary —
   * so the options section gains a cross-venue confirmation line without the
   * summariser knowing a second venue exists. Tradier absent (no key, or a
   * bad day) simply leaves crossVenue null and the section stands on CBOE.
   */
  if (options?.ok && tradier?.ok) {
    const cross = crossConfirm(
      { spot: options.spot, contracts: options.contracts },
      { spot: tradier.spot, contracts: tradier.contracts },
      tradier.expiry
    );
    options.summary.crossVenue = cross;
  }

  /*
   * Second stage, because it needs the price: analyst targets are only
   * meaningful relative to the last close, so the street fetch waits for the
   * history. Fundamentals and the macro backdrop ride the same round trip.
   */
  const lastClose = history.history.bars[history.history.bars.length - 1]?.close ?? 0;
  const [fundamentals, street, backdrop] = await Promise.all([
    isCrypto ? null : fetchFundamentals(resolved.symbol),
    isCrypto ? null : fetchStreet(resolved.symbol, lastClose),
    isCrypto ? null : fetchBackdrop(),
  ]);

  /*
   * THE EARNINGS-VETO HOLE, closed. The committed calendar covers only the
   * tracked universe, so a searched ticker could previously carry a plan
   * straight across its own report. The per-symbol date fetched from Nasdaq
   * is MERGED into that same calendar, so the one existing earningsVeto
   * function fires for any searched symbol — same function, same three-
   * session window, and a missing date still never vetoes.
   */
  const staticCalendar = earningsCalendarJson as EarningsCalendar;
  const fetchedDate = street?.ok ? street.summary.nextEarningsDate : null;
  const earningsCalendar: EarningsCalendar = fetchedDate
    ? { ...staticCalendar, entries: [...staticCalendar.entries, { symbol: resolved.symbol, date: fetchedDate }] }
    : staticCalendar;

  const result = buildLiveAnalysis({
    symbol: resolved.symbol,
    name: history.history.name,
    assetClass: isCrypto ? "crypto" : "equity",
    bars: history.history.bars,
    // Crypto is deliberately not measured against the S&P; see the coverage
    // note in liveAnalysis.ts.
    benchmarkCloses: isCrypto ? null : context.benchmarkCloses,
    benchmarkSymbol: context.benchmarkSymbol,
    marketWide: isCrypto ? [] : context.marketWide,
    earningsCalendar,
    hasDerivatives: isCrypto ? resolved.hasDerivatives : false,
    now: Date.now(),
  });

  if (!result.ok) {
    return { status: "error", message: result.reason, symbol: resolved.symbol };
  }

  /*
   * Expectations and analogs are passed as null for now: neither exists for
   * equities, and the crypto replay is keyed to the BTC/ETH aggregator rather
   * than to this search path. The dossier turns each null into a stated
   * reason rather than a blank, so the page is honest today and gains the
   * numbers the moment the equity replay lands.
   */
  const dossier = buildDossier({
    analysis: result.analysis,
    regime: intelligence.regime ?? null,
    rotation: intelligence.rotation ?? null,
    industries: intelligence.industries ?? [],
    expectations: null,
    analogs: null,
    options: toSection(options, "advanced", {
      to: "institutional" as const,
      when: "positioning is tracked across sessions, so today's cross-venue snapshot becomes a trend rather than a single reading",
    }),
    insiders: toSection(insiders, "advanced", {
      to: "institutional" as const,
      when: "cluster-buy patterns are scored against their own forward record instead of reported as raw filings",
    }),
    shortVolume: toSection(shortVolume, "basic", {
      to: "advanced" as const,
      when: "bi-monthly short interest is ingested, so the standing short position is measured rather than one day's flow",
    }),
    newsSection: toSection(news, "basic", {
      to: "advanced" as const,
      when: "coverage volume is measured against this symbol's own baseline, so unusual attention becomes detectable",
    }),
    social: toSection(social, "basic", {
      to: "advanced" as const,
      when: "message velocity is baselined per symbol, so a crowd arriving is distinguishable from a crowd that was always there",
    }),
    business: toSection(fundamentals, "advanced", {
      to: "institutional" as const,
      when: "fundamental trends are scored against forward returns, so growth and dilution carry measured consequences rather than descriptions",
    }),
    street: toSection(street, "basic", {
      to: "advanced" as const,
      when: "target accuracy and rating changes are scored against realised outcomes, so the consensus carries a track record instead of a caveat",
    }),
    backdropLines: backdrop?.lines ?? null,
  });

  return { status: "ok", analysis: result.analysis, dossier, resolved };
}

/**
 * Provider result -> dossier Section. One mapping for every provider, so the
 * depth and failure semantics cannot drift between sources: success carries
 * the tier and its upgrade path; failure is a stated, transient
 * provider-error; null means the source was never queried and the dossier's
 * per-asset-class default explains why.
 */
function toSection<T>(
  result: { ok: true; summary: T } | { ok: false; reason: string } | null,
  depth: "basic" | "advanced",
  upgrade: { to: "advanced" | "institutional"; when: string }
): Section<T> | undefined {
  if (result === null) return undefined;
  if (result.ok) return available(result.summary, depth, upgrade);
  return unavailable("provider-error", result.reason);
}
