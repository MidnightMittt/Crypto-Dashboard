import { resolveTicker, ResolvedTicker } from "./resolveTicker";
import { fetchIntradayHistory, fetchQuoteHistory } from "./fetchQuoteHistory";
import { buildLiveAnalysis, LiveAnalysis } from "./liveAnalysis";
import { MetricVerdict } from "@/lib/signals/types";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { stopGrid } from "@/lib/research/stopViability";
import { trendState } from "@/lib/research/trendState";
import { buildDossier } from "@/lib/dossier/buildDossier";
import { available, Read, TickerDossier, unavailable } from "@/lib/dossier/types";
import { fetchOptionsSummary } from "@/lib/dossier/providers/cboeOptions";
import { fetchTradierChains } from "@/lib/dossier/providers/tradierOptions";
import { buildOptionsIntelligence } from "@/lib/dossier/providers/optionsIntelligence";
import { fetchCatalysts } from "@/lib/dossier/providers/edgarCatalysts";
import { Evidence, undeclaredEvidence } from "@/lib/dossier/types";
import { fetchEtfFlows } from "@/lib/providers/etfFlows";
import { crossConfirm } from "@/lib/dossier/providers/crossVenueOptions";
import { fetchInsiderSummary } from "@/lib/dossier/providers/edgarInsiders";
import { fetchShortVolume } from "@/lib/dossier/providers/finraShortVolume";
import { fetchNews, fetchSocial } from "@/lib/dossier/providers/attention";
import { fetchFundamentals } from "@/lib/dossier/providers/secFundamentals";
import { fetchStreet } from "@/lib/dossier/providers/nasdaqStreet";
import { fetchBackdrop } from "@/lib/dossier/providers/macroBackdrop";
import { readEquityMomentum } from "@/lib/signals/equityMomentum";
import {
  equityAnalogsFor,
  equityExpectationsFor,
  equityPlanConstraints,
  reachRateFor,
  EquityExecutionSnapshot,
} from "@/lib/dossier/equityExpectations";
import { RegimeRead } from "@/lib/markets/riskRegime";
import { RotationRead } from "@/lib/markets/rotation";
import { IndustryRead } from "@/lib/markets/industryIntelligence";
import marketContextJson from "@/data/marketContext.json";
import earningsCalendarJson from "@/data/earningsCalendar.json";
import intelligenceJson from "@/data/marketIntelligence.json";
import equityExecutionJson from "@/data/equityExecutionStats.json";
import forwardReachJson from "@/data/forwardReachRecord.json";
import forwardVerdictJson from "@/data/forwardVerdictRecord.json";
import fingerprintLibraryJson from "@/data/fingerprintLibrary.json";
import { rawReadings } from "@/lib/research/fingerprintReadings";
import { standardiseAgainst } from "@/lib/research/fingerprintInputs";
import { FingerprintLibrary, lookupNeighbourhood } from "@/lib/research/fingerprintLookup";
import { FINGERPRINT_VERSION } from "@/lib/research/fingerprint";

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
  const [history, intradayBars, etfFlows, options, tradier, insiders, shortVolume, news, social, catalysts] =
    await Promise.all([
    fetchQuoteHistory(resolved.providerSymbol),
    // The second timeframe, from the same keyless endpoint as the daily bars.
    fetchIntradayHistory(resolved.providerSymbol),
    /*
     * The one module that has cleared the Wilson gate AND survived FDR
     * correction (2026-08-15). The provider returns null for anything
     * without a US spot-ETF complex, which is everything except BTC and
     * ETH — so the guard is the asset class, and the provider handles the
     * rest without this file needing to know which tickers qualify.
     */
    isCrypto ? fetchEtfFlows(resolved.symbol as Parameters<typeof fetchEtfFlows>[0]) : null,
    isCrypto ? null : fetchOptionsSummary(resolved.symbol),
    isCrypto ? null : fetchTradierChains(resolved.symbol),
    isCrypto ? null : fetchInsiderSummary(resolved.symbol),
    isCrypto ? null : fetchShortVolume(resolved.symbol),
    fetchNews(resolved.providerSymbol),
    isCrypto ? null : fetchSocial(resolved.symbol),
    /*
     * Filings accepted since the prior close — the catalyst class that
     * decides an overnight hold. Equity-only: there is no issuer filing with
     * the SEC behind a token.
     */
    isCrypto ? null : fetchCatalysts(resolved.symbol),
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
    const front = tradier.chains[0];
    const cross = crossConfirm(
      { spot: options.spot, contracts: options.contracts },
      { spot: tradier.spot, contracts: front.contracts },
      front.expiry
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

  /*
   * THE GATE NEEDS A SIDE, AND THE SIDE COMES FROM THE ENGINE — so the read
   * is built once ungated to learn its direction and volatility regime, then
   * rebuilt with that bucket's measured constraints applied. The first pass
   * is a probe, never rendered; only the constrained result reaches the page.
   *
   * Rebuilding rather than patching keeps ONE construction path: a plan that
   * survived the gate was built by the same function, with the same geometry,
   * as a plan that never faced one.
   */
  const probe = buildLiveAnalysis({
    symbol: resolved.symbol,
    name: history.history.name,
    assetClass: isCrypto ? "crypto" : "equity",
    bars: history.history.bars,
    intradayBars,
    benchmarkCloses: isCrypto ? null : context.benchmarkCloses,
    benchmarkSymbol: context.benchmarkSymbol,
    marketWide: isCrypto ? [] : context.marketWide,
    earningsCalendar,
    hasDerivatives: isCrypto ? resolved.hasDerivatives : false,
    etfFlows,
    now: Date.now(),
  });

  const probeSide =
    probe.ok && probe.analysis.bias.verdict === "bullish"
      ? ("long" as const)
      : probe.ok && probe.analysis.bias.verdict === "bearish"
        ? ("short" as const)
        : null;
  const snapshot = equityExecutionJson as unknown as EquityExecutionSnapshot;
  const planConstraints =
    isCrypto || !probe.ok || !probeSide ? null : equityPlanConstraints(probeSide, probe.analysis.bias.metrics, snapshot);

  /*
   * The forward-looking setups price BOTH sides, so each needs its own
   * measured record — a long-at-support and a short-at-resistance are
   * different bets and must be gated separately. The short's cells are
   * negative, so this is also what stops a planned short being drawn at all.
   */
  const constraintsBySide =
    isCrypto || !probe.ok
      ? null
      : {
          long: equityPlanConstraints("long", probe.analysis.bias.metrics, snapshot),
          short: equityPlanConstraints("short", probe.analysis.bias.metrics, snapshot),
        };

  const result = buildLiveAnalysis({
    symbol: resolved.symbol,
    name: history.history.name,
    assetClass: isCrypto ? "crypto" : "equity",
    bars: history.history.bars,
    intradayBars,
    planConstraints,
    constraintsBySide,
    // Crypto is deliberately not measured against the S&P; see the coverage
    // note in liveAnalysis.ts.
    benchmarkCloses: isCrypto ? null : context.benchmarkCloses,
    benchmarkSymbol: context.benchmarkSymbol,
    marketWide: isCrypto ? [] : context.marketWide,
    earningsCalendar,
    hasDerivatives: isCrypto ? resolved.hasDerivatives : false,
    etfFlows,
    now: Date.now(),
  });

  if (!result.ok) {
    return { status: "error", message: result.reason, symbol: resolved.symbol };
  }

  /*
   * MEASURED EXPECTATIONS. The equity execution replay walks the committed
   * daily history point-in-time with this same engine and resolves every plan
   * it printed, so a stock now carries a real win rate, expectancy, drawdown
   * and holding time for its side and volatility regime — the numbers this
   * section spent its whole life stating it did NOT have.
   *
   * Only computed when the read is directional: a neutral verdict has no
   * side, and a side picked for the sake of filling a field would be a
   * fabricated bucket. Analogs remain null — setup-similarity fingerprints
   * exist only for the crypto majors, and the dossier still says so.
   */
  const expectationsSide =
    result.analysis.bias.verdict === "bullish"
      ? ("long" as const)
      : result.analysis.bias.verdict === "bearish"
        ? ("short" as const)
        : null;
  const expectations =
    isCrypto || !expectationsSide
      ? null
      : equityExpectationsFor(
          expectationsSide,
          result.analysis.bias.metrics,
          equityExecutionJson as unknown as EquityExecutionSnapshot
        );

  /*
   * Planned entries are pullbacks by construction, so each side's record is
   * the pullback cell for that side — looked up from the planned plan itself
   * rather than assumed, so the style can never drift out of sync with the
   * bucket being quoted.
   */
  const plannedView = result.analysis.plannedSetups;
  const recordFor = (dir: "long" | "short") => {
    if (isCrypto || !plannedView) return null;
    const setup = plannedView.setups.find((x) => x.direction === dir);
    if (!setup) return null;
    return equityAnalogsFor(dir, setup.plan, result.analysis.bias.metrics, snapshot);
  };

  /*
   * OPTIONS INTELLIGENCE. Built here rather than in the provider because it
   * needs three things the provider cannot see: the price history (for
   * realised volatility), the engine's own verdict (for the agreement check)
   * and the plan's first target (for the expected-move comparison).
   *
   * The target falls back to the PLANNED setup when the EV gate refused a
   * live plan. That is deliberate — on a waiting day the question "is the
   * level I am waiting for even reachable inside what the options market is
   * pricing?" is the most useful thing on the page, and it would be lost if
   * the comparison only ran when a trade was already live.
   */
  const optionsIntel = (() => {
    if (isCrypto || !tradier?.ok) return null;
    const livePlan = result.analysis.plan;
    const plannedPlan = plannedView?.setups.find((s) => s.primary)?.plan ?? plannedView?.setups[0]?.plan ?? null;
    const forTarget = livePlan ?? plannedPlan;
    const firstTargetPct =
      forTarget && forTarget.entryRef > 0
        ? (Math.abs(forTarget.target1Price - forTarget.entryRef) / forTarget.entryRef) * 100
        : null;
    return buildOptionsIntelligence({
      chains: tradier.chains,
      spot: tradier.spot,
      closes: history.history.bars.map((b) => b.close),
      engineVerdict:
        result.analysis.bias.verdict === "bullish" || result.analysis.bias.verdict === "bearish"
          ? result.analysis.bias.verdict
          : "neutral",
      firstTargetPct,
      now: Date.now(),
    });
  })();

  /*
   * THE VALIDATED SIGNAL. Computed here rather than inside buildDossier
   * because it needs the raw bars — a full year plus the skipped month —
   * and LiveAnalysis carries only `barsUsed`. Given the panel snapshot, it
   * is pure arithmetic; every refusal it can return is a stated reason
   * rather than a thrown error.
   */
  const momentum = readEquityMomentum({
    symbol: result.analysis.symbol,
    assetClass: result.analysis.assetClass,
    bars: history.history.bars,
    now: Date.now(),
  });

  /*
   * Computed here rather than inside buildDossier for the same reason
   * momentum is: it needs the raw adjusted bars, and LiveAnalysis carries only
   * `barsUsed`. Three years is enough for the 21-session horizon to have real
   * windows without reaching back into a different volatility regime.
   */
  const stops = stopGrid(result.analysis.symbol, history.history.bars.slice(-756));
  /*
   * Sixty sessions for the trailing high — a quarter, long enough that the
   * line follows a real trend rather than last week's chop, short enough that
   * a high from a different regime cannot hold the exit hostage.
   */
  const trend = trendState(result.analysis.symbol, history.history.bars);

  const dossier = buildDossier({
    analysis: result.analysis,
    stopGrid: stops,
    trendState: trend,
    momentum,
    closes: history.history.bars.map((b) => b.close),
    optionsIntel: optionsIntel
      ? available(
          optionsIntel,
          "advanced",
          {
            to: "institutional" as const,
            when: "a year of this symbol's own implied volatility is recorded, so IV rank and percentile become measurable and today's reading gains a distribution to sit in",
          },
          undeclaredEvidence()
        )
      : isCrypto
        ? unavailable(
            "not-measured-yet",
            "Deribit carries crypto options for the majors; routing them through this module is backlog, not a data limitation."
          )
        : unavailable(
            // A missing key will never fix itself on a reload; a hiccup likely will.
            tradier && !tradier.ok && !tradier.configured ? "no-provider" : "provider-error",
            tradier && !tradier.ok ? tradier.reason : "The options chain was not queried for this asset."
          ),
    regime: intelligence.regime ?? null,
    rotation: intelligence.rotation ?? null,
    industries: intelligence.industries ?? [],
    plannedRecords: { long: recordFor("long"), short: recordFor("short") },
    /*
     * The only out-of-sample number on the page. Read once at module load
     * like every other committed artefact; the daily job is what moves it.
     */
    forward: isCrypto
      ? null
      : (() => {
          const r = forwardReachJson as unknown as {
            totals: {
              resolved: number;
              predictedPct: number | null;
              observedPct: number | null;
              open?: number;
              openReached?: number;
            };
            predictions: Array<{ date: string }>;
          };
          const dates = r.predictions.map((p) => p.date).sort();
          return {
            resolved: r.totals.resolved,
            predictedPct: r.totals.predictedPct,
            observedPct: r.totals.observedPct,
            since: dates[0] ?? null,
            open: r.totals.open ?? 0,
            openReached: r.totals.openReached ?? 0,
          };
        })(),
    /*
     * The verdict's own out-of-sample record. A claim and its track record
     * belong together, so this rides on the verdict rather than hiding in a
     * research section — including when the honest answer is "unscored".
     */
    verdictForward: isCrypto
      ? null
      : (() => {
          const r = forwardVerdictJson as unknown as {
            horizonSessions: number;
            baselineReturnPct: number | null;
            totals: { resolved: number; open: number };
            cells: Array<{
              verdict: string; n: number; hitRatePct: number | null;
              meanReturnPct: number; edgeVsBaselinePct: number | null;
            }>;
          };
          const want = result.analysis.bias.verdict;
          return {
            resolved: r.totals.resolved,
            open: r.totals.open,
            baselineReturnPct: r.baselineReturnPct,
            mine: r.cells.find((c) => c.verdict === want) ?? null,
            horizonSessions: r.horizonSessions,
          };
        })(),
    reachOf: isCrypto
      ? null
      : (distanceAtr, touches, prefer) => {
          const c = reachRateFor(distanceAtr, touches, snapshot, prefer);
          return c
            ? {
                reachRatePct: c.reachRatePct,
                attempts: c.attempts,
                medianSessionsToReach: c.medianSessionsToReach,
                distanceAtr,
                touches,
              }
            : null;
        },
    expectations,
    /*
     * Analogs are looked up from the UNGATED probe's plan, not the gated one.
     * The setup's historical record is exactly what justifies a refusal, so
     * hiding it whenever the gate fires would remove the evidence at the
     * moment it matters most. The entry style comes from the probe's geometry
     * because that is the entry the setup was asking for.
     */
    /*
     * SIMILAR ENVIRONMENTS, by fingerprint.
     *
     * Today's reading is standardised against the moments the ingest
     * published for THIS instrument, not recomputed from its history — the
     * library stores z-scores, which cannot be inverted, and replaying an
     * instrument's whole history per request would cost thousands of engine
     * runs. Those moments end at the last ingested session, so scoring today
     * against them is strictly backward-looking.
     *
     * An instrument outside the 120-name replay panel has no moments, and
     * the section says so rather than comparing it on a scale built from
     * somebody else's history.
     */
    analogsBlockedReason:
      isCrypto || (fingerprintLibraryJson as unknown as FingerprintLibrary).moments?.[resolved.symbol]
        ? null
        : `${resolved.symbol} is outside the ${(fingerprintLibraryJson as unknown as FingerprintLibrary).instruments}-instrument panel the fingerprint library is built from, so there is no scale of its own history to standardise today's reading against. Comparing it on another instrument's scale would produce a number, and the number would be meaningless. Widening the panel is ingest work, not a market limitation.`,

    analogs: (() => {
      if (isCrypto) return null;
      const lib = fingerprintLibraryJson as unknown as FingerprintLibrary;
      const moments = lib.moments?.[resolved.symbol];
      if (!moments) return null;


      const bars = history.history.bars;
      const values = standardiseAgainst(
        rawReadings({
          closes: bars.map((b) => b.close),
          volumes: bars.map((b) => b.volume ?? 0),
          metrics: result.analysis.bias.metrics,
          zones: result.analysis.zones,
          atrPct: result.analysis.atrPct,
        }),
        moments
      );
      return lookupNeighbourhood(
        {
          symbol: resolved.symbol,
          date: new Date(result.analysis.asOf).toISOString().slice(0, 10),
          version: FINGERPRINT_VERSION,
          values,
        },
        lib
      );
    })(),
    options: toRead(options, "advanced", {
      to: "institutional" as const,
      when: "positioning is tracked across sessions, so today's cross-venue snapshot becomes a trend rather than a single reading",
    }, undeclaredEvidence()),
    insiders: toRead(insiders, "advanced", {
      to: "institutional" as const,
      when: "cluster-buy patterns are scored against their own forward record instead of reported as raw filings",
    }, undeclaredEvidence()),
    shortVolume: toRead(shortVolume, "basic", {
      to: "advanced" as const,
      when: "bi-monthly short interest is ingested, so the standing short position is measured rather than one day's flow",
    }, undeclaredEvidence()),
    newsSection: toRead(news, "basic", {
      to: "advanced" as const,
      when: "coverage volume is measured against this symbol's own baseline, so unusual attention becomes detectable",
    }, undeclaredEvidence()),
    /*
     * A SUCCESSFUL fetch returning zero filings is a real answer — nothing was
     * filed — and must not be confused with a lookup that failed. The provider
     * already separates the two, so the section carries the distinction rather
     * than flattening it into an empty list.
     */
    catalysts: catalysts
      ? catalysts.ok
        ? available(catalysts.filings, "advanced", null, {
            confidence: null,
            reasoning: [
              catalysts.filings.length === 0
                ? "No qualifying filing has been accepted since the prior session's close."
                : `${catalysts.filings.length} qualifying filing(s) accepted since the prior close.`,
            ],
            provenance: [
              {
                field: "filings_since_prior_close",
                unit: "filings",
                as_of: catalysts.windowStart,
                source: "sec_edgar_submissions",
                method: "8-K items 1.01/2.02/3.02/7.01/8.01, any 424B, S-3ASR",
              },
            ],
          })
        : unavailable("provider-error", `EDGAR could not be read for this symbol (${catalysts.reason}).`)
      : undefined,
    social: toRead(social, "basic", {
      to: "advanced" as const,
      when: "message velocity is baselined per symbol, so a crowd arriving is distinguishable from a crowd that was always there",
    }, undeclaredEvidence()),
    business: toRead(fundamentals, "advanced", {
      to: "institutional" as const,
      when: "fundamental trends are scored against forward returns, so growth and dilution carry measured consequences rather than descriptions",
    }, undeclaredEvidence()),
    street: toRead(street, "basic", {
      to: "advanced" as const,
      when: "target accuracy and rating changes are scored against realised outcomes, so the consensus carries a track record instead of a caveat",
    }, undeclaredEvidence()),
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
function toRead<T>(
  result: { ok: true; summary: T } | { ok: false; reason: string } | null,
  depth: "basic" | "advanced",
  upgrade: { to: "advanced" | "institutional"; when: string },
  /*
   * REQUIRED, with no default. Seven provider sections flow through this
   * helper, and a default here would have hidden all seven behind one
   * signature — the exact failure that made the gap uncountable before.
   */
  evidence: Evidence
): Read<T> | undefined {
  if (result === null) return undefined;
  if (result.ok) return available(result.summary, depth, upgrade, evidence);
  return unavailable("provider-error", result.reason);
}
