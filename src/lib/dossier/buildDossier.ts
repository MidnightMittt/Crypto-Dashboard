import { LiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "@/lib/search/liveAnalysis";
import { equityVerdict } from "@/lib/markets/equityVerdict";
import { nearestWatchLevels, SupportResistanceZone, watchEdge } from "@/lib/technicals/marketStructure";
import { TRADE_PLAN_REFUSAL_SHORT } from "@/lib/signals/tradePlan";
import { describeAgreement, evidenceLevel, strengthStars } from "@/lib/signals/plainLanguage";
import { buildMacroContext } from "./macroContext";
import { composeInvalidation, composeReasonsAgainst, composeReasonsFor, composeTldr } from "./narrative";
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
  Section,
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

export interface DossierInputs {
  analysis: LiveAnalysis;
  regime: RegimeRead | null;
  rotation: RotationRead | null;
  industries: IndustryRead[];
  /** Replay-derived expectations, when the asset class has an execution replay. */
  expectations?: PlanExpectations | null;
  /** Historical analogs, when fingerprints exist for the asset. */
  analogs?: AnalogStats | null;
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
  /*
   * Provider-backed sections, already shaped by the caller (analyseTicker
   * maps each provider result to a Section with its depth and upgrade).
   * Undefined means the caller did not attempt the provider — the defaults
   * below state why per asset class.
   */
  options?: TickerDossier["optionsFlow"];
  insiders?: TickerDossier["insiderActivity"];
  shortVolume?: TickerDossier["shortInterest"];
  newsSection?: TickerDossier["news"];
  social?: TickerDossier["socialSentiment"];
  business?: TickerDossier["business"];
  street?: TickerDossier["street"];
  /** Volatility/rates/dollar/credit sentences, threaded into the macro section. */
  backdropLines?: string[] | null;
}

export function buildDossier(inputs: DossierInputs): TickerDossier {
  const { analysis, regime, rotation, industries } = inputs;
  const { bias, plan } = analysis;
  const isCrypto = analysis.assetClass === "crypto";

  const verdict = equityVerdict({
    bias,
    plan,
    refusal: analysis.planRefusal,
    earningsDate: analysis.earnings?.date ?? null,
  });

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
      forward: inputs.verdictForward ?? null,
    },

    tldr: composeTldr({ bias, plan, symbol: analysis.symbol, name: analysis.name }),

    plan: {
      plan,
      refusal: analysis.planRefusal,
      expectations: buildExpectations(inputs.expectations ?? null, isCrypto),
    },

    reasonsFor: composeReasonsFor(bias),
    reasonsAgainst: composeReasonsAgainst(bias),
    invalidation: composeInvalidation({ bias, plan, earningsDate: analysis.earnings?.date ?? null }),

    analogs: buildAnalogs(inputs.analogs ?? null, isCrypto, analysis.barsUsed),

    nextEntry: buildNextEntry(analysis, inputs.plannedRecords ?? null, inputs.reachOf ?? null, inputs.forward ?? null),

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
    street:
      inputs.street ??
      unavailable(
        isCrypto ? "not-applicable" : "no-provider",
        isCrypto
          ? "Sell-side analyst coverage in the equity sense does not exist for crypto assets."
          : "Analyst coverage was not queried for this asset."
      ),

    news:
      inputs.newsSection ??
      unavailable("no-provider", "The news feed was not queried for this asset."),
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
function buildExpectations(expectations: PlanExpectations | null, isCrypto: boolean): Section<PlanExpectations> {
  if (expectations) {
    // Replay-backed numbers are MEASURED, not yet validated: the cells are
    // in-sample and re-earn themselves each regeneration. Institutional
    // requires the registered forward hypotheses to accumulate a real
    // out-of-sample record first.
    return available(expectations, "advanced", {
      to: "institutional",
      when: "the registered forward hypotheses accumulate enough out-of-sample days to condition expectations on a forward-tested record rather than an in-sample replay",
    });
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
 * Historical analogs — "the last N times this setup occurred".
 *
 * The single most differentiating section on the page, and the one most
 * easily faked. It exists for crypto because 2,896 daily fingerprints were
 * recorded over a replayed history; nothing equivalent exists for equities,
 * so equities get the reason rather than a number.
 */
function buildAnalogs(analogs: AnalogStats | null, isCrypto: boolean, barsUsed: number): Section<AnalogStats> {
  if (analogs) {
    return available(analogs, "advanced", {
      to: "institutional",
      when: "analog outcomes are scored against their own post-registration forward record, so the win rate quoted is out-of-sample rather than found in the same history it is measured on",
    });
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
      ? "No sufficiently similar historical setup was found for this asset. A thin match is worse than none — a win rate from six occurrences is noise with a decimal point."
      : "Too few replayed setups match this one on all three counts — direction, volatility regime and entry style — to quote a win rate honestly, or there is no plan geometry to read an entry style from. Widening the match until a number appeared would be choosing the definition that flatters the answer."
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
): Section<EvidenceGroup> {
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
): Section<PlannedEntryRead> {
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
      }
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
  return available({ anchorPrice: view.anchorPrice, favoured: view.favoured, rationale: view.rationale, entries, watchLevels, forward }, "basic", {
    to: "advanced",
    when: "planned levels are scored on how often price actually reached them and what happened next, so a conditional entry carries its own hit rate rather than only its geometry",
  });
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
