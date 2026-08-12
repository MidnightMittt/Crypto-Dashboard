/**
 * Ranks the tracked universe by how strong an opportunity the DECISION ENGINE
 * currently sees — not by any indicator.
 *
 * NO NEW MATH. Every input is an existing production output of
 * `getAssetComposite`, which itself calls the same `getAggregateForAsset`
 * the single-asset page reads. This file only orders what the engine has
 * already concluded; it never re-derives a score, a verdict or a confidence.
 *
 * WHY CONVICTION x CONFIDENCE, and nothing else.
 *
 * The ranking deliberately multiplies two quantities the engine already
 * publishes:
 *
 *   conviction  = |score - 50|, how far off the fence the read sits
 *   confidence  = how good the evidence behind that read is
 *
 * A product, not a sum, because both must be present for an opportunity to
 * be real. A hugely directional read backed by thin evidence is a guess; a
 * beautifully evidenced read that concludes "flat" is not a trade. Summing
 * would let either one carry the other, which is exactly the failure mode a
 * ranked list must not have at the top of the page.
 *
 * Deliberately NOT ranked by trend alignment. The cross-asset replication
 * study (docs/TREND_PERSISTENCE_REPLICATION.md) retired the finding that a
 * higher-timeframe directional read persists beyond what a moving average
 * mechanically produces, so ranking on trend would be ranking on an artefact.
 * Evidence strength survived that test; trend persistence did not.
 */

/** Which universe a row came from. Display and filtering only — never scoring. */
export type AssetClass = "crypto" | "equity";

/**
 * A tradeable plan the engine has already produced, summarised for ranking.
 *
 * `state` distinguishes the two genuinely different things a plan can be:
 * ACTIVE means a thesis has fired and the trade is live logic; PLANNED means
 * the geometry exists and is waiting for price to reach it. Collapsing them
 * would put "act now" and "watch this level" in the same bucket, which is
 * the single most decision-relevant distinction a scanner can draw.
 */
export interface SetupSummary {
  state: "active" | "planned";
  direction: "long" | "short";
  /** Reward-to-risk measured from the real entry, straight off the plan. */
  riskReward: number;
  /** 1-5 entry-quality rating, straight off the plan. Never recomputed here. */
  stars: number;
  /** The plan's own lifecycle word, e.g. "WAITING", "AT ENTRY". */
  status: string;
}

/**
 * The minimum a market must publish to be rankable.
 *
 * Deliberately structural rather than a class hierarchy: `AssetComposite`
 * satisfies it as-is, and the equity snapshot's `MarketDecision` maps onto it
 * with no adapter beyond field selection. Everything optional is genuinely
 * optional — a universe that cannot supply agreement should be ranked without
 * it, not given a fabricated value.
 */
export interface ScannableMarket {
  asset: string;
  score: number;
  verdict: string;
  confidence: number;
  priceChange24hPct: number;
  headline: string;
  name?: string;
  assetClass?: AssetClass;
  agreement?: number;
  riskLevel?: string;
  setup?: SetupSummary | null;
  /** The engine's own top explanations, agreeing and opposing. Verbatim. */
  reasonsFor?: string[];
  reasonsAgainst?: string[];
}

export interface RankedOpportunity {
  asset: string;
  name?: string;
  assetClass?: AssetClass;
  agreement?: number;
  riskLevel?: string;
  setup?: SetupSummary | null;
  reasonsFor?: string[];
  reasonsAgainst?: string[];
  /** 0-100, the engine's directional score. Passed through untouched. */
  score: number;
  verdict: string;
  confidence: number;
  priceChange24hPct: number;
  headline: string;
  /** |score - 50|, 0-50. How far the engine is from the fence. */
  conviction: number;
  /**
   * conviction x confidence, normalised to 0-100 so it reads as a percentage
   * of the strongest opportunity the engine could theoretically express
   * (maximum conviction of 50 at 100% confidence).
   */
  opportunity: number;
  direction: "long" | "short" | "none";
}

/** The maximum `conviction * confidence` product, used to normalise onto 0-100. */
const MAX_PRODUCT = 50 * 100;

/**
 * Below this, "which is higher" is noise rather than signal. Such assets are
 * still returned — hiding them would misrepresent the universe — but a caller
 * can render them as a quiet tail rather than as ranked opportunities.
 */
export const ACTIONABLE_OPPORTUNITY = 10;

export function rankOpportunities(composites: ScannableMarket[]): RankedOpportunity[] {
  return composites
    .map((c) => {
      const conviction = Math.abs(c.score - 50);
      return {
        asset: c.asset,
        name: c.name,
        assetClass: c.assetClass,
        agreement: c.agreement,
        riskLevel: c.riskLevel,
        setup: c.setup,
        reasonsFor: c.reasonsFor,
        reasonsAgainst: c.reasonsAgainst,
        score: c.score,
        verdict: c.verdict,
        confidence: c.confidence,
        priceChange24hPct: c.priceChange24hPct,
        headline: c.headline,
        conviction,
        opportunity: Math.round((conviction * c.confidence * 100) / MAX_PRODUCT),
        direction: directionOf(c.verdict),
      };
    })
    .sort((a, b) =>
      // Ties broken by conviction then alphabetically, so the order is stable
      // across refreshes rather than dependent on fetch completion order — a
      // list that reshuffles on every poll cannot be read.
      b.opportunity - a.opportunity || b.conviction - a.conviction || a.asset.localeCompare(b.asset)
    );
}

function directionOf(verdict: string): "long" | "short" | "none" {
  if (verdict === "bullish") return "long";
  if (verdict === "bearish") return "short";
  return "none";
}

/* ── SCANNER SORTING AND FILTERING ─────────────────────────────────────
 *
 * Every option below reads a field the ENGINE published. There is no
 * "momentum" sort, no "volume" sort and no composite of my own invention —
 * a scanner that ranks on something the decision surface does not show would
 * be a second opinion competing with the first, and the top row of a ranked
 * list is the most consequential opinion in the product.
 *
 * Sorts that depend on an OPTIONAL field (agreement, risk/reward, quality)
 * put rows lacking it at the bottom rather than treating a missing value as
 * zero. Absent and worst are different, and only one of them is a fact.
 */

export type ScanSort = "opportunity" | "confidence" | "agreement" | "riskReward" | "quality" | "conviction";

export const SCAN_SORT_LABELS: Record<ScanSort, string> = {
  opportunity: "Best setups",
  confidence: "Highest confidence",
  agreement: "Strongest agreement",
  riskReward: "Risk / reward",
  quality: "Setup quality",
  conviction: "Furthest from neutral",
};

export type ScanFilter =
  | "bullish"
  | "bearish"
  | "neutral"
  | "highConfidence"
  | "swingReady"
  | "noSetup"
  | "crypto"
  | "equity";

export const SCAN_FILTER_LABELS: Record<ScanFilter, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
  highConfidence: "High confidence",
  swingReady: "Swing ready",
  noSetup: "No setup",
  crypto: "Crypto",
  equity: "Equities",
};

/**
 * The confidence at or above which a read counts as well-evidenced.
 *
 * Set to 50 because that is the midpoint of the published scale, not because
 * anything was calibrated to it. Stated plainly rather than dressed up: no
 * study in this repository establishes a confidence level above which
 * outcomes measurably improve, and the agreement-quartile section of the
 * backtest report is the closest thing, which tests a different axis.
 */
export const HIGH_CONFIDENCE = 50;

/** Filters within a group are OR'd; groups are AND'd. */
const FILTER_GROUPS: ScanFilter[][] = [
  ["bullish", "bearish", "neutral"],
  ["highConfidence"],
  ["swingReady", "noSetup"],
  ["crypto", "equity"],
];

function matches(row: RankedOpportunity, filter: ScanFilter): boolean {
  switch (filter) {
    case "bullish":
      return row.verdict === "bullish";
    case "bearish":
      return row.verdict === "bearish";
    case "neutral":
      return row.verdict === "neutral";
    case "highConfidence":
      return row.confidence >= HIGH_CONFIDENCE;
    case "swingReady":
      return row.setup != null;
    case "noSetup":
      return row.setup == null;
    case "crypto":
      return row.assetClass === "crypto";
    case "equity":
      return row.assetClass === "equity";
  }
}

export function filterMarkets(rows: RankedOpportunity[], active: ScanFilter[]): RankedOpportunity[] {
  if (active.length === 0) return rows;
  return rows.filter((row) =>
    FILTER_GROUPS.every((group) => {
      const chosen = group.filter((f) => active.includes(f));
      return chosen.length === 0 || chosen.some((f) => matches(row, f));
    })
  );
}

/** Sorted copy. Ties always fall through to the default order, so it is stable. */
export function sortMarkets(rows: RankedOpportunity[], sort: ScanSort): RankedOpportunity[] {
  const defaultOrder = (a: RankedOpportunity, b: RankedOpportunity) =>
    b.opportunity - a.opportunity || b.conviction - a.conviction || a.asset.localeCompare(b.asset);

  // -1 sorts a row with no value for this key below every row that has one.
  const key = (r: RankedOpportunity): number => {
    switch (sort) {
      case "opportunity":
        return r.opportunity;
      case "confidence":
        return r.confidence;
      case "conviction":
        return r.conviction;
      case "agreement":
        return r.agreement ?? -1;
      case "riskReward":
        return r.setup?.riskReward ?? -1;
      case "quality":
        return r.setup?.stars ?? -1;
    }
  };

  return [...rows].sort((a, b) => key(b) - key(a) || defaultOrder(a, b));
}

/* ── WHY IS #1 ABOVE #2? ───────────────────────────────────────────────
 *
 * The question every ranked list invites and almost none answers. A user
 * who cannot see why the order is what it is has to take it on trust, and a
 * list taken on trust is indistinguishable from a list that is wrong.
 *
 * This is an EXACT decomposition, not a narrative fitted after the fact.
 * `opportunity` is a product — conviction x confidence — so taking logs
 * turns the gap into a sum:
 *
 *   log(oppA) - log(oppB) = log(convA/convB) + log(confA/confB)
 *
 * The two terms are the entire difference, and their relative size says
 * precisely how much of the gap each factor explains. No weighting is
 * chosen here; the split falls out of the arithmetic the ranking already
 * uses. When one term is negative the factor is a DRAG — the leader is
 * ahead despite it — which is the most decision-relevant thing the
 * comparison can surface, and a hand-written explanation would gloss it.
 */

export interface RankingFactor {
  label: string;
  leadValue: string;
  rivalValue: string;
  /** Share of the ranking gap this factor explains, 0-100. Negative share means it works AGAINST the leader. */
  sharePct: number;
  favoursLeader: boolean;
}

export interface RankingComparison {
  lead: string;
  rival: string;
  /** One sentence naming the dominant driver. */
  summary: string;
  factors: RankingFactor[];
  /** True when the two are close enough that the order is not meaningful. */
  tooClose: boolean;
}

/** Below this gap in opportunity points, calling one "better" overstates the engine. */
export const MEANINGFUL_RANK_GAP = 3;

export function explainRanking(lead: RankedOpportunity, rival: RankedOpportunity): RankingComparison | null {
  if (lead.opportunity <= 0 || rival.opportunity <= 0) return null;

  const convTerm = Math.log(lead.conviction / rival.conviction);
  const confTerm = Math.log(lead.confidence / rival.confidence);
  const total = Math.abs(convTerm) + Math.abs(confTerm);
  if (!Number.isFinite(total) || total === 0) return null;

  const share = (term: number) => Math.round((term / total) * 100);

  const factors: RankingFactor[] = [
    {
      label: "Conviction",
      leadValue: `${lead.conviction} from neutral`,
      rivalValue: `${rival.conviction} from neutral`,
      sharePct: share(convTerm),
      favoursLeader: convTerm > 0,
    },
    {
      label: "Evidence quality",
      leadValue: `${lead.confidence}% confidence`,
      rivalValue: `${rival.confidence}% confidence`,
      sharePct: share(confTerm),
      favoursLeader: confTerm > 0,
    },
  ].sort((a, b) => Math.abs(b.sharePct) - Math.abs(a.sharePct));

  const dominant = factors[0];
  const other = factors[1];
  const tooClose = lead.opportunity - rival.opportunity < MEANINGFUL_RANK_GAP;

  const summary = tooClose
    ? `${lead.asset} and ${rival.asset} are within ${MEANINGFUL_RANK_GAP} points of each other. The order between them is not a meaningful distinction — treat them as tied.`
    : other.favoursLeader
      ? `${lead.asset} leads on ${dominant.label.toLowerCase()} (${Math.abs(dominant.sharePct)}% of the gap), and ${other.label.toLowerCase()} agrees.`
      : `${lead.asset} leads entirely on ${dominant.label.toLowerCase()}. Its ${other.label.toLowerCase()} is actually WEAKER than ${rival.asset}'s — it ranks higher in spite of that, not because of it.`;

  return { lead: lead.asset, rival: rival.asset, summary, factors, tooClose };
}
