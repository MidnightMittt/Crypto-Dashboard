import { TradePlan, TradeDirection } from "../signals/tradePlan";
import { SupportResistanceZone } from "../technicals/marketStructure";
import { ConfluenceAssessment, MaTrendContext } from "../technicals/confluence";
import { FibLegResult } from "../technicals/fibonacci";

/**
 * THE SWING SUBSYSTEM — the operational layer above the technical engine.
 *
 * Everything here WRAPS existing modules; nothing replaces them.
 * `tradePlan.ts` still builds entries, structural stops and its two targets;
 * `plannedSetup.ts` still owns the pre-entry level states. This layer adds
 * what an operational bot needs on top: a third target, position sizing,
 * a lifecycle that survives across scans, and paper execution.
 *
 * ── CONFLUENCE IS NOT AN ENTRY SIGNAL ───────────────────────────────────
 *
 * The single most important rule in this file. A weekly support overlapping a
 * monthly level, the 200 EMA and a 0.618 retracement is an excellent WATCH.
 * It is not a long. Price has demonstrated nothing yet.
 *
 * That is why `SetupState` separates the level from the trade, and why
 * `ENTRY_CONFIRMED` requires a price-action trigger that confluence alone can
 * never satisfy. The project's own research is the reason: isolated levels
 * measured at their null across 9 years, and confluence-by-tag-count measured
 * flat across 10,000 trades. Structure tells you WHERE to look. Only price
 * tells you WHEN.
 */

/**
 * The full lifecycle. The first four are LEVEL states (pre-entry) and map onto
 * plannedSetup.ts's existing `waiting | approaching | at-entry | invalidated`;
 * the rest are POSITION states, which plannedSetup deliberately does not model.
 */
export type SetupState =
  | "WATCHING"               // an interesting technical area exists
  | "APPROACHING"            // price is moving toward the planned entry
  | "WAITING_CONFIRMATION"   // price is AT the area; the trigger has not fired
  | "ENTRY_CONFIRMED"        // the predefined trigger has fired
  | "ACTIVE"                 // position entered
  | "PARTIALLY_EXITED"       // at least one target filled
  | "COMPLETED"              // flat
  | "INVALIDATED";           // the thesis is gone

export const PRE_ENTRY_STATES: SetupState[] = [
  "WATCHING", "APPROACHING", "WAITING_CONFIRMATION", "ENTRY_CONFIRMED",
];

/** What price must actually DO before an entry is allowed. Confluence cannot satisfy these. */
export type TriggerKind =
  | "reclaim"            // closed back above a lost level
  | "rejection"          // wicked into the zone and closed away from it
  | "retest-hold"        // broke a level, came back, held it
  | "breakout-close"     // closed beyond the zone with conviction
  | "none";

export interface EntryTrigger {
  kind: TriggerKind;
  /** Plain-English: what has to happen. Never embeds a formatted price. */
  description: string;
  /** The price the description refers to, unformatted. */
  price: number | null;
  /** Has it already happened on the last closed bar? */
  satisfied: boolean;
}

export interface SwingTarget {
  price: number;
  /** Why this price — a structural level, a fib extension, or an ATR fallback. */
  basis: string;
  /** Reward in R (multiples of the entry-to-stop distance). */
  rMultiple: number;
  /** Fraction of the position to close here, from RiskConfig.scaleOut. */
  closeFraction: number;
}

export interface SwingSetupQuality {
  /** Independent confluence families agreeing. NOT a win probability. */
  familyCount: number;
  quality: ConfluenceAssessment["quality"];
  /** Higher-timeframe trend agrees with the trade direction. */
  htfAligned: boolean;
  /** Ranking score. Explicitly NOT calibrated to any win rate — see rankScore(). */
  score: number;
  /** Why it ranks where it does. */
  reasons: string[];
  /** What is still missing before entry. */
  missing: string[];
}

export interface SwingOpportunity {
  /**
   * Stable identity across scans. A setup must not become a "new" opportunity
   * every poll — that is how duplicate alerts and duplicate entries happen.
   * Derived from asset + direction + the zone it is built on, rounded, so
   * small zone drift does not mint a new id.
   */
  id: string;
  asset: string;
  direction: TradeDirection;
  state: SetupState;
  price: number;
  plan: TradePlan;
  targets: SwingTarget[];
  trigger: EntryTrigger;
  quality: SwingSetupQuality;
  zone: SupportResistanceZone | null;
  confluence: ConfluenceAssessment;
  trend: MaTrendContext;
  fib: FibLegResult | null;
  /** Distance from price to the entry zone, in ATRs. */
  distanceAtr: number;
  /** Position sizing, or the reason there is none. */
  sizing: PositionSizing | null;
  /** Set when a risk rule forbids this trade. */
  riskRefusal: string | null;
  /**
   * Set when the opposite direction on the SAME asset is also confirmed.
   *
   * Price sitting between a confirmed long level and a confirmed short level
   * is not two opportunities — it is an ambiguous market, and presenting both
   * as actionable is incoherent advice. The risk layer already refuses to hold
   * both; this surfaces it BEFORE the button is pressed rather than after.
   */
  conflictsWith: string | null;
  builtAt: number;
}

// ── RISK ──────────────────────────────────────────────────────────────────

/**
 * All conservative by default and all configurable, per the requirement not
 * to hardcode aggressive assumptions. Nothing here is tuned to a backtest.
 */
export interface RiskConfig {
  accountEquity: number;
  /** Fraction of equity risked per trade. 0.005 = 0.5%. */
  maxRiskPerTrade: number;
  maxSimultaneousPositions: number;
  /** Total open risk as a fraction of equity. */
  maxPortfolioRisk: number;
  /** Max positions sharing a correlation group (e.g. all majors). */
  maxCorrelatedPositions: number;
  /** Stop recommending after this much realised loss in a day / week, as a fraction of equity. */
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  /** Plans below this R:R are refused. */
  minRiskReward: number;
  /** What fraction of the position closes at TP1 / TP2 / TP3. Must sum to <= 1. */
  scaleOut: [number, number, number];
  /** Taker fee per side, as a fraction. */
  feeRate: number;
  /** Assumed adverse slippage per fill, as a fraction. */
  slippageRate: number;
  /**
   * When true, the scanner opens PAPER positions by itself for confirmed,
   * risk-passing, non-conflicted setups.
   *
   * DEFAULT FALSE. Manual approval is the default mode by instruction, and an
   * auto-trader that is on unless you turn it off is the kind that runs when
   * you did not mean it to. This flag only ever opens PAPER positions — there
   * is no brokerage code path anywhere under lib/swing/ for it to reach.
   */
  autoPaper: boolean;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  accountEquity: 10_000,
  maxRiskPerTrade: 0.005,        // 0.5% — deliberately conservative
  maxSimultaneousPositions: 5,
  maxPortfolioRisk: 0.02,        // 2% total open risk
  maxCorrelatedPositions: 2,
  maxDailyLoss: 0.02,
  maxWeeklyLoss: 0.05,
  minRiskReward: 1.5,
  scaleOut: [0.4, 0.35, 0.25],
  feeRate: 0.0005,               // 5bp
  slippageRate: 0.0005,          // 5bp
  autoPaper: false,              // manual approval until deliberately enabled
};

export interface PositionSizing {
  /** Units of the asset. */
  quantity: number;
  notional: number;
  /** Capital at risk if the stop fills exactly, before fees. */
  riskAmount: number;
  riskPctOfEquity: number;
  /** Distance from entry to stop, as a fraction of entry. */
  stopDistancePct: number;
  explanation: string;
}

// ── PAPER TRADING ─────────────────────────────────────────────────────────

export type FillReason = "entry" | "tp1" | "tp2" | "tp3" | "stop" | "manual";

export interface PaperFill {
  t: number;
  reason: FillReason;
  price: number;
  quantity: number;
  fee: number;
  /** Realised P&L contributed by this fill, net of its fee. Zero for the entry. */
  realisedPnl: number;
  note?: string;
}

export interface PaperPosition {
  id: string;
  opportunityId: string;
  asset: string;
  direction: TradeDirection;
  state: SetupState;
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  stopPrice: number;
  targets: SwingTarget[];
  fills: PaperFill[];
  realisedPnl: number;
  /** The technical case as it stood at entry — frozen, never recomputed. */
  thesis: {
    reasons: string[];
    familyCount: number;
    htfAligned: boolean;
    trendDirection: string;
    entryBasis: string;
    stopBasis: string;
  };
}
