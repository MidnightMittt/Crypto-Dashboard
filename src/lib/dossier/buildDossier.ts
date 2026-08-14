import { LiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "@/lib/search/liveAnalysis";
import { equityVerdict } from "@/lib/markets/equityVerdict";
import { describeAgreement, evidenceLevel, strengthStars } from "@/lib/signals/plainLanguage";
import { buildMacroContext } from "./macroContext";
import { composeInvalidation, composeReasonsAgainst, composeReasonsFor, composeTldr } from "./narrative";
import {
  AnalogStats,
  available,
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
  return unavailable(
    "not-measured-yet",
    isCrypto
      ? "No replayed trades match this asset and volatility regime yet, so no expectancy is claimed for it."
      : "There is no equity execution replay yet, so win rate, expected drawdown, how far comparable trades ran and how long they took are NOT measured for stocks. The geometry below is sound; the expectations around it are simply not yet earned. Building this replay is the next major piece of work."
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
  return unavailable(
    "not-measured-yet",
    isCrypto
      ? "No sufficiently similar historical setup was found for this asset. A thin match is worse than none — a win rate from six occurrences is noise with a decimal point."
      : "Historical setup matching runs on recorded daily fingerprints, and those exist only for the crypto majors so far. There is no equity fingerprint history yet, so no win rate, median return or holding time can be quoted for this ticker. Quoting one from a different asset class would be fabrication."
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
