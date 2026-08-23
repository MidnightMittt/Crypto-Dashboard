import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal } from "@/lib/signals/tradePlan";
import { EarningsVetoResult } from "@/lib/markets/earningsVeto";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { RotationState } from "@/lib/markets/rotation";
import { Provenance } from "@/lib/provenance";

/**
 * THE TICKER DOSSIER — one contract for the research page.
 *
 * The page this feeds is meant to be the best place on the internet to decide
 * whether to trade a given symbol. That ambition creates an architectural
 * problem before it creates a design one: BTC arrives with eighteen evidence
 * modules, a derivatives book and 1,198 replayed trades, while a mid-cap
 * equity arrives with six modules and no replay at all. A page written
 * against the richest asset would lie about the thinnest one, and a page
 * written against the thinnest would waste everything the richest has.
 *
 * ── The rule that resolves it ─────────────────────────────────────────
 *
 * EVERY SECTION DECLARES ITS OWN AVAILABILITY. The page renders the same
 * skeleton for every ticker; each section reports whether it has data and,
 * when it does not, WHY NOT. Nothing silently disappears — an absent section
 * that vanishes is indistinguishable from one that was never built, and a
 * reader cannot tell whether "no options data" means calm positioning or no
 * provider.
 *
 * This also makes the roadmap self-documenting: `blockedBy` values are, quite
 * literally, the build queue. Adding a data source fills a slot. It never
 * touches the page.
 */

/**
 * WHY a section has nothing to show. The distinction between these is the
 * honest part — three of them are permanent-ish facts about the world and one
 * is an admission of work not yet done.
 */
export type BlockedBy =
  /** No provider for this data is ingested at all. A sourcing problem. */
  | "no-provider"
  /** Structurally meaningless for this asset class — funding rates on a stock. */
  | "not-applicable"
  /** The asset itself is too young to measure against its own past. */
  | "insufficient-history"
  /**
   * We HAVE the inputs and have not built the study yet. Deliberately
   * distinct from "no-provider": this is our backlog, not the market's
   * limitation, and labelling it as anything else would be self-flattering.
   */
  | "not-measured-yet"
  /**
   * A provider exists and the call failed THIS request. Distinct from
   * "no-provider" because the claims differ: one says we ingest nothing,
   * the other says the source hiccuped and the section will likely be back
   * on the next load.
   */
  | "provider-error";

/**
 * HOW DEEP a section's intelligence currently goes.
 *
 * Availability is not binary and pretending it is couples the UI to today's
 * data reality: the moment the equity replay lands, "expectations" for a
 * stock would jump from a reason-for-absence to a full statistics table, and
 * every such jump would be a page change. Instead each section climbs a
 * ladder the contract already knows about:
 *
 *   basic          DESCRIPTIVE — computed from the asset's own price history
 *                  at request time. True, checkable, no measured record.
 *   advanced       MEASURED — backed by replayed trades, recorded
 *                  fingerprints, or multi-instrument data. Numbers with an n.
 *   institutional  VALIDATED — supported by a forward-tested record or by
 *                  multiple independent sources agreeing. The tier a claim
 *                  must reach before it deserves the word "edge".
 *
 * The tiers are claims about EVIDENCE QUALITY, not about feature polish — a
 * beautifully rendered descriptive read is still basic, and a plain table of
 * forward-validated numbers is still institutional.
 */
export type Depth = "basic" | "advanced" | "institutional";

/**
 * What would lift a section to its next tier. Present on available sections
 * the way `blockedBy` is present on unavailable ones, and for the same
 * reason: every section states its own growth path, so the roadmap stays
 * self-documenting at every level rather than only at zero.
 */
export interface Upgrade {
  /** The tier this would reach. */
  to: Depth;
  /** What has to be built or accumulated first, in plain words. */
  when: string;
}

/**
 * How strongly a module believes its own claim.
 *
 * Two axes, because they fail differently. `grade` is INPUT quality — are the
 * feeds fresh and complete. `validated` is whether the signal works at all
 * out of sample. A pristine reading from a coin flip and a stale reading from
 * a validated module are both bad, in opposite ways, and one number covering
 * both would hide each of them.
 */
export interface Confidence {
  grade: "thin" | "moderate" | "strong";
  validated: EvidenceGrade;
  /** Sample size behind the claim. null means NOT MEASURED — never 0. */
  n: number | null;
}

/**
 * What a module knows, why it believes it, and where it came from.
 *
 * `confidence: null` is a real answer and not a gap: this module reports
 * FACTS and makes no probabilistic claim. Forcing a fundamentals read to
 * invent a grade would fabricate certainty, which is the defect this codebase
 * keeps removing. A null-confidence module must never be summarised as
 * certain by anything downstream.
 */
export interface Evidence {
  confidence: Confidence | null;
  /** Why, in the analyst voice. One clause per claim, never one blob. */
  reasoning: string[];
  /** Where every number came from. See src/lib/provenance.ts. */
  provenance: Provenance[];
}

/**
 * A MODULE'S OUTPUT — the one envelope every module returns.
 *
 * Formerly `Section<T>`. Renamed because "section" now means one of the
 * fourteen named slots on the page (see modules.ts), and a module is what
 * fills one. The word matches vocabulary already in use: TechnicalRead,
 * IndustryRead, LiquidityMapRead.
 */
export type Read<T> =
  | { status: "available"; depth: Depth; data: T; evidence: Evidence; upgrade: Upgrade | null }
  | { status: "unavailable"; reason: string; blockedBy: BlockedBy };

/**
 * Evidence for a module whose provenance has not been wired yet.
 *
 * IT IS A REQUIRED ARGUMENT, not a default, and that is the entire point.
 *
 * It used to be `available()`'s default parameter, which made the gap
 * invisible: `grep undeclaredEvidence` returned zero hits outside this file
 * while eighteen call sites were producing reads with no sourcing at all. A
 * work queue nobody can count is not a work queue. Now every unwired site
 * says so in its own source, so the number is greppable and the ratchet test
 * in evidenceCoverage.test.ts stops it climbing.
 *
 * An empty `provenance: []` reached any other way would be a different and
 * worse claim — "this value has no sources" — which is never true. Every read
 * here comes from somewhere.
 */
export const undeclaredEvidence = (): Evidence => ({
  confidence: null,
  reasoning: [],
  provenance: [],
});

export const unavailable = <T>(blockedBy: BlockedBy, reason: string): Read<T> => ({
  status: "unavailable",
  reason,
  blockedBy,
});

/**
 * `evidence` is REQUIRED and deliberately has no default. A module that has
 * not declared where its numbers came from must say so at the call site,
 * where it is countable, rather than inheriting silence from this signature.
 */
export const available = <T>(
  data: T,
  depth: Depth,
  upgrade: Upgrade | null,
  evidence: Evidence
): Read<T> => ({
  status: "available",
  depth,
  data,
  evidence,
  upgrade,
});

/** Convenience for rendering: the data, or null. Never throws, never fabricates. */
export function dataOf<T>(read: Read<T>): T | null {
  return read.status === "available" ? read.data : null;
}

import { EvidenceGrade } from "@/lib/signals/evidenceGrade";

// ── Section payloads ───────────────────────────────────────────────────

export interface VerdictSection {
  emoji: string;
  word: string;
  tone: string;
  sentence: string;
  action: "buy" | "sell" | "wait" | "stand-aside";
  /** 1-5, magnitude of the read. */
  stars: number;
  evidence: "thin" | "moderate" | "strong";
  agreementLine: string;
  /**
   * What share of THIS verdict's own evidence weight comes from signals that
   * have actually beaten their baseline out of sample.
   *
   * A separate axis from `evidence` above, which grades INPUT QUALITY — are
   * the feeds fresh and complete. This grades whether the signal works at
   * all. A pristine reading from a coin flip and a stale reading from a
   * validated module fail differently, and one number covering both would
   * hide each of them.
   */
  evidenceGrade: EvidenceGrade;
  /**
   * HOW MUCH CONVICTION SHOULD I HAVE — the question a "9.2 / 10" was asked
   * for. A word rather than a decimal, and capped by whether anything behind
   * the read has a forward record, with the cap stated. See conviction.ts.
   */
  conviction: import("@/lib/signals/conviction").Conviction;
  /** How this verdict has actually done since forward scoring began. */
  forward: VerdictForwardRecord | null;
  /**
   * THE MARKET BACKDROP, NAMED AS THE ONE READ IT IS. One sentence, shared
   * by every equity page, shown beside the verdict and never voted into it
   * — a backdrop that voted made 131 of 131 verdicts read bullish on
   * 2026-08-21. Null for crypto and when the shared context is unavailable.
   */
  backdrop: string | null;
}

/**
 * The four-clause summary. Stored as clauses rather than one blob so a
 * surface can render them separately, and so a test can assert that a clause
 * is absent when its evidence is.
 */
export interface TldrSection {
  /** What the market is doing. */
  state: string;
  /** What supports it. Null when nothing does. */
  support: string | null;
  /** What argues against it, and what that implies for entry. Null when nothing does. */
  tension: string | null;
  /**
   * What the options market is PRICING, in its own numbers — the move it
   * expects, whether that is dear or cheap against realised, and notable
   * skew — plus whether its positioning agrees. Null when there is no chain
   * and no lean to report.
   */
  options: string | null;
  /**
   * That coverage has CLUSTERED, when it measurably has. Null on ordinary
   * news flow, which is true of every listed company every day and is not
   * information.
   */
  attention: string | null;
  /** The level that ends the idea. Null when there is no plan to invalidate. */
  invalidation: string | null;
  /** All present clauses joined — the ten-second read. */
  full: string;
}

export interface PlanFieldsSection {
  plan: TradePlan | null;
  refusal: TradePlanRefusal | null;
  /**
   * Replay-derived expectations. Present only where an execution replay
   * exists for the asset class — crypto today, equities once the equity
   * replay is built. Null fields are rendered as "not measured", never as 0.
   */
  expectations: Read<PlanExpectations>;
}

export interface PlanExpectations {
  /** Wilson lower bound of expectancy per trade, in percent. */
  evLowerPct: number;
  /** Point estimate of the win rate for comparable trades. */
  winRatePct: number;
  /** Trades behind the estimate. */
  n: number;
  /** p80 of the drawdown WINNING trades endured before working. */
  expectedDrawdownPct: number;
  /** p75 of how far winners ran. */
  expectedRunPct: number | null;
  /** Median sessions to resolution. */
  medianHoldSessions: number | null;
  /**
   * Average return of a RANDOM entry over the same holding period, on the
   * same universe and window. The baseline expectancy must be judged
   * against; null where no baseline was measured.
   */
  driftNullPct?: number | null;
  /**
   * Expectancy minus that baseline — what the signal actually added. This,
   * not `evLowerPct`, is what the word "edge" is allowed to describe.
   */
  excessEvPct?: number | null;
  /** Which measured bucket produced these. */
  cellKey: string;
}

export interface EvidenceBullet {
  /** Plain-English claim, one line. */
  claim: string;
  /** The module it came from, so it is traceable. */
  metricId: string;
  label: string;
  /** Full explanation for the expandable layer. */
  detail: string;
  /** Evidence quality of the underlying module, 0-100. */
  confidence: number;
}

export interface InvalidationTrigger {
  /** What would have to happen. */
  condition: string;
  /** Why that ends the thesis rather than merely bruising it. */
  consequence: string;
  /** "price" triggers are levels; "evidence" triggers are module flips. */
  kind: "price" | "evidence" | "event";
}

/**
 * A CONDITIONAL ENTRY — where this becomes a trade, whether or not it is one
 * today.
 *
 * Every field is a concrete number or a stated sentence: the level, the move
 * required to reach it, the stop beyond it, the targets, and the historical
 * record of entries taken this way. Nothing here is a hint or a lean — a
 * reader should be able to place a resting order from it and know in advance
 * what the trade is worth and when it is void.
 */
export interface PlannedEntry {
  direction: "long" | "short";
  /** waiting | approaching | at-entry | invalidated. */
  status: string;
  /** True when the higher-timeframe read favours this side. */
  primary: boolean;
  /** What has to happen, in words, with the price kept separate for formatting. */
  trigger: string;
  triggerPrice: number | null;
  /** How far price must travel to reach the zone, as a percent of price. */
  distancePct: number;
  entryLow: number;
  entryHigh: number;
  entryBasis: string;
  stopPrice: number;
  stopBasis: string;
  target1Price: number;
  target2Price: number;
  /** How far each target sits from the entry, in percent — so a level is never a bare price. */
  target1Pct: number;
  target2Pct: number;
  riskRewardRatio: number;
  /** What the plan risks per unit, as a percent of the entry. */
  riskPct: number;
  /** The measured record for entries taken this way, when one exists. */
  record: AnalogStats | null;
  /**
   * True when a trade from this level would clear the same quality bars a
   * live plan must clear. False means the level is real but the trade from
   * it is not yet worth taking — and `blockedReason` says which bar it fails.
   */
  qualifies: boolean;
  blockedReason: string | null;
  /**
   * How often price historically REACHED a level this far away with this
   * many prior touches, and how long it took. The number that says whether
   * waiting for this entry is realistic or wishful.
   */
  reach: {
    reachRatePct: number;
    attempts: number;
    medianSessionsToReach: number | null;
    /** Distance in ATR, so the reader can see what bucket this fell in. */
    distanceAtr: number;
    touches: number;
  } | null;
}

/**
 * A LEVEL WORTH WATCHING when no full plan can be priced yet.
 *
 * There is never "nothing to do" — there is always a nearest level and a
 * measured likelihood of price getting there. What there is not, at
 * distance, is honest stop-and-target geometry: volatility and structure
 * both change on the way, so pricing a stop for a level six ATR away would
 * be arithmetic pretending to be a plan. So this carries the price, the
 * distance, the odds and the wait — and says plainly that the full plan
 * prices itself when price arrives.
 */
export interface WatchLevel {
  direction: "long" | "short";
  /** The price to watch — the near edge of the zone. */
  price: number;
  /** How far away, as a percent of current price. */
  distancePct: number;
  /** The same distance in ATR, which is what the odds are bucketed on. */
  distanceAtr: number;
  /** Swing touches the zone has taken. */
  touches: number;
  reachRatePct: number | null;
  medianSessionsToReach: number | null;
  reachAttempts: number | null;
}

/**
 * The out-of-sample record for the WORD at the top of the page.
 *
 * Carried on the verdict itself rather than tucked into a research section,
 * because a claim and its track record belong in the same place. Until it
 * fills, it says so — and a page that admits its headline is unscored is
 * more trustworthy than one that quietly implies otherwise.
 */
export interface VerdictForwardRecord {
  resolved: number;
  open: number;
  /** Mean forward return of every resolved call — the sample's own drift. */
  baselineReturnPct: number | null;
  /** This verdict's own cell, when enough of them have resolved. */
  mine: {
    verdict: string;
    n: number;
    /** Non-overlapping periods — the honest sample size, usually far below n. */
    independentN?: number;
    /** False when the cell cannot support a claim; the page must then refuse one. */
    publishable?: boolean;
    hitRatePct: number | null;
    meanReturnPct: number;
    edgeVsBaselinePct: number | null;
  } | null;
  horizonSessions: number;
  /**
   * Non-null when the figures describe a RETIRED engine rather than the one
   * whose call is on the page — shown so the record cannot borrow authority
   * from a different claim-maker. See forwardVerdict.ts on engines.
   */
  engineNote: string | null;
}

export interface ForwardRecordSummary {
  /** Predictions whose ten-session horizon has fully elapsed. */
  resolved: number;
  /** What the page promised, averaged over those. */
  predictedPct: number | null;
  /** What actually happened — the only out-of-sample number on this page. */
  observedPct: number | null;
  /** When registration began, so "none yet" reads as young rather than broken. */
  since: string | null;
  /** Registered but not yet finished. These count toward nothing. */
  open: number;
  /**
   * Open predictions whose level has ALREADY traded. Shown so the wait is
   * legible, never as a rate: this cohort's misses cannot exist yet, because
   * a miss takes the full horizon to become one. `openReached / open` is a
   * lower bound climbing toward the truth, not a measurement — and reporting
   * it as one is exactly what published a 100.0% record on 2026-08-16.
   */
  openReached: number;
}

export interface PlannedEntryRead {
  anchorPrice: number;
  favoured: "long" | "short" | null;
  /** Why that side is favoured, or why neither is. */
  rationale: string;
  entries: PlannedEntry[];
  /**
   * Nearest structure either side, ALWAYS populated when zones exist — so a
   * reader is never left without a price to watch, even when nothing is
   * close enough to price a plan against.
   */
  watchLevels: WatchLevel[];
  /**
   * The out-of-sample scorecard for the reach numbers above. Everything else
   * on this page is in-sample; this is the one line that is not.
   */
  forward: ForwardRecordSummary | null;
}

export interface AnalogStats {
  occurrences: number;
  winRatePct: number;
  medianReturnPct: number;
  averageReturnPct: number;
  averageDrawdownPct: number | null;
  medianHoldSessions: number | null;
  /** What made two setups "similar" — stated so the number can be judged. */
  matchBasis: string;
  /** The honest caveat: in-sample, overlapping, or otherwise limited. */
  caveat: string;
}

export interface MacroContext {
  regime: string;
  regimeDetail: string;
  sectorName: string | null;
  sectorState: RotationState | null;
  sectorLine: string | null;
  industryName: string | null;
  industryState: RotationState | null;
  industryLine: string | null;
  industrySlug: string | null;
  /** One sentence combining all of the above for the reader who wants only that. */
  summary: string;
  /**
   * The wider forces: volatility, rates, the dollar, credit — level plus
   * one-month direction, each with its conventional mechanism in "tends to"
   * language. Context sentences; none votes, and the tier does not rise for
   * having them: validated is earned by forward records, not by more inputs.
   */
  backdropLines: string[] | null;
}

export interface EvidenceGroup {
  /** Plain-English category name, e.g. "Trend & Structure". */
  label: string;
  score: number | null;
  verdict: string | null;
  confidence: number;
  topReason: string;
  metrics: MetricVerdict[];
}

export interface IdentitySection {
  symbol: string;
  name: string;
  assetClass: "equity" | "crypto";
  lastClose: number;
  change24hPct: number;
  asOf: number;
  /** Where the numbers came from, so freshness is never implied. */
  provenance: string;
  /** Sessions of history behind the read. */
  barsUsed: number;
}

/**
 * THE DOSSIER. Section order here is the page's reading order, deliberately:
 * decide, then understand, then verify.
 */
export interface TickerDossier {
  identity: IdentitySection;
  verdict: VerdictSection;
  tldr: TldrSection;
  plan: PlanFieldsSection;
  /**
   * The setup checklist. Not a score — a selection over values the engine
   * already measured, headlined by the plan's own backtested star rating.
   */
  checklist: import("./checklist").Checklist;
  /**
   * Conditions under which NOT trading is the decision. Distinct from
   * `invalidation`, which is about exiting a position already taken.
   */
  passRules: import("./passRules").PassRule[];
  /** Everything arguing price RISES — absolute, never swapped to match the verdict. */
  bullCase: EvidenceBullet[];
  /** Everything arguing price FALLS. */
  bearCase: EvidenceBullet[];
  invalidation: InvalidationTrigger[];
  /**
   * How much room a stop needs on THIS name, measured from its own intraday
   * lows rather than chosen as a round number.
   *
   * Sits beside invalidation because they answer adjacent questions:
   * invalidation is where the thesis breaks, this is whether a stop placed
   * there survives ordinary noise. A 5% stop is not a risk setting on a name
   * whose typical session already ranges 9%.
   */
  stopGrid: Read<import("@/lib/research/stopViability").StopGrid>;
  /**
   * The mechanical exit level in DOLLARS — trailing high less 1.5 ATR.
   *
   * Exists because an exit taken with no reference level on screen is a
   * decision made by the tape. One number, visible before the moment arrives.
   */
  trendState: Read<import("@/lib/research/trendState").TrendState>;
  /**
   * Similar historical ENVIRONMENTS, from fingerprint matching. Replaced the
   * broad-bucket analogs, whose "71,585 times seen" counted the same
   * environments thousands of times over.
   */
  analogs: Read<import("@/lib/research/neighbourhood").NeighbourhoodStats>;
  /** Where this becomes a trade, whether or not it is one today. */
  nextEntry: Read<PlannedEntryRead>;
  /**
   * THE ONE EQUITY SIGNAL WITH A MEASURED FORWARD RECORD.
   *
   * Every other equity module here is State: it describes conditions and
   * makes no forecast, which is why the equity composite grades as
   * "descriptive" and why `evidenceGrade` reports 0% validated weight on
   * these pages. This section is the exception and is deliberately kept
   * OUTSIDE the composite — see equityMomentum.ts for why blending it in
   * would either silence it or silence everything else.
   *
   * It is also the section most likely to say nothing, and that is correct:
   * the effect was measured at the extremes of a cross-sectional ranking, so
   * a mid-pack ticker gets an explicit no-claim rather than an interpolated
   * fraction of an edge.
   */
  validatedSignal: Read<import("@/lib/signals/equityMomentum").MomentumRead>;
  /**
   * Downsampled closes, oldest first, for the evidence sparklines.
   *
   * Carried on the dossier rather than refetched by a component because the
   * bars are already in hand at assembly time and a second fetch would be a
   * second opinion about the same prices. Null when the history is too short
   * to draw honestly.
   */
  priceTrail: { closes: number[]; sessions: number } | null;
  macro: Read<MacroContext>;
  evidence: EvidenceGroup[];
  /** Structural context the evidence groups do not cover. */
  earnings: EarningsVetoResult | null;
  zones: SupportResistanceZone[];
  atrPct: number | null;
  bias: MarketBias;

  /*
   * ── Provider-backed sections ─────────────────────────────────────────
   * Each is a typed payload or a stated reason. These were Read<never>
   * placeholders until their providers landed — the page rendered their
   * absence from day one, which is exactly how the contract is meant to
   * work: the slots existed before the data did.
   */
  moneyFlow: Read<EvidenceGroup>;
  /** Audited financials from SEC filings — what the stock is a claim on. */
  business: Read<import("./providers/secFundamentals").FundamentalsSummary>;
  /** Analyst consensus, targets and surprise history — reported opinion, labelled as such. */
  street: Read<import("./providers/nasdaqStreet").StreetSummary>;
  news: Read<import("./providers/attention").NewsSummary>;
  socialSentiment: Read<import("./providers/attention").SocialSummary>;
  optionsFlow: Read<import("./providers/cboeOptions").OptionsSummary>;
  /**
   * What the options market is PRICING, as distinct from what it traded.
   * Separate from `optionsFlow` on purpose: flow is a record of activity
   * (who bought what), while this is a set of forward statements — the move
   * being priced, where hedging sits, whether the chain agrees with the
   * chart. They answer different questions and come from different venues,
   * so merging them would blur which claim rests on which source.
   */
  optionsIntel: Read<import("./providers/optionsIntelligence").OptionsIntelligence>;
  insiderActivity: Read<import("./providers/edgarInsiders").InsiderSummary>;
  shortInterest: Read<import("./providers/finraShortVolume").ShortVolumeSummary>;
  /**
   * Relevant EDGAR filings accepted since the prior session's close.
   *
   * The catalyst class that decides an overnight hold: a filing accepted
   * after the close is precisely the event a position cannot react to,
   * because the stop is a statement about continuous tape and the tape is
   * closed. An empty list from a SUCCESSFUL fetch is a real answer — nothing
   * was filed — which is why this is a Read and not a bare array.
   */
  catalysts: Read<import("./providers/edgarCatalysts").CatalystFiling[]>;
  /**
   * Whether the daily pipeline behind every number on this page actually ran.
   *
   * Not a diagnostic for us — a trust input for the reader. It exists because
   * the pipeline stopped for days and nothing on the site said so.
   */
  liveness: Read<import("./pipelineLiveness").LivenessRead>;
}
