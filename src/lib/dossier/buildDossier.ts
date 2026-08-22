import { LiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "@/lib/search/liveAnalysis";
import { describeStop } from "@/lib/research/stopViability";
import { equityVerdict } from "@/lib/markets/equityVerdict";
import { nearestWatchLevels, SupportResistanceZone, watchEdge } from "@/lib/technicals/marketStructure";
import { TRADE_PLAN_REFUSAL_SHORT } from "@/lib/signals/tradePlan";
import { describeAgreement, evidenceLevel, strengthStars } from "@/lib/signals/plainLanguage";
import { buildMacroContext } from "./macroContext";
import { downsample } from "@/lib/charts/sparkline";
import { composeBearCase, composeBullCase, composeInvalidation, composeTldr } from "./narrative";
import { NeighbourhoodStats } from "@/lib/research/neighbourhood";
import { buildChecklist } from "./checklist";
import { gradeForComposite } from "@/lib/signals/evidenceGrade";
import { weightForBasis } from "@/lib/signals/scoring";
import metricStats from "@/data/backtestMetricStats.json";
import { buildPassRules } from "./passRules";
import { assessConviction } from "@/lib/signals/conviction";
import { undeclaredEvidence } from "./types";
import { LivenessRead, StoreInput, assessLiveness } from "./pipelineLiveness";
import signalLedgerJson from "@/data/signalLedger.json";
import equityMarketsJson from "@/data/equityMarkets.json";
import positioningLatestJson from "@/data/positioningLatest.json";
import forwardReachJson from "@/data/forwardReachRecord.json";
import equityCrossSectionJson from "@/data/equityCrossSection.json";
import {
  AnalogStats,
  available,
  ForwardRecordSummary,
  VerdictForwardRecord,
  PlannedEntry,
  PlannedEntryRead,
  WatchLevel,
  EvidenceGroup,
  PlanExpectations,
  Read,
  TickerDossier,
  unavailable,
} from "./types";
import { RegimeRead } from "@/lib/markets/riskRegime";
import { RotationRead } from "@/lib/markets/rotation";
import { IndustryRead } from "@/lib/markets/industryIntelligence";

/**
 * ASSEMBLY — evidence in, dossier out.
 *
 * This module decides WHICH sections a given ticker can support and fills
 * them; it computes no opinion of its own. Every number comes from the live
 * analysis, the committed intelligence snapshot, or the replay statistics,
 * and every absence is labelled with the reason it is absent.
 *
 * The `unavailable` branches below are not error handling. They are the
 * product's honesty surface and, read together, they are the build queue:
 * every "not-measured-yet" is work this platform owes its users, and every
 * "no-provider" is a sourcing decision someone has to make.
 */

/** Drawing budget for the price trail. See priceTrail. */
const SPARKLINE_POINTS = 220;

export interface DossierInputs {
  analysis: LiveAnalysis;
  /**
   * Stop survival, computed by the CALLER because it needs the raw adjusted
   * bars and LiveAnalysis carries only `barsUsed` — the same reason `analogs`
   * arrives pre-built rather than being derived here.
   */
  stopGrid?: import("@/lib/research/stopViability").StopGrid | null;
  /** The exit line, computed by the caller for the same raw-bars reason. */
  trendState?: import("@/lib/research/trendState").TrendState | null;
  regime: RegimeRead | null;
  rotation: RotationRead | null;
  industries: IndustryRead[];
  /** Replay-derived expectations, when the asset class has an execution replay. */
  expectations?: PlanExpectations | null;
  /** Similar historical environments, from fingerprint matching. */
  analogs?: NeighbourhoodStats | null;
  /**
   * Why there are none, when the caller knows. "Outside the panel" and "no
   * close match" are different facts, and one message covering both is the
   * kind of blurry absence this page exists to avoid.
   */
  analogsBlockedReason?: string | null;
  /**
   * Per-planned-entry historical records, keyed by direction. Supplied by
   * the caller because the lookup is asset-class specific; the dossier only
   * attaches them.
   */
  plannedRecords?: { long: AnalogStats | null; short: AnalogStats | null } | null;
  /** Measured reach lookup, supplied by the caller (asset-class specific). */
  reachOf?: ((distanceAtr: number, touches: number, prefer: "plan" | "zone") => PlannedEntry["reach"]) | null;
  /** Out-of-sample scorecard for the reach numbers, when one exists. */
  forward?: ForwardRecordSummary | null;
  /** Out-of-sample record for the verdict word itself. */
  verdictForward?: VerdictForwardRecord | null;
  /**
   * Where this ticker sits in the validated cross-sectional momentum
   * ranking. Computed by the caller because it needs the raw bars, which
   * LiveAnalysis deliberately does not carry.
   */
  momentum?: import("@/lib/signals/equityMomentum").MomentumOutcome | null;
  /** Raw closes, oldest first. Downsampled here so callers need no chart knowledge. */
  closes?: number[] | null;
  /*
   * Provider-backed sections, already shaped by the caller (analyseTicker
   * maps each provider result to a Section with its depth and upgrade).
   * Undefined means the caller did not attempt the provider — the defaults
   * below state why per asset class.
   */
  options?: TickerDossier["optionsFlow"];
  optionsIntel?: TickerDossier["optionsIntel"];
  insiders?: TickerDossier["insiderActivity"];
  shortVolume?: TickerDossier["shortInterest"];
  newsSection?: TickerDossier["news"];
  social?: TickerDossier["socialSentiment"];
  business?: TickerDossier["business"];
  street?: TickerDossier["street"];
  catalysts?: TickerDossier["catalysts"];
  /** Volatility/rates/dollar/credit sentences, threaded into the macro section. */
  backdropLines?: string[] | null;
}


/**
 * THE DECLARED STORES the daily pipeline is supposed to append to.
 *
 * A declared list rather than a directory scan, for the reason a declared
 * list is always right here: a scan reports on whatever happens to exist, so
 * a store that stopped being written would simply stop being checked. These
 * are the five the dossier actually draws numbers from, named in the
 * reader's words.
 */
const isoDay = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString().slice(0, 10)
    : null;

function livenessStores(): StoreInput[] {
  const ledger = (signalLedgerJson as { entries?: { date?: string }[] }).entries ?? [];
  const lastLedger = ledger.length ? (ledger[ledger.length - 1].date ?? null) : null;
  return [
    {
      store: "equityMarkets.json",
      what: "the markets snapshot",
      lastUpdate: isoDay((equityMarketsJson as { generatedAt?: number }).generatedAt),
    },
    {
      store: "signalLedger.json",
      what: "the daily signal ledger",
      lastUpdate: lastLedger,
    },
    {
      store: "forwardReachRecord.json",
      what: "the forward record",
      lastUpdate: isoDay((forwardReachJson as { generatedAt?: number }).generatedAt),
    },
    {
      store: "positioningLatest.json",
      what: "options and short-volume positioning",
      lastUpdate: isoDay((positioningLatestJson as { generatedAt?: number }).generatedAt),
    },
    {
      store: "equityCrossSection.json",
      what: "the cross-sectional panel",
      // asOf is epoch ms here, not an ISO string — the compiler caught the
      // assumption. Normalised through the same helper as every other store.
      lastUpdate: isoDay((equityCrossSectionJson as { asOf?: number }).asOf),
    },
  ];
}

/**
 * Always available, never a provider call: the answer is derived from files
 * already in the bundle. There is no failure mode that produces "unknown" —
 * a store that has never been written reports exactly that.
 */
function buildLiveness(): Read<LivenessRead> {
  const read = assessLiveness(livenessStores(), new Date().toISOString().slice(0, 10));
  return available(read, "advanced", null, {
    confidence: null,
    reasoning: [describeLivenessReason(read)],
    provenance: read.stores.map((s) => ({
      field: s.store,
      unit: "iso_date",
      as_of: s.lastUpdate ?? "never",
      source: "committed_data_store",
      method: "weekdays_since_last_append_excluding_today",
    })),
  });
}

function describeLivenessReason(read: LivenessRead): string {
  return read.degraded === 0
    ? `All ${read.stores.length} daily stores carry the most recent session.`
    : `${read.degraded} of ${read.stores.length} daily stores are behind by up to ${read.worstSessionsBehind ?? 0} session(s).`;
}

/**
 * The backdrop, in one sentence that names its scope. It is the SAME
 * sentence on every equity page today because it is the same fact — that
 * sameness is stated rather than disguised as 131 per-symbol opinions,
 * which is what it used to be when these metrics voted in the score.
 */
function describeBackdrop(
  backdrop: LiveAnalysis["marketBackdrop"],
  symbolVerdict: string
): string | null {
  if (!backdrop) return null;
  const word =
    backdrop.verdict === "bullish" ? "risk-on" : backdrop.verdict === "bearish" ? "risk-off" : "mixed";
  const named = backdrop.metrics
    .slice(0, 2)
    .map((m) => m.label.toLowerCase())
    .join(" and ");
  const base =
    `Market backdrop: ${word} (score ${backdrop.score}, from ${named}). ` +
    `This is one market-wide reading, identical on every equity page — it is context beside ` +
    `this verdict, not a vote inside it.`;
  if (backdrop.verdict !== "neutral" && symbolVerdict !== "neutral" && backdrop.verdict !== symbolVerdict) {
    return (
      base +
      ` It currently points the OTHER way from this symbol's own evidence — the strongest argument` +
      ` against sizing this read aggressively.`
    );
  }
  return base;
}

export function buildDossier(inputs: DossierInputs): TickerDossier {
  const { analysis, regime, rotation, industries } = inputs;
  const { bias, plan } = analysis;
  const isCrypto = analysis.assetClass === "crypto";

  /*
   * Hoisted because the checklist needs the earnings date too, and reading it
   * from anywhere else would let the tick and the Wall Street panel disagree
   * about the same report.
   */
  const streetSection =
    inputs.street ??
    unavailable(
      isCrypto ? "not-applicable" : "no-provider",
      isCrypto
        ? "Sell-side analyst coverage in the equity sense does not exist for crypto assets."
        : "Analyst coverage was not queried for this asset."
    );

  /*
   * Hoisted for the same reason as the street section: the ten-second read
   * now reports coverage clustering, and it must read the SAME section the
   * news panel renders. Two computations of "how much has been written"
   * could disagree on one page.
   */
  const newsSection =
    inputs.newsSection ?? unavailable("no-provider", "The news feed was not queried for this asset.");

  /*
   * The options read, when one exists. Taken from the section the caller
   * already built rather than re-derived, so the checklist and the options
   * panel can never disagree about what the chain said.
   */
  const intel = inputs.optionsIntel?.status === "available" ? inputs.optionsIntel.data : null;

  const verdict = equityVerdict({
    bias,
    plan,
    refusal: analysis.planRefusal,
    refusalDetail: analysis.planRefusalDetail,
    earningsDate: analysis.earnings?.date ?? null,
  });

  /*
   * Hoisted out of the literal because TWO sections read it: the next-entry
   * section renders it, and the invalidation section takes its prices from it
   * so that "what changes my mind" is a level on every ticker rather than
   * only on the ones carrying a plan. One computation, so they cannot drift.
   */
  const grade = gradeForComposite(
    bias,
    weightForBasis(bias.basis),
    metricStats.moduleGrades as Parameters<typeof gradeForComposite>[2]
  );

  const nextEntry = buildNextEntry(
    analysis,
    inputs.plannedRecords ?? null,
    inputs.reachOf ?? null,
    inputs.forward ?? null
  );

  return {
    identity: {
      symbol: analysis.symbol,
      name: analysis.name,
      assetClass: analysis.assetClass,
      lastClose: analysis.lastClose,
      change24hPct: analysis.change24hPct,
      asOf: analysis.asOf,
      barsUsed: analysis.barsUsed,
      provenance: `Daily closes through ${new Date(analysis.asOf).toISOString().slice(0, 10)}, fetched on request.`,
    },

    verdict: {
      emoji: verdict.emoji,
      word: verdict.word,
      tone: verdict.tone,
      sentence: verdict.sentence,
      action: verdict.action,
      stars: strengthStars(bias.score),
      evidence: evidenceLevel(bias.confidence),
      agreementLine: describeAgreement(bias.agreement),
      /*
       * Read from the committed snapshot, never recomputed here. The FDR
       * correction behind these grades is only meaningful across the whole
       * candidate family, which the harness has in scope and a page render
       * does not.
       *
       * Weights come from the SAME weightForBasis the composite itself used,
       * so the denominator is literally the weight that produced the score —
       * not a second opinion about what should have counted.
       */
      evidenceGrade: grade,
      /*
       * Computed from the SAME grade object rendered beside it, so the
       * conviction word and the validated-weight figure can never disagree
       * about how much of this read is proven.
       */
      conviction: assessConviction({
        confidencePct: bias.confidence,
        agreementPct: bias.agreement,
        grade: grade.label,
        validatedWeightPct: grade.validatedWeightPct,
      }),
      forward: inputs.verdictForward ?? null,
      backdrop: describeBackdrop(analysis.marketBackdrop, bias.verdict),
    },

    tldr: composeTldr({
      bias,
      plan,
      symbol: analysis.symbol,
      name: analysis.name,
      /*
       * The whole measured chain, not just its three-value lean. The lean
       * alone produced one of two fixed sentences on every ticker that had
       * a chain at all, discarding the move being priced, how that compares
       * to realised, and the skew — every number that makes one name's
       * options read different from another's.
       */
      options: intel
        ? {
            // "neutral" is not a lean, so it is passed through as no opinion.
            lean: intel.optionsLean !== "neutral" ? intel.optionsLean : null,
            expectedMovePct: intel.expectedMovePct,
            daysToHorizon: intel.daysToHorizon,
            ivMinusRvPct: intel.ivMinusRvPct,
            skewPct: intel.skewPct,
            putCallOiRatio: intel.putCallOiRatio,
          }
        : null,
      /*
       * Coverage clustering. Read from the section the page already renders
       * so the summary and the news panel cannot disagree about how much
       * has been written.
       */
      news:
        newsSection.status === "available"
          ? {
              recentCount: newsSection.data.recentCount,
              totalCount: newsSection.data.items.length,
              /*
               * The window the feed ACTUALLY covers, so the clause can ask
               * whether coverage accelerated rather than reporting a share
               * of a denominator the provider chose.
               */
              spanDays: (() => {
                const ts = newsSection.data.items.map((i) => i.publishedAt).filter((t) => t > 0);
                if (ts.length < 2) return 0;
                return (Math.max(...ts) - Math.min(...ts)) / 86_400_000;
              })(),
              leadHeadline: newsSection.data.items[0]?.title ?? null,
              newestAgeHours: (() => {
                const ts = newsSection.data.items.map((i) => i.publishedAt).filter((t) => t > 0);
                return ts.length > 0 ? (Date.now() - Math.max(...ts)) / 3_600_000 : null;
              })(),
              leadPublisher: newsSection.data.items[0]?.publisher ?? null,
            }
          : null,
    }),

    plan: {
      plan,
      refusal: analysis.planRefusal,
      expectations: buildExpectations(inputs.expectations ?? null, isCrypto),
    },

    checklist: buildChecklist({
      bias,
      plan,
      refusal: analysis.planRefusal,
      earnings: analysis.earnings,
      /*
       * Three states that must not collapse into two. `undefined` for crypto
       * drops the row — a token has no report to sit inside a hold. A real
       * date lets the row claim a CONFIRMED clear. `null` means the lookup
       * came back empty, which the checklist now shows as an open question
       * instead of a tick.
       *
       * Read off the street section so there is one date on the page: the
       * same one the Wall Street panel renders.
       */
      nextEarningsDate: isCrypto
        ? undefined
        : streetSection.status === "available"
          ? streetSection.data.nextEarningsDate
          : null,
      /*
       * Only a genuine lean counts. `agreesWithEngine` is already null when
       * the chain has no opinion, and passing that through unchanged is what
       * keeps "no options data" from rendering as "options agree".
       */
      optionsAgrees: intel?.agreesWithEngine ?? null,
    }),

    passRules: buildPassRules({
      plan,
      refusal: analysis.planRefusal,
      earnings: analysis.earnings,
      direction: bias.verdict === "bearish" ? "bearish" : bias.verdict === "bullish" ? "bullish" : "neutral",
      expectedMovePct: intel?.expectedMovePct ?? null,
      firstTargetPct:
        plan && plan.entryRef > 0
          ? (Math.abs(plan.target1Price - plan.entryRef) / plan.entryRef) * 100
          : null,
    }),

    bullCase: composeBullCase(bias),
    bearCase: composeBearCase(bias),
    /*
     * `nextEntry` is passed so this section can always name a PRICE. Without
     * it the no-plan path fell back to engine internals, which is unusable on
     * exactly the days — the WAIT majority — when a reader most needs a level
     * to watch. Computed once above and shared, so the two sections can never
     * disagree about where the next decision sits.
     */
    invalidation: composeInvalidation({
      bias,
      plan,
      earningsDate: analysis.earnings?.date ?? null,
      nextEntry,
    }),

    trendState: inputs.trendState
      ? available(
          inputs.trendState,
          "advanced",
          {
            to: "institutional" as const,
            when: "positions are known, so the trailing high can be measured from YOUR entry rather than from a rolling window — a high made before you owned it is not one you could have sold into",
          },
          {
            /*
             * DESCRIPTIVE. This states a level derived from the bars; it makes
             * no claim that holding to it beats any alternative. The multiple
             * is declared, not fitted, and calling it validated would claim a
             * standing it has never been tested for.
             */
            confidence: {
              grade: "strong",
              validated: {
                label: "descriptive",
                validatedWeightPct: 0,
                validatedCount: 0,
                contributingCount: 0,
                validatedModules: [],
                sentence:
                  "Descriptive: a level read off this name's own range, not a forecast that holding to it is optimal.",
              },
              n: inputs.trendState.lookback,
            },
            reasoning: [
              inputs.trendState.sentence,
              `Trailing high is taken on CLOSES over ${inputs.trendState.lookback} sessions, so an intraday spike cannot ratchet the line up to a level the position never had the chance to sell into.`,
              "The multiple is 1.5 ATR — declared, not optimised. It is a session and a half of this name's own movement.",
            ],
            provenance: [
              {
                field: "trailStop",
                unit: "usd",
                as_of: new Date(inputs.analysis.asOf).toISOString(),
                source: "adjusted_daily_bars",
                method: "trailing_high_of_closes_minus_1_5_wilder_atr_14",
              },
            ],
          }
        )
      : unavailable(
          "not-measured-yet",
          "Too few sessions to compute an ATR, so there is no reference level to place."
        ),
    stopGrid: inputs.stopGrid
      ? available(
          inputs.stopGrid,
          "advanced",
          {
            to: "institutional" as const,
            when: "intraday bars replace daily lows, so a stop's fill can be modelled within the session rather than assumed at the low",
          },
          {
            /*
             * NOT validated: this is a MEASUREMENT of what the bars did, not a
             * forecast that anything will keep doing it. It has no forward
             * record because there is no prediction to score.
             */
            confidence: {
              grade: "strong",
              /*
               * DESCRIPTIVE, not validated. This measures what the bars did;
               * it forecasts nothing, so there is no prediction to score and
               * no forward record to earn. Grading it "validated" would claim
               * a standing this has not been put up for.
               */
              validated: {
                label: "descriptive",
                validatedWeightPct: 0,
                validatedCount: 0,
                contributingCount: 0,
                validatedModules: [],
                sentence:
                  "Descriptive: this measures what the bars did and forecasts nothing, so there is no prediction to score.",
              },
              n: inputs.stopGrid.cells[0]?.n ?? null,
            },
            reasoning: [
              describeStop(inputs.stopGrid, 5),
              "Measured from intraday LOWS, not closes: a stop is a resting order and a session that traded down 6% then closed flat still took out a 5% stop.",
              "Still optimistic — within-session path is invisible in daily bars, so a real fill is likelier to be worse than the low than better.",
            ],
            provenance: [
              {
                field: "survivalPct",
                unit: "pct",
                as_of: inputs.stopGrid.toDate,
                source: "adjusted_daily_bars",
                method: "share_of_entries_whose_low_never_reached_the_stop_entry_bar_excluded",
              },
            ],
          }
        )
      : unavailable(
          "not-measured-yet",
          "Too few sessions to measure stop survival — the grid needs enough complete windows at the longest horizon before a rate means anything."
        ),
        analogs: buildAnalogs(inputs.analogs ?? null, isCrypto, analysis.barsUsed, inputs.analogsBlockedReason ?? null),

    nextEntry,

    validatedSignal: buildValidatedSignal(inputs.momentum ?? null),

    /*
     * SPARKLINE_POINTS is a drawing budget, not a data decision: 220px of
     * chart cannot resolve more than a couple of hundred points, and shipping
     * five years of closes to the client to draw 200 of them would be paying
     * bandwidth for pixels that do not exist.
     */
    priceTrail:
      inputs.closes && inputs.closes.length >= 2
        ? { closes: downsample(inputs.closes, SPARKLINE_POINTS), sessions: inputs.closes.length }
        : null,

    macro: buildMacroContext({
      symbol: analysis.symbol,
      assetClass: analysis.assetClass,
      regime,
      rotation,
      industries,
      backdropLines: inputs.backdropLines ?? null,
    }),

    evidence: bias.categories.map(
      (c): EvidenceGroup => ({
        label: c.label,
        score: c.score,
        verdict: c.verdict,
        confidence: c.confidence,
        topReason: c.topReason,
        metrics: c.metrics,
      })
    ),

    earnings: analysis.earnings,
    zones: analysis.zones,
    atrPct: analysis.atrPct,
    bias,

    // ── Provider-backed sections, with per-asset-class defaults ─────────
    moneyFlow: buildMoneyFlow(bias.categories, isCrypto),

    business:
      inputs.business ??
      unavailable(
        isCrypto ? "not-applicable" : "no-provider",
        isCrypto
          ? "A crypto asset has no issuer filing audited financials — there is no business underneath the token in the corporate sense."
          : "Company financials were not queried for this asset."
      ),
    street: streetSection,

    /*
     * THE TWO RECOVERED ORPHANS.
     *
     * Both were built, tested and shipped, and reached no reader: the
     * catalyst feed served /api/pretrade only, and nothing anywhere reported
     * whether the daily pipeline had run. Under the module registry they are
     * one entry each and the page did not change to accept them.
     */
    catalysts:
      inputs.catalysts ??
      unavailable(
        isCrypto ? "not-applicable" : "no-provider",
        isCrypto
          ? "There is no issuer filing with the SEC behind a crypto asset, so there are no filings to watch for."
          : "EDGAR was not queried for this asset."
      ),
    liveness: buildLiveness(),

    news: newsSection,
    socialSentiment:
      inputs.social ??
      unavailable(
        isCrypto ? "not-measured-yet" : "no-provider",
        isCrypto
          ? "StockTwits carries crypto streams under .X symbols; wiring them is backlog, not a data limitation."
          : "The social feed was not queried for this asset."
      ),
    optionsFlow:
      inputs.options ??
      unavailable(
        isCrypto ? "not-measured-yet" : "no-provider",
        isCrypto
          ? "Crypto options exist on Deribit for the majors and are not yet wired into this page — backlog, not a data limitation."
          : "The options chain was not queried for this asset."
      ),
    optionsIntel:
      inputs.optionsIntel ??
      unavailable(
        isCrypto ? "not-measured-yet" : "no-provider",
        isCrypto
          ? "Deribit carries crypto options for the majors; routing them through this module is backlog, not a data limitation."
          : "The options chain was not queried for this asset."
      ),
    insiderActivity:
      inputs.insiders ??
      unavailable(
        isCrypto ? "not-applicable" : "no-provider",
        isCrypto
          ? "Insider filings have no crypto equivalent — there is no issuer whose officers file."
          : "Insider filings were not queried for this asset."
      ),
    shortInterest:
      inputs.shortVolume ??
      unavailable(
        isCrypto ? "not-applicable" : "no-provider",
        isCrypto
          ? "Exchange short interest has no direct crypto equivalent; the analogue here is funding and open interest."
          : "Short-sale volume was not queried for this asset."
      ),
  };
}

/**
 * Replay-derived expectations — win rate, expected drawdown, how far winners
 * ran, how long they took.
 *
 * Present only where an execution replay actually exists. For equities it
 * does not, and the distinction the reason draws is the important one: the
 * inputs exist, the study has not been run. Printing a crypto win rate beside
 * an equity plan would be borrowed authority of the worst kind.
 */
function buildExpectations(expectations: PlanExpectations | null, isCrypto: boolean): Read<PlanExpectations> {
  if (expectations) {
    // Replay-backed numbers are MEASURED, not yet validated: the cells are
    // in-sample and re-earn themselves each regeneration. Institutional
    // requires the registered forward hypotheses to accumulate a real
    // out-of-sample record first.
    return available(
      expectations,
      "advanced",
      {
        to: "institutional",
        when: "the registered forward hypotheses accumulate enough out-of-sample days to condition expectations on a forward-tested record rather than an in-sample replay",
      },
      undeclaredEvidence()
    );
  }
  /*
   * The equity replay now EXISTS, so this reason can no longer say it does
   * not. A null here for a stock means something narrower and truer: either
   * the read is not directional (no side, so no bucket), or the replay
   * declined to publish this side-and-volatility cell for thin sample.
   */
  return unavailable(
    "not-measured-yet",
    isCrypto
      ? "No replayed trades match this asset and volatility regime yet, so no expectancy is claimed for it."
      : "The equity replay has no publishable record for this particular side and volatility regime — either the read is not directional, or too few comparable trades exist in that bucket to quote a win rate honestly. Borrowing a neighbouring bucket's number would be worse than saying so."
  );
}

/**
 * The cross-sectional momentum read, as a section.
 *
 * DEPTH IS `advanced`, NOT `institutional`, and the distinction is the point
 * of the ladder. This is backtested on 579 non-overlapping periods with a
 * Wilson bound and an FDR correction — numbers with an n, which is exactly
 * what `advanced` means. `institutional` is reserved for a FORWARD record,
 * and this signal has none yet: it has never made a prediction in public.
 * Promoting it on the strength of a backtest would collapse the one
 * distinction the tier system exists to hold.
 */
function buildValidatedSignal(
  outcome: import("@/lib/signals/equityMomentum").MomentumOutcome | null
): Read<import("@/lib/signals/equityMomentum").MomentumRead> {
  if (!outcome) {
    return unavailable(
      "not-measured-yet",
      "The cross-sectional ranking was not computed for this request."
    );
  }
  if (!outcome.ok) return unavailable(outcome.blockedBy, outcome.reason);

  return available(
    outcome.read,
    "advanced",
    {
      to: "institutional",
      when: "this ranking has published forward calls for long enough to be scored out of sample, the way the daily verdict record already is — a backtest with a lower bound is evidence, but it is not yet a track record",
    },
    undeclaredEvidence()
  );
}

/**
 * Historical analogs — "the last N times this setup occurred".
 *
 * The single most differentiating section on the page, and the one most
 * easily faked. It exists for crypto because 2,896 daily fingerprints were
 * recorded over a replayed history; nothing equivalent exists for equities,
 * so equities get the reason rather than a number.
 */
function buildAnalogs(
  analogs: NeighbourhoodStats | null,
  isCrypto: boolean,
  barsUsed: number,
  blockedReason: string | null
): Read<NeighbourhoodStats> {
  if (analogs) {
    return available(
      analogs,
      "advanced",
      {
        to: "institutional",
        when: "these neighbourhoods are scored against their own post-registration forward record, so the distribution quoted is out-of-sample rather than found in the same history it was measured on",
      },
      undeclaredEvidence()
    );
  }
  if (barsUsed < MIN_BARS_FOR_ANALYSIS) {
    return unavailable(
      "insufficient-history",
      "This asset has too little history for its current setup to have occurred before in any measurable way."
    );
  }
  /*
   * Equity analogs now EXIST, so the reason narrows: a null means this
   * particular combination of direction, volatility regime and entry style
   * had too few replayed occurrences to quote, or there is no plan geometry
   * to read an entry style from.
   */
  return unavailable(
    "not-measured-yet",
    isCrypto
      ? "Fingerprints are built from the equity replay panel; the crypto equivalent is not ingested yet. Backlog, not a data limitation."
      : (blockedReason ??
        "No environment in the fingerprint library sits close enough to today's to be called similar. Widening the match until a number appeared would be choosing the definition that flatters the answer.")
  );
}

/**
 * MONEY FLOW — where capital is actually moving.
 *
 * For crypto this is a genuinely rich category (funding, open interest,
 * basis, spot-vs-perp volume, stablecoin supply). For equities the honest
 * answer today is that the platform sees flow only at the sector and industry
 * level, not at the single-name level, and says so.
 */
function buildMoneyFlow(
  categories: TickerDossier["evidence"],
  isCrypto: boolean
): Read<EvidenceGroup> {
  const group = categories.find((c) => c.label === "Money Flow");
  if (group && group.metrics.length > 0) {
    return available(
      {
        label: group.label,
        score: group.score,
        verdict: group.verdict,
        confidence: group.confidence,
        topReason: group.topReason,
        metrics: group.metrics,
      },
      "advanced",
      {
        to: "institutional",
        when: "options positioning and dealer exposure are ingested, so flow can be confirmed by a second independent source rather than read from one venue family",
      }
    ,
      undeclaredEvidence()
    );
  }
  return unavailable(
    isCrypto ? "no-provider" : "not-measured-yet",
    isCrypto
      ? "No flow module reported for this asset — the derivatives and stablecoin feeds cover the majors only."
      : "Single-name institutional flow needs data this platform does not ingest: 13F holdings, dark-pool prints and options positioning. What IS available is flow at the sector and industry level, in the macro section above — which is where rotation shows up first anyway."
  );
}

/**
 * WHERE THIS BECOMES A TRADE.
 *
 * The section that makes a refusal useful. When the engine will not plan a
 * trade today — which, since the EV gate landed, is most days — this is what
 * a reader is actually left with: the level to wait for, the move required
 * to reach it, the stop that would sit beyond it, and what entries taken
 * that way have historically been worth.
 *
 * Both sides are shown when structure supports both, because knowing where
 * the opposite case begins is how a reader recognises being wrong early.
 */
function buildNextEntry(
  analysis: LiveAnalysis,
  records: { long: AnalogStats | null; short: AnalogStats | null } | null,
  reachOf: ((distanceAtr: number, touches: number, prefer: "plan" | "zone") => PlannedEntry["reach"]) | null,
  forward: ForwardRecordSummary | null
): Read<PlannedEntryRead> {
  /*
   * NEVER "NOTHING TO DO". Structure exists on both sides of price at all
   * times; what varies is whether it is close enough to price a stop
   * against. So the watch levels are computed first and unconditionally,
   * and the conditional entries layer on top when the geometry supports
   * them. A reader always leaves with a price and an odds figure.
   */
  const watchLevels = buildWatchLevels(analysis, reachOf);
  const view = analysis.plannedSetups;

  if (!view || view.setups.length === 0) {
    if (watchLevels.length === 0) {
      return unavailable(
        "insufficient-history",
        "This instrument has not printed enough swing structure to identify a support or resistance level yet — usually a recent listing. There is no level to watch because none has formed, not because none was looked for."
      );
    }
    return available(
      {
        anchorPrice: analysis.lastClose,
        favoured: null,
        rationale: analysis.plan
          ? "Price is already at a tradeable level — the plan above is the entry. The levels below are where the NEXT decision happens if it moves away."
          : "Nothing is close enough to price a stop against yet, so there is no full plan. These are the levels to watch, and how often price has historically reached them.",
        entries: [],
        watchLevels,
        forward,
      },
      "basic",
      {
        to: "advanced",
        when: "planned levels are scored on how often price actually reached them and what happened next, so a conditional entry carries its own hit rate rather than only its geometry",
      },
      undeclaredEvidence()
    );
  }

  const entries: PlannedEntry[] = view.setups.map((s) => {
    const risk = Math.abs(s.plan.entryRef - s.plan.stopPrice);
    const blocked = analysis.plannedGate[s.direction];
    const touches =
      (s.direction === "long" ? s.plan.supportZone : s.plan.resistanceZone)?.reactionCount ?? 0;
    return {
      qualifies: blocked === null,
      blockedReason: blocked ? TRADE_PLAN_REFUSAL_SHORT[blocked] : null,
      reach: reachOf ? reachOf(s.distanceAtr, touches, "plan") : null,
      direction: s.direction,
      status: s.status,
      primary: s.primary,
      trigger: s.trigger,
      triggerPrice: s.triggerPrice,
      distancePct: s.distancePct,
      entryLow: s.plan.entryLow,
      entryHigh: s.plan.entryHigh,
      entryBasis: s.plan.entryBasis,
      stopPrice: s.plan.stopPrice,
      stopBasis: s.plan.stopBasis,
      target1Price: s.plan.target1Price,
      target2Price: s.plan.target2Price,
      target1Pct:
        s.plan.entryRef > 0 ? (Math.abs(s.plan.target1Price - s.plan.entryRef) / s.plan.entryRef) * 100 : 0,
      target2Pct:
        s.plan.entryRef > 0 ? (Math.abs(s.plan.target2Price - s.plan.entryRef) / s.plan.entryRef) * 100 : 0,
      riskRewardRatio: s.plan.riskRewardRatio,
      riskPct: s.plan.entryRef > 0 ? (risk / s.plan.entryRef) * 100 : 0,
      record: records?.[s.direction] ?? null,
    };
  });

  /*
   * Descriptive, and it stays descriptive: these are levels derived from
   * structure, not a forward-tested record of levels being respected. The
   * tier rises only when the reach rate and outcome of PLANNED entries are
   * scored against their own out-of-sample record.
   */
  return available(
    { anchorPrice: view.anchorPrice, favoured: view.favoured, rationale: view.rationale, entries, watchLevels, forward },
    "basic",
    {
      to: "advanced",
      when: "planned levels are scored on how often price actually reached them and what happened next, so a conditional entry carries its own hit rate rather than only its geometry",
    },
    undeclaredEvidence()
  );
}

/**
 * The nearest structure either side of price, at ANY distance.
 *
 * Deliberately unfiltered by the pullback window the planner uses: that
 * window exists to decide whether a STOP can be placed sensibly, which is a
 * different question from whether a level is worth watching. A support six
 * ATR below is still the next place price would find buyers; it just cannot
 * be planned yet, and the odds attached say how rarely price gets there.
 */
function buildWatchLevels(
  analysis: LiveAnalysis,
  reachOf: ((distanceAtr: number, touches: number, prefer: "plan" | "zone") => PlannedEntry["reach"]) | null
): WatchLevel[] {
  const price = analysis.lastClose;
  const atrAbs = analysis.atrPct !== null && price > 0 ? (analysis.atrPct / 100) * price : 0;
  if (price <= 0 || atrAbs <= 0) return [];

  const { support: nearestBelow, resistance: nearestAbove } = nearestWatchLevels(analysis.zones, price);

  const build = (zone: SupportResistanceZone | null, direction: "long" | "short"): WatchLevel | null => {
    if (!zone) return null;
    const level = watchEdge(zone, direction);
    const distanceAtr = Math.abs(price - level) / atrAbs;
    const r = reachOf ? reachOf(distanceAtr, zone.reactionCount, "zone") : null;
    return {
      direction,
      price: level,
      distancePct: (Math.abs(price - level) / price) * 100,
      distanceAtr,
      touches: zone.reactionCount,
      reachRatePct: r?.reachRatePct ?? null,
      medianSessionsToReach: r?.medianSessionsToReach ?? null,
      reachAttempts: r?.attempts ?? null,
    };
  };

  return [build(nearestBelow, "long"), build(nearestAbove, "short")].filter((x): x is WatchLevel => x !== null);
}
