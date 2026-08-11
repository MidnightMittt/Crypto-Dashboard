/**
 * The swing-thesis state machine — the one stateful layer in an otherwise
 * stateless decision engine.
 *
 * WHY THIS EXISTS. Measured on production `biasTimeline` before this module
 * was written: 7.4 verdict flips per day, 8.4 regime flips per day, with 60%
 * of observations sitting within 3 points of a verdict boundary. A recorded
 * 90-minute stretch read 61 bullish → 53 neutral → 61 bullish → 53 neutral.
 * For a trader holding days-to-weeks that is noise presented as decisions.
 *
 * The cause was never a bad indicator. It was that ~58% of the composite
 * score is recomputed on a 15-second poll, and three separate boundaries
 * (`verdictFromScore`, `dominant`, and `technicalAgreement`, which is
 * coupled to `dominant`) each had a ZERO deadband. Nothing in the decision
 * path remembered its previous answer, so there was no memory to be patient
 * with.
 *
 * THE LOAD-BEARING DESIGN DECISION. This reducer accepts exactly two kinds
 * of event:
 *
 *   - `applyDailyClose` — the ONLY thing that may create, replace or retire
 *     a thesis. Soft evidence (scores, technicals, agreement) is sampled
 *     here and nowhere else.
 *   - `applyTick`       — may only move the plan's STATUS along its
 *     lifecycle in response to price. It can never change direction, build
 *     a plan, or resurrect a retired one.
 *
 * Because only daily closes carry soft evidence, ticking this 5,760 times a
 * day in production and once a day in the backtest produce the IDENTICAL
 * thesis trajectory. That is what makes a stateful engine backtestable at
 * all, and it is why the split is worth the extra type surface. It also
 * satisfies the brief's "no artificial time lock" rule for free: a daily
 * close is a market event, not a timer.
 *
 * Everything here is pure. Persistence lives in
 * `src/lib/history/swingThesisStore.ts`; the backtest threads the same state
 * through its own loop. One reducer, two callers, no second implementation.
 */

import { MarketBias, Verdict } from "./types";
import { EntryQualityInputs } from "./entryQuality";
import { TradePlan, TradePlanConfig, buildTradePlan } from "./tradePlan";
import type { PlannedSetupsFrozen } from "./plannedSetup";
import { TechnicalAgreement } from "@/lib/sentiment/technicals";

export type { TradePlan } from "./tradePlan";
export { buildEntryZone } from "./tradePlan";

export type SwingDirection = "long" | "short";

/**
 * The five states the brief specifies. `active` means the plan is live and
 * the entry is still reachable; `entry-available` is the narrower "price is
 * in the zone, act now" sub-state. `invalidated` and `completed` are
 * terminal — they latch until the next daily close retires the thesis.
 */
export type PlanStatus = "entry-available" | "active" | "missed" | "invalidated" | "completed";

/** Whether the thesis is still fully backed, or backed but deteriorating. Deliberately NOT a status: a weakening thesis is still the standing thesis. */
export type ThesisHealth = "confirmed" | "weakening";

/**
 * The brief's materiality ladder. Only `material` and `critical` may replace
 * or end an active thesis; everything below modifies commentary only.
 */
export type Materiality = "noise" | "minor" | "meaningful" | "material" | "critical";

export type ThesisEventKind =
  | "activated"
  | "weakened"
  | "reconfirmed"
  | "retired"
  | "invalidated"
  | "completed";

export interface ThesisEvent {
  t: number;
  version: number;
  kind: ThesisEventKind;
  materiality: Materiality;
  /**
   * Plain-English cause naming the actual evidence — "Daily structure lost
   * bullish confirmation", never "score changed". The brief is explicit
   * that a bare score delta is not an explanation.
   */
  reason: string;
}

/**
 * The plan a thesis carries. Identical in shape and construction to the one
 * a PLANNED setup carries (see plannedSetup.ts) because both come from
 * `buildTradePlan` — a planned entry at a level must not become a different
 * entry at that level the moment a thesis activates.
 */
export type FrozenPlan = TradePlan;

export interface SwingThesisState {
  version: number;
  direction: SwingDirection;
  status: PlanStatus;
  health: ThesisHealth;
  activatedAt: number;
  /** Timestamp of the most recent daily close actually folded in. Drives the UI's staleness read. */
  lastDailyCloseAt: number;
  plan: FrozenPlan;
  /** Thesis reasons frozen at activation — why this trade was taken, not why the market moved today. */
  reasons: string[];
  /** Consecutive daily closes spent weakening. Reaching `maxWeakeningCloses` retires the thesis. */
  weakeningCloses: number;
  /** Consecutive daily closes the DAILY technical read has pointed the opposite way. */
  reversalCloses: number;
  /** Consecutive daily closes this plan has ended in MISSED. */
  missedCloses: number;
}

/** A candidate accumulating consecutive qualifying closes. Not yet a thesis, and never shown as one. */
export interface PendingActivation {
  direction: SwingDirection;
  closes: number;
  firstSeenAt: number;
}

export interface SwingThesisStore {
  active: SwingThesisState | null;
  pending: PendingActivation | null;
  /** Monotone across the asset's lifetime, so v3 is always genuinely the third thesis. */
  nextVersion: number;
  /** Last daily close folded in. Tracked at store level because `pending` advances even with no active thesis. */
  lastCloseAt: number;
  /**
   * The forward-looking conditional setups, rebuilt at the same daily close
   * that drives this reducer and stored in the same record.
   *
   * Owned by the AGGREGATOR, not by this reducer — plannedSetup.ts builds
   * them and nothing here reads them. They live here only because they share
   * a cadence and a lifetime with the thesis, and splitting them into a
   * second store would mean two reads, two writes and two chances for the
   * two to disagree about which daily close they were built from.
   *
   * Optional so records written before planned setups existed still validate
   * and degrade to "no setups yet" rather than "store unavailable".
   */
  plannedSetups?: PlannedSetupsFrozen | null;
  /**
   * Versioned log across ALL theses for this asset, not just the live one.
   * Held at store level on purpose: the reason a thesis was retired has to
   * outlive the thesis, or the engine cannot answer "why did ENTER LONG
   * become WAIT" — which the brief requires it to answer.
   */
  events: ThesisEvent[];
}

export function emptySwingStore(): SwingThesisStore {
  return { active: null, pending: null, nextVersion: 1, lastCloseAt: 0, plannedSetups: null, events: [] };
}

export interface SwingThesisConfig {
  /** |score - 50| must reach this for a close to count toward activation. Wider than `DIRECTIONAL_THRESHOLD` (6) on purpose — that value sits inside the score's own dither zone. */
  activationBand: number;
  /** |score - 50| below this marks the thesis as weakening. Strictly less than `activationBand`; the gap between them IS the hysteresis. */
  deactivationBand: number;
  /** Consecutive qualifying daily closes required before a thesis activates. */
  sustainCloses: number;
  /** Consecutive weakening closes tolerated before the thesis is retired. */
  maxWeakeningCloses: number;
  /** Consecutive closes of an opposing DAILY technical read before that counts as a confirmed structural reversal. */
  reversalCloses: number;
  /**
   * Consecutive daily closes a plan may sit in MISSED before it is retired
   * so a fresh one can be priced. Without this a setup that ran away stays
   * on the screen forever, un-actionable, while the thesis behind it is
   * still perfectly valid — the brief's "legitimately replaced at the next
   * permitted reassessment" case.
   */
  maxMissedCloses: number;
  /** A pullback zone farther than this many ATRs from the close isn't a realistic swing entry; fall back to an at-market band instead. */
  entryPullbackMaxAtr: number;
  /** Half-width of the at-market entry band when no pullback level is in reach. */
  atMarketBandAtr: number;
  /** How far beyond the entry zone price must run before the setup reads MISSED — DO NOT CHASE. */
  missedAtr: number;
}

/**
 * Selected from a 33-configuration sweep over the real 2,896 asset-day
 * replay (`scripts/backtest/swingCalibration.ts`), not chosen by feel.
 * Re-run that script if the scoring layer changes; it prints the full table.
 *
 * The selection criteria were structural rather than
 * performance-maximising, which matters because sweeping 33 settings and
 * keeping the best-returning one is just specification search:
 *
 * - `activationBand: 9` is the KNEE of the duration curve. At sustain=2,
 *   act=7 gives a 4.0-day median; act=9 gives 6.0; act=11 and act=13 give
 *   6.0 and 6.5 while steadily shedding coverage. 9 buys the entire
 *   improvement and nothing past it does much.
 * - `sustainCloses: 2` DOMINATES 3 on this data — same 6.0-day median, but
 *   24% coverage instead of 16% and 105 theses instead of 67. sustain=1 is
 *   churnier (189 theses, 5.0-day median) for no gain.
 * - `deactivationBand: 5` sits in a genuinely inert region: 3 and 5 produce
 *   byte-identical results, and 7 is marginally worse. Worth stating plainly
 *   — the score-band hysteresis is NOT what stabilises this engine. The
 *   sustained-confirmation requirement and the daily/4H gates are.
 *
 * Resulting behaviour: 105 theses, median 6.0 days, max 23 days — the
 * days-to-weeks horizon the product asks for.
 */
export const DEFAULT_SWING_CONFIG: SwingThesisConfig = {
  activationBand: 9,
  deactivationBand: 5,
  sustainCloses: 2,
  maxWeakeningCloses: 3,
  reversalCloses: 2,
  maxMissedCloses: 3,
  entryPullbackMaxAtr: 1.5,
  atMarketBandAtr: 0.25,
  missedAtr: 1,
};

/** Evidence available at a daily close. Everything soft enters the machine here and only here. */
export interface DailyCloseEvidence {
  /** The daily bar's close timestamp. Must be strictly increasing across calls. */
  t: number;
  closePrice: number;
  biasScore: number | null;
  biasVerdict: Verdict;
  /** `technicalAgreement(dailyRead, biasDirection)` — computed against the BIAS direction, deliberately not `thesis.dominant`, which has no deadband and flips ~8x/day. */
  dailyAgreement: TechnicalAgreement | null;
  /** Raw daily technical direction, used to detect a confirmed structural reversal independently of the agreement label. */
  dailyDirection: Verdict | null;
  /** `technicalAgreement(fourHourRead, biasDirection)`. Null when 4H is unavailable — which blocks nothing, because absent data must never become evidence in either direction. */
  fourHourAgreement: TechnicalAgreement | null;
  /** Inputs for `buildEntryQuality`, used once at activation and then frozen. Null when no honest plan can be built. */
  planInputs: EntryQualityInputs | null;
  /** Thesis reasons to freeze onto a newly activated plan. */
  reasons: string[];
}

export interface TickEvidence {
  t: number;
  price: number;
  /**
   * Intrabar extremes since the previous tick, when known.
   *
   * The replay supplies real hourly OHLC. The live path has only a spot
   * quote and falls back to `price` for all three, which is an honest
   * limitation worth naming rather than dressing up: a wick through the
   * stop lasting less than one poll interval is visible to the backtest and
   * invisible live. Polling is ~15s, so the exposure is a sub-15-second
   * spike — small, but it means live can be marginally SLOWER to invalidate
   * than the replay suggests, never faster.
   */
  high?: number;
  low?: number;
}

function directionOf(verdict: Verdict): SwingDirection | null {
  return verdict === "bullish" ? "long" : verdict === "bearish" ? "short" : null;
}

/** How many frozen reasons a plan carries. Enough to justify the trade, few enough to stay readable. */
const MAX_FROZEN_REASONS = 3;

/**
 * The reasons frozen onto a new thesis: the best-supported metrics that
 * AGREE with the direction being taken.
 *
 * Shared by the live aggregator and the backtest replay so both freeze the
 * same sentences — a second copy of this selection in either caller is how
 * the replayed thesis and the shipped one start explaining themselves
 * differently.
 */
export function swingReasons(bias: MarketBias | null): string[] {
  if (!bias) return [];
  const supporting = bias.verdict === "bullish" ? bias.topBullish : bias.verdict === "bearish" ? bias.topBearish : [];
  return supporting.slice(0, MAX_FROZEN_REASONS).map((m) => m.explanation);
}

function isTerminal(status: PlanStatus): boolean {
  return status === "invalidated" || status === "completed";
}

/** Keeps the event log bounded; the most recent transitions are the ones with any explanatory value. */
const MAX_EVENTS = 40;

function withEvent(events: ThesisEvent[], event: ThesisEvent): ThesisEvent[] {
  return [...events, event].slice(-MAX_EVENTS);
}

/**
 * Status is a PURE function of price against the frozen plan, except that
 * the two terminal states latch (handled by the caller). That purity is
 * deliberate: a replay ticking hourly and a live feed ticking every 15
 * seconds converge on the same status for the same price, with no
 * dependence on how often either was called.
 */
function statusForPrice(state: SwingThesisState, price: number, high: number, low: number): PlanStatus {
  const { plan, direction } = state;
  const isLong = direction === "long";

  // A stop is a stop: an intrabar breach ends the thesis, matching the
  // pessimistic intrabar resolution `scripts/backtest/execution.ts` already
  // applies, so live and replay can't disagree about the same bar.
  if (isLong ? low <= plan.stopPrice : high >= plan.stopPrice) return "invalidated";
  if (isLong ? high >= plan.target1Price : low <= plan.target1Price) return "completed";

  if (price >= plan.entryLow && price <= plan.entryHigh) return "entry-available";

  // "Ran away" is measured from the ACTIVATION price, not from the zone
  // edge. Measuring from the edge would mark a plan as missed the moment it
  // activated whenever the pullback zone sat farther below the close than
  // `missedAtr` — which is most of the time, since a zone is allowed to be
  // up to `entryPullbackMaxAtr` away. The question this state answers is
  // "has price run away from where the plan was set", so that is what it
  // measures.
  const ranAway = isLong
    ? price > plan.anchorPrice + plan.missedDistance
    : price < plan.anchorPrice - plan.missedDistance;
  return ranAway ? "missed" : "active";
}

/**
 * Folds price into the plan's status. Never touches direction, levels, or
 * the thesis itself — that is exclusively `applyDailyClose`'s job.
 */
export function applyTick(store: SwingThesisStore, ev: TickEvidence): SwingThesisStore {
  const state = store.active;
  if (!state || isTerminal(state.status)) return store;

  const high = ev.high ?? ev.price;
  const low = ev.low ?? ev.price;
  const next = statusForPrice(state, ev.price, high, low);
  if (next === state.status) return store;

  const events =
    next === "invalidated"
      ? withEvent(store.events, {
          t: ev.t,
          version: state.version,
          kind: "invalidated",
          materiality: "critical",
          reason: `Price reached the structural invalidation level — this thesis was defined as wrong beyond ${state.plan.stopPrice}.`,
        })
      : next === "completed"
        ? withEvent(store.events, {
            t: ev.t,
            version: state.version,
            kind: "completed",
            materiality: "material",
            reason: `Price reached the first target at ${state.plan.target1Price}.`,
          })
        : store.events;

  return { ...store, events, active: { ...state, status: next } };
}

export interface Assessment {
  qualifies: boolean;
  /** When true, `note` is always populated. */
  weakening: boolean;
  note: string | null;
  /**
   * Machine-readable name of the FIRST gate that blocked activation, for
   * offline gate-attribution research. Null when the assessment qualifies.
   * Exists so `swingCalibration.ts` can rank suppressing conditions without
   * keeping a second, drifting copy of the gate order.
   */
  gate: ActivationGate | null;
}

/** The gates, in the order `assess` evaluates them. */
export type ActivationGate =
  | "no-score"
  | "bias-direction"
  | "conviction-below-deactivation"
  | "conviction-below-activation"
  | "daily-not-confirming"
  | "4h-contradicts"
  | "4h-weakens";

/**
 * The activation gate, also reused to judge whether a live thesis still
 * stands. Conditions are evaluated against the BIAS direction throughout.
 *
 * Exported for research only — `swingCalibration.ts` calls it to attribute
 * every inactive day to the specific condition that blocked it. Nothing in
 * the live path calls it directly, and exporting changes no behaviour.
 */
export function assess(direction: SwingDirection, ev: DailyCloseEvidence, config: SwingThesisConfig): Assessment {
  const wanted: Verdict = direction === "long" ? "bullish" : "bearish";

  if (ev.biasScore === null) {
    return { qualifies: false, weakening: false, note: "Composite score unavailable", gate: "no-score" };
  }
  if (ev.biasVerdict !== wanted) {
    return { qualifies: false, weakening: true, note: `Composite bias is no longer ${wanted}`, gate: "bias-direction" };
  }

  const distance = Math.abs(ev.biasScore - 50);
  if (distance < config.deactivationBand) {
    return { qualifies: false, weakening: true, note: "Composite conviction fell back toward neutral", gate: "conviction-below-deactivation" };
  }
  if (distance < config.activationBand) {
    // Between the two bands: not strong enough to START a thesis, but not
    // weak enough to undermine one. This gap is the hysteresis.
    return { qualifies: false, weakening: false, note: "Composite conviction below the activation band", gate: "conviction-below-activation" };
  }

  if (ev.dailyAgreement !== "confirms") {
    return {
      qualifies: false,
      weakening: true,
      gate: "daily-not-confirming",
      note:
        ev.dailyAgreement === "contradicts"
          ? "Daily structure now contradicts this direction"
          : ev.dailyAgreement === "weakens"
            ? "Daily momentum diverges against this direction"
            : "Daily structure has not confirmed this direction",
    };
  }

  // The 4H promotion. It is a genuine gate on NEW entries and a genuine
  // weakener of live ones, but it carries no numeric weight inside the
  // composite — that change would need out-of-sample proof first, and the
  // validated backtest statistics depend on the current weights.
  if (ev.fourHourAgreement === "contradicts") {
    return { qualifies: false, weakening: true, note: "4H structure contradicts the daily thesis", gate: "4h-contradicts" };
  }
  if (ev.fourHourAgreement === "weakens") {
    return { qualifies: false, weakening: true, note: "4H momentum is deteriorating against the daily thesis", gate: "4h-weakens" };
  }

  return { qualifies: true, weakening: false, note: null, gate: null };
}

/**
 * Delegates to the SHARED plan builder so an activated thesis and a merely
 * planned setup describe the same level identically. All the geometry —
 * pullback entry zone, stop beyond the retested zone, R:R re-measured from
 * the real entry, refusal when risk is noise-tight — lives in tradePlan.ts
 * and exists exactly once.
 *
 * `requirePullbackEntry` is NOT optional here, and the measurement that
 * forced it is worth recording: without it, 42 of 107 historical swing plans
 * (39%) were the at-market fallback — an entry band of ±0.25 ATR centred on
 * the close, produced whenever no structural zone sat within reach. Price was
 * already inside the "entry zone" in every one of those cases, so the median
 * time to fill across all plans was two hours.
 *
 * That is not a swing entry. A swing plan is a price location the trader
 * waits for, and a band around the current price is definitionally the
 * opposite. When structure offers no such location the correct output is NO
 * PLAN — the thesis still stands, there is simply nowhere good to enter yet.
 */
function buildPlan(direction: SwingDirection, ev: DailyCloseEvidence, config: SwingThesisConfig): FrozenPlan | null {
  if (!ev.planInputs) return null;

  const { price: _price, atrPct, supportResistance, ...quality } = ev.planInputs;
  return buildTradePlan({
    direction,
    anchorPrice: ev.closePrice,
    atrPct,
    zones: supportResistance,
    quality,
    config: planConfigOf(config),
    requirePullbackEntry: true,
  });
}

/** The plan-geometry subset of the swing config, so the two configs can't drift apart. */
function planConfigOf(config: SwingThesisConfig): TradePlanConfig {
  return {
    entryPullbackMaxAtr: config.entryPullbackMaxAtr,
    atMarketBandAtr: config.atMarketBandAtr,
    missedAtr: config.missedAtr,
  };
}

function activate(
  store: SwingThesisStore,
  direction: SwingDirection,
  ev: DailyCloseEvidence,
  config: SwingThesisConfig
): SwingThesisStore {
  const plan = buildPlan(direction, ev, config);
  if (!plan) {
    // Every soft condition held but no honest plan exists (no ATR, no
    // placeable stop). Keep the candidate alive rather than discarding the
    // accumulated closes — the structure may resolve tomorrow.
    return store;
  }

  const version = store.nextVersion;
  const state: SwingThesisState = {
    version,
    direction,
    status: "active",
    health: "confirmed",
    activatedAt: ev.t,
    lastDailyCloseAt: ev.t,
    plan,
    reasons: ev.reasons,
    weakeningCloses: 0,
    reversalCloses: 0,
    missedCloses: 0,
  };

  // Seed the status from the activating close so a plan whose entry zone
  // already contains price reads ENTRY AVAILABLE immediately. A terminal
  // seed is impossible for a freshly built plan (stop and target both sit
  // beyond the close by construction), but clamp anyway rather than let a
  // degenerate plan activate straight into a dead state.
  const seeded = statusForPrice(state, ev.closePrice, ev.closePrice, ev.closePrice);

  return {
    ...store,
    active: { ...state, status: isTerminal(seeded) ? "active" : seeded },
    pending: null,
    nextVersion: version + 1,
    lastCloseAt: ev.t,
    events: withEvent(store.events, {
      t: ev.t,
      version,
      kind: "activated",
      materiality: "material",
      reason: `Swing thesis activated ${direction}: composite bias, daily structure and 4H aligned across ${config.sustainCloses} consecutive daily closes.`,
    }),
  };
}

/**
 * Clears the active thesis and logs why.
 *
 * Deliberately does NOT advance `lastCloseAt`: the caller re-enters
 * `applyDailyClose` with the same close so the freed-up slot is assessed by
 * the ordinary activation gate. A retirement is never itself evidence for
 * the opposite direction — the opposite still has to earn its own
 * consecutive closes.
 */
function retire(store: SwingThesisStore, state: SwingThesisState, t: number, reason: string): SwingThesisStore {
  return {
    ...store,
    active: null,
    pending: null,
    events: withEvent(store.events, {
      t,
      version: state.version,
      kind: "retired",
      materiality: "material",
      reason,
    }),
  };
}

/**
 * Folds one daily close into the machine. This is the only entry point that
 * may create, replace or retire a thesis.
 *
 * Idempotent by timestamp: re-processing a close already folded in returns
 * the store unchanged, so two concurrent serverless requests racing on the
 * same close cannot double-advance the state and no lock is needed.
 */
export function applyDailyClose(
  store: SwingThesisStore,
  ev: DailyCloseEvidence,
  config: SwingThesisConfig = DEFAULT_SWING_CONFIG
): SwingThesisStore {
  if (ev.t <= store.lastCloseAt) return store;

  // Insufficient data is NOT evidence. Leave the thesis exactly as it stands
  // and do NOT advance `lastCloseAt`, so the UI can tell "still valid" from
  // "we could not reassess" and this close is retried when data returns.
  if (ev.biasScore === null || ev.dailyDirection === null) return store;

  const state = store.active;

  if (state) {
    // A terminal thesis has done its job; the next daily close is when it
    // stops occupying the decision surface and a fresh assessment begins.
    if (isTerminal(state.status)) {
      return applyDailyClose({ ...store, active: null, pending: null }, ev, config);
    }

    const wanted: Verdict = state.direction === "long" ? "bullish" : "bearish";
    const opposite: Verdict = state.direction === "long" ? "bearish" : "bullish";

    // ── MATERIAL: composite crossed fully into the opposite band ─────────
    if (ev.biasVerdict === opposite && Math.abs(ev.biasScore - 50) >= config.activationBand) {
      const reason = `Composite bias crossed decisively to ${opposite} — the evidence that supported this ${state.direction} no longer holds.`;
      return applyDailyClose(retire(store, state, ev.t, reason), ev, config);
    }

    // ── MATERIAL: confirmed daily technical reversal ─────────────────────
    const reversalCloses = ev.dailyDirection === opposite ? state.reversalCloses + 1 : 0;
    if (reversalCloses >= config.reversalCloses) {
      const reason = `Daily structure reversed to ${opposite} and held for ${reversalCloses} consecutive daily closes — a confirmed structural reversal, not a single-day wobble.`;
      return applyDailyClose(retire(store, state, ev.t, reason), ev, config);
    }

    // ── MATERIAL: the setup ran away and stayed away ─────────────────────
    // Retiring here is not a judgement on the thesis — it frees the slot so
    // the ordinary activation gate can price a NEW plan at the level price
    // actually reached. Without it, a valid thesis stays welded to an entry
    // nobody can take.
    const missedCloses = state.status === "missed" ? state.missedCloses + 1 : 0;
    if (missedCloses >= config.maxMissedCloses) {
      const reason = `Price left the planned entry zone and stayed away for ${missedCloses} consecutive daily closes — the thesis may still hold, but this entry is stale and should be re-priced rather than chased.`;
      return applyDailyClose(retire(store, state, ev.t, reason), ev, config);
    }

    const verdict = assess(state.direction, ev, config);

    // ── MEANINGFUL: deterioration that does not yet unseat the thesis ────
    if (verdict.weakening) {
      const note = verdict.note ?? "Supporting evidence deteriorated";
      const weakeningCloses = state.weakeningCloses + 1;

      if (weakeningCloses >= config.maxWeakeningCloses) {
        const reason = `${note} — and has now done so for ${weakeningCloses} consecutive daily closes without recovering.`;
        return applyDailyClose(retire(store, state, ev.t, reason), ev, config);
      }

      return {
        ...store,
        lastCloseAt: ev.t,
        active: { ...state, health: "weakening", weakeningCloses, reversalCloses, missedCloses, lastDailyCloseAt: ev.t },
        events:
          state.health === "weakening"
            ? store.events
            : withEvent(store.events, {
                t: ev.t,
                version: state.version,
                kind: "weakened",
                materiality: "meaningful",
                reason: `${note}. The swing thesis stands, but with less backing than when it was established.`,
              }),
      };
    }

    // ── Still standing. Anything that moved today was noise or minor. ────
    return {
      ...store,
      lastCloseAt: ev.t,
      active: {
        ...state,
        health: "confirmed",
        weakeningCloses: 0,
        reversalCloses,
        missedCloses,
        lastDailyCloseAt: ev.t,
      },
      events:
        state.health === "weakening"
          ? withEvent(store.events, {
              t: ev.t,
              version: state.version,
              kind: "reconfirmed",
              materiality: "minor",
              reason: `Evidence recovered — composite bias is ${wanted} again with daily and 4H structure back in line.`,
            })
          : store.events,
    };
  }

  // ── No active thesis: accumulate consecutive qualifying closes ─────────
  const direction = directionOf(ev.biasVerdict);
  if (!direction) return { ...store, pending: null, lastCloseAt: ev.t };

  if (!assess(direction, ev, config).qualifies) {
    return { ...store, pending: null, lastCloseAt: ev.t };
  }

  const continuing = store.pending !== null && store.pending.direction === direction;
  const pending: PendingActivation = {
    direction,
    closes: continuing ? store.pending!.closes + 1 : 1,
    firstSeenAt: continuing ? store.pending!.firstSeenAt : ev.t,
  };

  if (pending.closes >= config.sustainCloses) {
    return activate({ ...store, pending, lastCloseAt: ev.t }, direction, ev, config);
  }
  return { ...store, pending, lastCloseAt: ev.t };
}
