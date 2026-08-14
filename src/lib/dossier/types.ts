import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal } from "@/lib/signals/tradePlan";
import { EarningsVetoResult } from "@/lib/markets/earningsVeto";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { RotationState } from "@/lib/markets/rotation";

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

export type Section<T> =
  | { status: "available"; depth: Depth; data: T; upgrade: Upgrade | null }
  | { status: "unavailable"; reason: string; blockedBy: BlockedBy };

export const unavailable = <T>(blockedBy: BlockedBy, reason: string): Section<T> => ({
  status: "unavailable",
  reason,
  blockedBy,
});

export const available = <T>(data: T, depth: Depth = "basic", upgrade: Upgrade | null = null): Section<T> => ({
  status: "available",
  depth,
  data,
  upgrade,
});

/** Convenience for rendering: the data, or null. Never throws, never fabricates. */
export function dataOf<T>(section: Section<T>): T | null {
  return section.status === "available" ? section.data : null;
}

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
  expectations: Section<PlanExpectations>;
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
}

export interface PlannedEntryRead {
  anchorPrice: number;
  favoured: "long" | "short" | null;
  /** Why that side is favoured, or why neither is. */
  rationale: string;
  entries: PlannedEntry[];
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
  reasonsFor: EvidenceBullet[];
  reasonsAgainst: EvidenceBullet[];
  invalidation: InvalidationTrigger[];
  analogs: Section<AnalogStats>;
  /** Where this becomes a trade, whether or not it is one today. */
  nextEntry: Section<PlannedEntryRead>;
  macro: Section<MacroContext>;
  evidence: EvidenceGroup[];
  /** Structural context the evidence groups do not cover. */
  earnings: EarningsVetoResult | null;
  zones: SupportResistanceZone[];
  atrPct: number | null;
  bias: MarketBias;

  /*
   * ── Provider-backed sections ─────────────────────────────────────────
   * Each is a typed payload or a stated reason. These were Section<never>
   * placeholders until their providers landed — the page rendered their
   * absence from day one, which is exactly how the contract is meant to
   * work: the slots existed before the data did.
   */
  moneyFlow: Section<EvidenceGroup>;
  /** Audited financials from SEC filings — what the stock is a claim on. */
  business: Section<import("./providers/secFundamentals").FundamentalsSummary>;
  /** Analyst consensus, targets and surprise history — reported opinion, labelled as such. */
  street: Section<import("./providers/nasdaqStreet").StreetSummary>;
  news: Section<import("./providers/attention").NewsSummary>;
  socialSentiment: Section<import("./providers/attention").SocialSummary>;
  optionsFlow: Section<import("./providers/cboeOptions").OptionsSummary>;
  insiderActivity: Section<import("./providers/edgarInsiders").InsiderSummary>;
  shortInterest: Section<import("./providers/finraShortVolume").ShortVolumeSummary>;
}
