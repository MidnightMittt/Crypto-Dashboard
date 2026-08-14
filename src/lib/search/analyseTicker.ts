import { resolveTicker, ResolvedTicker } from "./resolveTicker";
import { fetchQuoteHistory } from "./fetchQuoteHistory";
import { buildLiveAnalysis, LiveAnalysis } from "./liveAnalysis";
import { MetricVerdict } from "@/lib/signals/types";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { buildDossier } from "@/lib/dossier/buildDossier";
import { TickerDossier } from "@/lib/dossier/types";
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

  const history = await fetchQuoteHistory(resolved.providerSymbol);
  if (!history.ok) {
    return { status: "error", message: history.reason, symbol: resolved.symbol };
  }

  const isCrypto = resolved.kind === "crypto";
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
    earningsCalendar: earningsCalendarJson as EarningsCalendar,
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
  });

  return { status: "ok", analysis: result.analysis, dossier, resolved };
}
