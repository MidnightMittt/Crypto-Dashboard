import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord, DEFAULT_REPLAY_CONFIG } from "./run";
import {
  DEFAULT_SWING_CONFIG,
  SwingThesisConfig,
  assess,
  DailyCloseEvidence,
} from "../../src/lib/signals/swingThesis";
import type { TechnicalAgreement } from "../../src/lib/sentiment/technicals";
import type { Verdict } from "../../src/lib/signals/types";
import type { SupportResistanceZone } from "../../src/lib/technicals/marketStructure";
import { buildTradePlan, DEFAULT_TRADE_PLAN_CONFIG, TradePlan } from "../../src/lib/signals/tradePlan";
import { resolveTrade, HourBar } from "../../src/lib/research/tradeExecution";
import { CONTINUOUS_SESSION, SessionModel } from "../../src/lib/research/types";

/**
 * Swing activation calibration study. Derives the swing layer's thresholds
 * from measured history instead of taste, and answers the question the
 * thresholds exist to serve: is the ~24% activation rate defensible, or is a
 * specific gate suppressing setups that were worth taking?
 *
 * RESEARCH ONLY. Nothing here is imported by the app and no production
 * threshold is changed to produce these numbers. Every candidate is fed
 * through the SAME `replayAsset` the shipped engine uses, via
 * `ReplayConfig.swing`, so a variant differs from production in exactly the
 * parameter being swept and nothing else.
 *
 * Two methodology commitments, because the conclusions are worth only as
 * much as these:
 *
 *  - The outcome sweep is NARROW and one-parameter-at-a-time. A full grid
 *    over 2,896 day-records would produce dozens of cells whose best member
 *    is noise; moving one dimension keeps every result attributable.
 *  - Every candidate is scored in-sample, out-of-sample and walk-forward.
 *    A candidate that wins only in-sample is reported as rejected, not as a
 *    finding.
 *
 * The brief is explicit: "Determine the appropriate thresholds from the
 * existing architecture and historical behavior. Do not invent arbitrary
 * values simply to force stability." So this sweeps the activation band,
 * deactivation band and sustain requirement through the REAL replay — the
 * same `replayAsset` production logic runs through — and prints what each
 * setting actually produces.
 *
 * The number that matters is MEDIAN THESIS DURATION. The product target is
 * days-to-weeks, so a configuration is disqualified if it churns (duration
 * of a day or two, i.e. the current behavior with extra steps) and equally
 * disqualified if it produces almost no theses at all, which would be
 * "stable" only in the sense that a stopped clock is.
 *
 * Run: npx tsx scripts/backtest/swingCalibration.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

interface Episode {
  asset: string;
  version: number;
  direction: string;
  days: number;
  endStatus: string;
}

/**
 * Groups consecutive day-records into thesis episodes. Version is monotone
 * per asset, so a change of version is unambiguously a different thesis —
 * no heuristic stitching required.
 */
function episodesOf(records: DayRecord[]): Episode[] {
  const episodes: Episode[] = [];
  let current: Episode | null = null;

  for (const r of records) {
    if (r.swingVersion === null) {
      current = null;
      continue;
    }
    if (!current || current.version !== r.swingVersion || current.asset !== r.asset) {
      current = {
        asset: r.asset,
        version: r.swingVersion,
        direction: r.swingDirection ?? "?",
        days: 1,
        endStatus: r.swingStatus ?? "?",
      };
      episodes.push(current);
    } else {
      current.days += 1;
      current.endStatus = r.swingStatus ?? current.endStatus;
    }
  }
  return episodes;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The stateless engine's own churn over the same days, as the baseline every
 * candidate is judged against. Counts how often the shipped `action` field
 * changes from one evaluable day to the next.
 */
function statelessFlips(records: DayRecord[]): { flips: number; days: number } {
  let flips = 0;
  let days = 0;
  const byAsset = new Map<string, DayRecord[]>();
  for (const r of records) {
    if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
    byAsset.get(r.asset)!.push(r);
  }
  for (const rows of byAsset.values()) {
    days += rows.length;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].action !== rows[i - 1].action) flips++;
    }
  }
  return { flips, days };
}


/* ═══════════════════════════════════════════════════════════════════════
 * ACTIVATION STUDY
 * ═══════════════════════════════════════════════════════════════════════ */

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

/**
 * Wilson score interval, matching the execution report's existing choice.
 * Every win rate below carries one because at these sample sizes a bare
 * percentage invites conclusions the data cannot support.
 */
function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(100 * (c - spread)) / d, (100 * (c + spread)) / d];
}

/** Rebuilds the recorded gate inputs so `assess` can be replayed against a past day. */
function evidenceOf(d: DayRecord): DailyCloseEvidence {
  return {
    t: d.t,
    closePrice: 0,
    biasScore: d.biasScore,
    biasVerdict: (d.biasVerdict ?? "neutral") as Verdict,
    dailyAgreement: d.dailyAgreement as TechnicalAgreement | null,
    dailyDirection: d.dailyDirection as Verdict | null,
    fourHourAgreement: d.agreement4h as TechnicalAgreement | null,
    planInputs: null,
    reasons: [],
  };
}

/**
 * Attributes every INACTIVE day to the gate that blocked it, by calling
 * `assess` itself rather than re-deriving the gate order — a second copy
 * would drift the moment either changed.
 *
 * Also records what the market did next on the days each gate blocked. A
 * gate that suppresses days with flat or adverse forward returns is earning
 * its place; one that suppresses days with strong favourable returns is the
 * bottleneck.
 */
function gateAttribution(records: DayRecord[], config: SwingThesisConfig) {
  const counts = new Map<string, number>();
  const forward = new Map<string, number[]>();
  let passedAllGates = 0;

  for (const d of records) {
    if (d.swingVersion !== null) continue;
    const ev = evidenceOf(d);
    const direction = ev.biasVerdict === "bullish" ? "long" : ev.biasVerdict === "bearish" ? "short" : null;

    let key: string;
    if (!direction) {
      key = "bias-neutral";
    } else {
      const a = assess(direction, ev, config);
      if (a.qualifies) {
        key = "sustain-not-met";
        passedAllGates++;
      } else {
        key = a.gate ?? "unknown";
      }
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);

    if (d.forwardReturn7d !== null && direction) {
      const signed = direction === "short" ? -d.forwardReturn7d : d.forwardReturn7d;
      if (!forward.has(key)) forward.set(key, []);
      forward.get(key)!.push(signed);
    }
  }
  return { counts: [...counts.entries()].sort((a, b) => b[1] - a[1]), forward, passedAllGates };
}

const HORIZONS = ["forwardReturn1d", "forwardReturn3d", "forwardReturn7d", "forwardReturn14d", "forwardReturn30d"] as const;
const HORIZON_LABEL: Record<string, string> = {
  forwardReturn1d: "1d",
  forwardReturn3d: "3d",
  forwardReturn7d: "7d",
  forwardReturn14d: "14d",
  forwardReturn30d: "30d",
};

/**
 * Direction-adjusted forward return: positive means price moved the way the
 * thesis (or the would-be thesis) pointed. Raw returns would mostly measure
 * whether the window happened to be a bull market.
 */
function directionalForward(d: DayRecord, key: string): number | null {
  const raw = (d as unknown as Record<string, number | null>)[key];
  if (raw === null || raw === undefined) return null;
  const dir = d.swingDirection ?? (d.biasVerdict === "bullish" ? "long" : d.biasVerdict === "bearish" ? "short" : null);
  if (!dir) return null;
  return dir === "short" ? -raw : raw;
}

function forwardStats(records: DayRecord[], key: string) {
  const xs = records.map((d) => directionalForward(d, key)).filter((x): x is number => x !== null);
  if (!xs.length) return null;
  const wins = xs.filter((x) => x > 0).length;
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    n: xs.length,
    winRate: pct(wins, xs.length),
    ci: wilson(wins, xs.length),
    mean: mean(xs),
    p10: sorted[Math.floor(sorted.length * 0.1)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
  };
}

/** Realized trade quality, using the resolutions the replay already produced. */
function tradeStats(records: DayRecord[]) {
  const trades = records.map((d) => d.trade).filter((t): t is NonNullable<DayRecord["trade"]> => t != null);
  if (!trades.length) return null;
  const wins = trades.filter((t) => t.netReturnPct > 0).length;
  return {
    n: trades.length,
    winRate: pct(wins, trades.length),
    ci: wilson(wins, trades.length),
    expectancy: mean(trades.map((t) => t.netReturnPct)),
    mfe: mean(trades.map((t) => t.mfePct)),
    mae: mean(trades.map((t) => t.maePct)),
    tp1: pct(trades.filter((t) => t.outcome === "target").length, trades.length),
    tp2: pct(trades.filter((t) => t.tp2ReachedBeforeStop).length, trades.length),
    stopped: pct(trades.filter((t) => t.outcome === "stop").length, trades.length),
  };
}

/** Fraction of the timeline reserved for in-sample work; the rest is held back. */
const IN_SAMPLE_FRACTION = 0.6;
const FOLDS = 5;
/** Trades are held up to 7 days, so a fold boundary without this purge would leak. */
const EMBARGO_DAYS = 7;

interface Row {
  label: string;
  theses: number;
  medianDays: number;
  maxDays: number;
  daysWithThesis: number;
  coveragePct: number;
  invalidated: number;
  completed: number;
}

function evaluate(label: string, swing: SwingThesisConfig, assets: Array<{ data: RawAssetData; marketWide: MarketWideData }>): Row {
  const records: DayRecord[] = [];
  for (const { data, marketWide } of assets) {
    records.push(...replayAsset(data, marketWide, undefined, undefined, { ...DEFAULT_REPLAY_CONFIG, swing }));
  }

  const episodes = episodesOf(records);
  const daysWithThesis = records.filter((r) => r.swingVersion !== null).length;

  return {
    label,
    theses: episodes.length,
    medianDays: median(episodes.map((e) => e.days)),
    maxDays: episodes.reduce((m, e) => Math.max(m, e.days), 0),
    daysWithThesis,
    coveragePct: records.length > 0 ? (100 * daysWithThesis) / records.length : 0,
    invalidated: episodes.filter((e) => e.endStatus === "invalidated").length,
    completed: episodes.filter((e) => e.endStatus === "completed").length,
  };
}


/* ── Swing-plan trade resolution ────────────────────────────────────────
 *
 * `DayRecord.trade` is resolved from the STATELESS recommendation with an
 * at-market entry, so it is invariant to the swing configuration — a sweep
 * over swing thresholds returns byte-identical trade statistics. That makes
 * it useless for judging the swing layer, which is why this exists.
 *
 * A swing plan is a PULLBACK entry that price may never reach, so the
 * resolution is fill-aware in a way `resolveTrade` is not:
 *
 *   1. Scan forward for the first bar that trades into the entry zone.
 *      If none within `fillWindowDays`, the plan EXPIRED unfilled — which
 *      is a real, and acceptable, swing outcome rather than a loss.
 *   2. Fill at `entryRef` (the worst edge of the zone), matching the ratio
 *      the dashboard displayed.
 *   3. From the fill bar onward, resolve stop before target within the same
 *      bar (pessimistic), matching execution.ts's own intrabar convention.
 */
interface PlanOutcome {
  filled: boolean;
  hoursToFill: number | null;
  outcome: "target" | "tp2" | "stop" | "timeout" | "unfilled";
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  hoursHeld: number | null;
}

/** `open` is required so exit resolution can detect a gap; futuresKlines already carries it. */
interface Bar { t: number; open: number; high: number; low: number; close: number }

function resolveSwingPlan(
  plan: NonNullable<DayRecord["swingPlan"]>,
  bars: Bar[],
  fromT: number,
  fillWindowDays: number,
  maxHoldDays: number,
  session: SessionModel
): PlanOutcome {
  const DAY = 86_400_000;
  const isLong = plan.direction === "long";
  const forward = bars.filter((b) => b.t > fromT);

  /*
   * ENTRY FILL — the genuinely plan-specific half, and the only reason this
   * function exists rather than calling resolveTrade directly. A swing plan
   * is a PULLBACK entry that price may never reach, so "expired unfilled" is
   * a real outcome rather than a loss, and no exit engine can express it.
   */
  let fillIdx = -1;
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i];
    if (b.t - fromT > fillWindowDays * DAY) break;
    // Traded into the zone at any point during the bar.
    if (b.low <= plan.entryHigh && b.high >= plan.entryLow) { fillIdx = i; break; }
  }
  if (fillIdx === -1) {
    return { filled: false, hoursToFill: null, outcome: "unfilled", returnPct: null, mfePct: null, maePct: null, hoursHeld: null };
  }

  const fillBar = forward[fillIdx];
  const hoursToFill = (fillBar.t - fromT) / 3_600_000;

  /*
   * EXIT — delegated to the one canonical resolver.
   *
   * This previously duplicated the stop-before-target rule, MFE/MAE
   * tracking and timeout handling inline. Two implementations of "what
   * became of this trade" is exactly what the execution-unification phase
   * exists to remove: they were free to drift, and this copy was NOT
   * gap-aware, so pointing it at a session market would have silently
   * overstated results the same way the legacy replay did.
   *
   * `entryT` is set one millisecond BEFORE the fill bar so that resolveTrade's
   * `t > entryT` window still INCLUDES it. That preserves the pessimistic
   * reading this function always had: if a bar both entered the zone and
   * touched the stop, OHLC cannot order the two, and we assume the fill
   * happened and was then stopped.
   */
  const resolution = resolveTrade(
    {
      side: isLong ? "long" : "short",
      entryPrice: plan.entryRef,
      stopPrice: plan.stopPrice,
      targetPrice: plan.target1Price,
      target2Price: plan.target2Price,
      entryT: fillBar.t - 1,
    },
    forward.slice(fillIdx) as unknown as HourBar[],
    /*
     * The `+ 1` cancels the 1ms entryT offset above, so the window still ends
     * exactly `maxHoldDays` after the FILL BAR rather than one millisecond
     * short of it. Without it a daily bar landing precisely on the boundary
     * — which, with daily data, is every trade that runs the full hold — would
     * be silently excluded, shortening every timeout by a day.
     */
    maxHoldDays * DAY + 1,
    session
  );

  if (!resolution) {
    return { filled: true, hoursToFill, outcome: "timeout", returnPct: null, mfePct: null, maePct: null, hoursHeld: null };
  }

  /*
   * "tp2" is this study's own label for a winner that also ran to the second
   * target, so it is derived from the resolver's flag rather than tracked
   * separately. Slight semantic shift, recorded rather than hidden: the
   * resolver scans the whole window for TP2-before-stop, whereas the old
   * inline version only counted TP2 touched before the exit bar.
   */
  const outcome: PlanOutcome["outcome"] =
    resolution.outcome === "target" ? (resolution.tp2ReachedBeforeStop ? "tp2" : "target") : resolution.outcome;

  return {
    filled: true,
    hoursToFill,
    outcome,
    returnPct: resolution.grossReturnPct,
    mfePct: resolution.mfePct,
    maePct: resolution.maePct,
    // Measured from the fill bar, undoing the 1ms offset used for the window.
    hoursHeld: (resolution.exitT - fillBar.t) / 3_600_000,
  };
}

/** How long a planned entry is allowed to remain unfilled before it expires. */
const FILL_WINDOW_DAYS = 14;
/** Max hold once filled, matching the product's days-to-weeks horizon. */
const MAX_HOLD_DAYS = 21;

function swingPlanStats(records: DayRecord[], barsByAsset: Map<string, Bar[]>) {
  const outcomes: PlanOutcome[] = [];
  for (const d of records) {
    if (!d.swingPlan) continue;
    const bars = barsByAsset.get(d.asset);
    if (!bars) continue;
    outcomes.push(resolveSwingPlan(d.swingPlan, bars, d.t, FILL_WINDOW_DAYS, MAX_HOLD_DAYS, CONTINUOUS_SESSION));
  }
  if (!outcomes.length) return null;
  const filled = outcomes.filter((o) => o.filled);
  const resolved = filled.filter((o) => o.returnPct !== null);
  const wins = resolved.filter((o) => (o.returnPct ?? 0) > 0).length;
  return {
    plans: outcomes.length,
    fillRate: pct(filled.length, outcomes.length),
    medianHoursToFill: median(filled.map((o) => o.hoursToFill ?? 0)),
    n: resolved.length,
    winRate: pct(wins, resolved.length),
    ci: wilson(wins, resolved.length),
    expectancy: mean(resolved.map((o) => o.returnPct ?? 0)),
    mfe: mean(resolved.map((o) => o.mfePct ?? 0)),
    mae: mean(resolved.map((o) => o.maePct ?? 0)),
    tp1: pct(filled.filter((o) => o.outcome === "target" || o.outcome === "tp2").length, filled.length),
    tp2: pct(filled.filter((o) => o.outcome === "tp2").length, filled.length),
    stopped: pct(filled.filter((o) => o.outcome === "stop").length, filled.length),
    timeout: pct(filled.filter((o) => o.outcome === "timeout").length, filled.length),
    medianHoursHeld: median(filled.map((o) => o.hoursHeld ?? 0)),
  };
}


/* ═══════════════════════════════════════════════════════════════════════
 * ENTRY-METHODOLOGY COMPARISON — FAITHFUL HARNESS
 *
 * The previous version of this section reimplemented plan construction and
 * was therefore invalid: its "current" control produced 37 plans where
 * production produced 107, because the reimplementation demanded an opposing
 * structural zone for targets while production has ATR fallbacks. Every
 * number it produced has been discarded.
 *
 * This version never reimplements anything. It steers WHICH zone becomes the
 * entry by FILTERING THE INPUT to the real `buildTradePlan`, then calls it:
 *
 *   candidate zone Z  ->  buildTradePlan({ zones: [Z, ...opposing], ... })
 *
 * `nearestZones` inside `buildEntryQuality` then has exactly one zone to pick
 * from on the protective side, so Z is necessarily chosen, while targets,
 * stop construction, ATR fallbacks, R:R and every refusal rule remain
 * production's own. One source of truth.
 *
 * Distance-based methodologies vary `entryPullbackMaxAtr` through the real
 * `TradePlanConfig` rather than bypassing it — a supported production knob,
 * not a fork.
 *
 * HARNESS ACCEPTANCE TEST: methodology A (unfiltered zones, default config)
 * must reproduce the production plans EXACTLY. If it does not, the harness is
 * unfaithful and the study is void. That check is run first and reported.
 * ═══════════════════════════════════════════════════════════════════════ */

type Zone = SupportResistanceZone;

interface MethodPlan {
  plan: TradePlan;
  standoffAtr: number;
}

/**
 * Invokes the REAL builder with the zone set filtered so `pick` decides the
 * protective zone. Returns null when production itself refuses the plan.
 */
function buildVia(
  sp: NonNullable<DayRecord["swingPlan"]>,
  quality: Parameters<typeof buildTradePlan>[0]["quality"],
  protectiveZone: Zone | null,
  maxPullbackAtr: number
): MethodPlan | null {
  const isLong = sp.direction === "long";
  const protectiveKind = isLong ? "support" : "resistance";
  const zones = protectiveZone
    ? [protectiveZone, ...sp.zones.filter((z) => z.kind !== protectiveKind)]
    : sp.zones;

  const plan = buildTradePlan({
    direction: sp.direction,
    anchorPrice: sp.anchorPrice,
    atrPct: (sp.atrAbs / sp.anchorPrice) * 100,
    zones,
    quality,
    requirePullbackEntry: true,
    config: { ...DEFAULT_TRADE_PLAN_CONFIG, entryPullbackMaxAtr: maxPullbackAtr },
  });
  if (!plan) return null;

  const nearEdge = isLong ? plan.entryHigh : plan.entryLow;
  return { plan, standoffAtr: Math.abs(sp.anchorPrice - nearEdge) / sp.atrAbs };
}

/** Protective-side candidates on the correct side of price. */
function protectiveCandidates(sp: NonNullable<DayRecord["swingPlan"]>): Zone[] {
  const isLong = sp.direction === "long";
  return sp.zones.filter((z) =>
    isLong ? z.kind === "support" && z.priceHigh < sp.anchorPrice : z.kind === "resistance" && z.priceLow > sp.anchorPrice
  );
}

interface Methodology {
  label: string;
  /** null protectiveZone means "let production choose" (the control). */
  maxPullbackAtr: number;
  choose: (cands: Zone[], sp: NonNullable<DayRecord["swingPlan"]>) => Zone | null | "production";
}

const dist = (z: Zone, sp: NonNullable<DayRecord["swingPlan"]>) => {
  const isLong = sp.direction === "long";
  return Math.abs(sp.anchorPrice - (isLong ? z.priceHigh : z.priceLow)) / sp.atrAbs;
};

const METHODOLOGIES: Methodology[] = [
  { label: "A control (production, unfiltered)", maxPullbackAtr: 1.5, choose: () => "production" },
  { label: "B strongest zone", maxPullbackAtr: 1.5, choose: (c) => [...c].sort((a, b) => b.strength - a.strength)[0] ?? null },
  { label: "C daily-dominant", maxPullbackAtr: 1.5, choose: (c) => [...c].filter((z) => z.timeframe !== "4H").sort((a, b) => b.strength - a.strength)[0] ?? null },
  { label: "D daily+4H confluence", maxPullbackAtr: 1.5, choose: (c) => [...c].filter((z) => z.timeframe === "both").sort((a, b) => b.strength - a.strength)[0] ?? null },
  { label: "E min standoff 1 ATR", maxPullbackAtr: 4, choose: (c, sp) => [...c].filter((z) => dist(z, sp) >= 1).sort((a, b) => dist(a, sp) - dist(b, sp))[0] ?? null },
  { label: "F most touched zone", maxPullbackAtr: 1.5, choose: (c) => [...c].sort((a, b) => b.reactionCount - a.reactionCount)[0] ?? null },
  { label: "G hybrid quality", maxPullbackAtr: 3, choose: (c) => [...c].filter((z) => z.reactionCount >= 2).sort((a, b) => b.strength - a.strength)[0] ?? null },
];

interface MethodOutcome extends PlanOutcome {
  direction: "long" | "short";
  standoffAtr: number;
  rr: number;
  tp1R: number;
  tp2R: number;
  asset: string;
  t: number;
  regime: string;
  plan: TradePlan;
}

function evaluateMethodology(m: Methodology, records: DayRecord[], barsByAsset: Map<string, Bar[]>): MethodOutcome[] {
  const out: MethodOutcome[] = [];
  for (const d of records) {
    const sp = d.swingPlan;
    if (!sp) continue;
    const quality = { confidence: d.biasConfidence ?? 50, agreement: d.biasAgreement ?? 50, historicalWinRatePct: null, historicalWinRateN: null };
    const chosen = m.choose(protectiveCandidates(sp), sp);
    if (chosen === null) continue;
    const built = buildVia(sp, quality, chosen === "production" ? null : chosen, m.maxPullbackAtr);
    if (!built) continue;

    const bars = barsByAsset.get(d.asset);
    if (!bars) continue;
    const p = built.plan;
    const risk = Math.abs(p.entryRef - p.stopPrice);
    out.push({
      ...resolveSwingPlan(
        { direction: sp.direction, entryLow: p.entryLow, entryHigh: p.entryHigh, entryRef: p.entryRef,
          stopPrice: p.stopPrice, target1Price: p.target1Price, target2Price: p.target2Price,
          riskRewardRatio: p.riskRewardRatio, anchorPrice: sp.anchorPrice, atrAbs: sp.atrAbs, zones: [] },
        bars, d.t, FILL_WINDOW_DAYS, MAX_HOLD_DAYS, CONTINUOUS_SESSION
      ),
      direction: sp.direction,
      standoffAtr: built.standoffAtr,
      rr: p.riskRewardRatio,
      tp1R: Math.abs(p.target1Price - p.entryRef) / risk,
      tp2R: Math.abs(p.target2Price - p.entryRef) / risk,
      asset: d.asset,
      t: d.t,
      regime: d.regimeTags?.join(" · ") ?? "unlabelled",
      plan: p,
    });
  }
  return out;
}

function summarizeMethod(outs: MethodOutcome[]) {
  if (!outs.length) return null;
  const filled = outs.filter((o) => o.filled);
  const resolved = filled.filter((o) => o.returnPct !== null);
  const wins = resolved.filter((o) => (o.returnPct ?? 0) > 0).length;
  return {
    plans: outs.length,
    medStandoff: median(outs.map((o) => o.standoffAtr)),
    medRr: median(outs.map((o) => o.rr)),
    medTp2R: median(outs.map((o) => o.tp2R)),
    fillRate: pct(filled.length, outs.length),
    medHoursToFill: median(filled.map((o) => o.hoursToFill ?? 0)),
    n: resolved.length,
    winRate: pct(wins, resolved.length),
    ci: wilson(wins, resolved.length),
    expectancy: mean(resolved.map((o) => o.returnPct ?? 0)),
    mfe: mean(resolved.map((o) => o.mfePct ?? 0)),
    mae: mean(resolved.map((o) => o.maePct ?? 0)),
    tp1: pct(filled.filter((o) => o.outcome === "target" || o.outcome === "tp2").length, filled.length),
    tp2: pct(filled.filter((o) => o.outcome === "tp2").length, filled.length),
    stopped: pct(filled.filter((o) => o.outcome === "stop").length, filled.length),
    medDaysHeld: median(filled.map((o) => (o.hoursHeld ?? 0) / 24)),
  };
}

interface Asset { data: RawAssetData; marketWide: MarketWideData }

function replayAll(assets: Asset[], swing: SwingThesisConfig): DayRecord[] {
  const out: DayRecord[] = [];
  for (const { data, marketWide } of assets) {
    out.push(...replayAsset(data, marketWide, undefined, undefined, { ...DEFAULT_REPLAY_CONFIG, swing }));
  }
  return out;
}

/** Splits per-asset so a 60/40 cut doesn't put all of BTC in-sample and all of ETH out. */
function splitByAsset(records: DayRecord[], take: (rows: DayRecord[]) => DayRecord[]): DayRecord[] {
  const byAsset = new Map<string, DayRecord[]>();
  for (const r of records) {
    if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
    byAsset.get(r.asset)!.push(r);
  }
  return [...byAsset.values()].flatMap(take);
}

function main() {
  const marketPath = path.join(DATA_DIR, "MARKET.json");
  if (!fs.existsSync(marketPath)) {
    console.error(`Missing ${marketPath} — run "npm run backtest:fetch" first.`);
    process.exit(1);
  }
  const marketWide: MarketWideData = JSON.parse(fs.readFileSync(marketPath, "utf8"));
  const assets: Asset[] = (["BTC", "ETH"] as const).map((asset) => ({
    data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${asset}.json`), "utf8")) as RawAssetData,
    marketWide,
  }));

  const barsByAsset = new Map<string, Bar[]>();
  for (const a of assets) barsByAsset.set(a.data.asset, a.data.futuresKlines as unknown as Bar[]);

  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  const baseline = replayAll(assets, DEFAULT_SWING_CONFIG);

  say("# Swing Activation Calibration Study");
  say();
  say(`Generated ${new Date().toISOString()} · research only, no production threshold changed.`);
  say();

  // ── 1. baseline ────────────────────────────────────────────────────────
  say("## 1. Baseline (shipped configuration)");
  say();
  const stateless = statelessFlips(baseline);
  say(
    `Stateless \`action\` churn over the same days: **${stateless.flips} changes / ${stateless.days} asset-days ` +
      `= ${f2(stateless.flips / stateless.days)} per day**. That is what the swing layer replaced.`
  );
  say();
  say("| Asset | Days | Active | Long | Short | No thesis | Theses | Median dur | Mean dur | Act/month |");
  say("|---|---|---|---|---|---|---|---|---|---|");
  for (const asset of ["BTC", "ETH"]) {
    const rows = baseline.filter((r) => r.asset === asset);
    if (!rows.length) continue;
    const eps = episodesOf(rows);
    const active = rows.filter((r) => r.swingVersion !== null);
    say(
      `| ${asset} | ${rows.length} | ${f1(pct(active.length, rows.length))}% | ` +
        `${f1(pct(active.filter((r) => r.swingDirection === "long").length, rows.length))}% | ` +
        `${f1(pct(active.filter((r) => r.swingDirection === "short").length, rows.length))}% | ` +
        `${f1(pct(rows.length - active.length, rows.length))}% | ${eps.length} | ` +
        `${f1(median(eps.map((e) => e.days)))}d | ${f1(mean(eps.map((e) => e.days)))}d | ` +
        `${f2(eps.length / (rows.length / 30.44))} |`
    );
  }
  say();

  say("### Activation by regime");
  say();
  say("| Regime | Days | Active | Rate |");
  say("|---|---|---|---|");
  const regimes = new Map<string, { days: number; active: number }>();
  for (const r of baseline) {
    const key = r.regimeTags?.join(" · ") || "unlabelled";
    const e = regimes.get(key) ?? { days: 0, active: 0 };
    e.days++;
    if (r.swingVersion !== null) e.active++;
    regimes.set(key, e);
  }
  for (const [regime, v] of [...regimes.entries()].sort((a, b) => b[1].days - a[1].days).filter(([, v]) => v.days >= 40)) {
    say(`| ${regime} | ${v.days} | ${v.active} | ${f1(pct(v.active, v.days))}% |`);
  }
  say();

  // ── 2. gate attribution ────────────────────────────────────────────────
  say("## 2. What actually blocks the inactive days");
  say();
  const attr = gateAttribution(baseline, DEFAULT_SWING_CONFIG);
  const inactive = baseline.filter((r) => r.swingVersion === null).length;
  say(`Inactive day-records: **${inactive}** of ${baseline.length}.`);
  say();
  say("`Mean fwd 7d` is direction-adjusted: positive means the market moved the way the blocked thesis would have pointed.");
  say();
  say("| Blocking gate | Days | Share | Mean fwd 7d | n |");
  say("|---|---|---|---|---|");
  for (const [gate, n] of attr.counts) {
    const fwd = attr.forward.get(gate) ?? [];
    say(
      `| ${gate} | ${n} | ${f1(pct(n, inactive))}% | ` +
        `${fwd.length ? (mean(fwd) >= 0 ? "+" : "") + f2(mean(fwd)) + "%" : "—"} | ${fwd.length || "—"} |`
    );
  }
  say();
  say(`Days passing EVERY gate but short of consecutive confirmation: **${attr.passedAllGates}** (${f1(pct(attr.passedAllGates, inactive))}% of inactive).`);
  say();

  // ── 3. activated vs not ────────────────────────────────────────────────
  say("## 3. Activated vs non-activated forward outcomes");
  say();
  const activated = baseline.filter((r) => r.swingVersion !== null);
  const passedOver = baseline.filter((r) => r.swingVersion === null && r.biasVerdict && r.biasVerdict !== "neutral");
  say("| Horizon | Group | N | Win rate | 95% CI | Mean | p10 | p90 |");
  say("|---|---|---|---|---|---|---|---|");
  for (const key of HORIZONS) {
    for (const [name, rows] of [["ACTIVATED", activated], ["passed over", passedOver]] as const) {
      const st = forwardStats(rows, key);
      if (!st) continue;
      say(
        `| ${HORIZON_LABEL[key]} | ${name} | ${st.n} | ${f1(st.winRate)}% | ${f1(st.ci[0])}–${f1(st.ci[1])}% | ` +
          `${st.mean >= 0 ? "+" : ""}${f2(st.mean)}% | ${f2(st.p10)}% | ${f2(st.p90)}% |`
      );
    }
  }
  say();

  // ── 4. swing-plan trade quality ────────────────────────────────────────
  say("## 4. Realized quality of SWING PLANS");
  say();
  say(
    "**Correction to an earlier reading of this data.** `DayRecord.trade` is resolved from the " +
      "STATELESS recommendation with an at-market entry, so it is completely invariant to the swing " +
      "configuration — a sweep over swing thresholds returns byte-identical trade statistics. Those " +
      "numbers describe the old engine, not this one. Everything below instead resolves the FROZEN " +
      "swing plan, fill-aware: a plan only becomes a trade if price actually trades into its entry zone " +
      `within ${FILL_WINDOW_DAYS} days, and is then held at most ${MAX_HOLD_DAYS} days.`
  );
  say();
  say("| Group | Plans | Fill rate | Med hrs to fill | Filled n | Win rate | 95% CI | Expectancy | MFE | MAE | TP1 | TP2 | Stopped | Timeout |");
  say("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, rows] of [
    ["all", baseline],
    ["long", baseline.filter((r) => r.swingPlan?.direction === "long")],
    ["short", baseline.filter((r) => r.swingPlan?.direction === "short")],
    ["BTC", baseline.filter((r) => r.asset === "BTC")],
    ["ETH", baseline.filter((r) => r.asset === "ETH")],
  ] as const) {
    const st = swingPlanStats(rows as DayRecord[], barsByAsset);
    if (!st) continue;
    say(
      `| ${name} | ${st.plans} | ${f1(st.fillRate)}% | ${f1(st.medianHoursToFill)}h | ${st.n} | ${f1(st.winRate)}% | ` +
        `${f1(st.ci[0])}–${f1(st.ci[1])}% | ${st.expectancy >= 0 ? "+" : ""}${f2(st.expectancy)}% | ${f2(st.mfe)}% | ` +
        `${f2(st.mae)}% | ${f1(st.tp1)}% | ${f1(st.tp2)}% | ${f1(st.stopped)}% | ${f1(st.timeout)}% |`
    );
  }
  say();

  // ── 5. narrow sweep, IS vs OOS ─────────────────────────────────────────
  say("## 5. Candidate sweep — in-sample vs out-of-sample");
  say();
  say(`One parameter moved at a time from the shipped config. IS = first ${Math.round(IN_SAMPLE_FRACTION * 100)}% of each asset's timeline, OOS = the rest.`);
  say();
  const base = DEFAULT_SWING_CONFIG;
  const cands: Array<{ label: string; swing: SwingThesisConfig }> = [
    { label: "BASELINE (shipped)", swing: base },
    { label: "activationBand 7", swing: { ...base, activationBand: 7 } },
    { label: "activationBand 8", swing: { ...base, activationBand: 8 } },
    { label: "activationBand 10", swing: { ...base, activationBand: 10 } },
    { label: "activationBand 11", swing: { ...base, activationBand: 11 } },
    { label: "sustainCloses 1", swing: { ...base, sustainCloses: 1 } },
    { label: "sustainCloses 3", swing: { ...base, sustainCloses: 3 } },
    { label: "deactivationBand 3", swing: { ...base, deactivationBand: 3 } },
    { label: "deactivationBand 7", swing: { ...base, deactivationBand: 7 } },
    { label: "maxWeakening 2", swing: { ...base, maxWeakeningCloses: 2 } },
    { label: "maxWeakening 5", swing: { ...base, maxWeakeningCloses: 5 } },
  ];

  say("| Candidate | Win | Act% | Theses | MedDur | Plans | Fill% | Filled n | Win rate | 95% CI | Expectancy | Stopped |");
  say("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const cache = new Map<string, DayRecord[]>();
  for (const c of cands) {
    const all = replayAll(assets, c.swing);
    cache.set(c.label, all);
    for (const win of ["IS", "OOS"] as const) {
      const rows = splitByAsset(all, (r) => {
        const cut = Math.floor(r.length * IN_SAMPLE_FRACTION);
        return win === "IS" ? r.slice(0, cut) : r.slice(cut);
      });
      const eps = episodesOf(rows);
      const act = rows.filter((r) => r.swingVersion !== null).length;
      const st = swingPlanStats(rows, barsByAsset);
      say(
        `| ${c.label} | ${win} | ${f1(pct(act, rows.length))}% | ${eps.length} | ${f1(median(eps.map((e) => e.days)))}d | ` +
          `${st?.plans ?? 0} | ${st ? f1(st.fillRate) + "%" : "—"} | ${st?.n ?? 0} | ${st ? f1(st.winRate) + "%" : "—"} | ` +
          `${st ? f1(st.ci[0]) + "–" + f1(st.ci[1]) + "%" : "—"} | ${st ? (st.expectancy >= 0 ? "+" : "") + f2(st.expectancy) + "%" : "—"} | ` +
          `${st ? f1(st.stopped) + "%" : "—"} |`
      );
    }
  }
  say();

  // ── 6. walk-forward ────────────────────────────────────────────────────
  say("## 6. Walk-forward");
  say();
  say(`${FOLDS} sequential folds per asset with a ${EMBARGO_DAYS}-day embargo at each boundary (trades are held up to 7 days, so an unpurged boundary would leak).`);
  say();
  say("| Candidate | Folds w/ >=8 filled | Mean fold win | Worst | Best | Mean expectancy |");
  say("|---|---|---|---|---|---|");
  for (const c of cands) {
    const all = cache.get(c.label)!;
    const wins: number[] = [];
    const exps: number[] = [];
    for (let f = 0; f < FOLDS; f++) {
      const rows = splitByAsset(all, (r) => {
        const size = Math.floor(r.length / FOLDS);
        return r.slice(f * size + (f > 0 ? EMBARGO_DAYS : 0), (f + 1) * size);
      });
      const st = swingPlanStats(rows, barsByAsset);
      if (st && st.n >= 8) { wins.push(st.winRate); exps.push(st.expectancy); }
    }
    say(
      `| ${c.label} | ${wins.length}/${FOLDS} | ${wins.length ? f1(mean(wins)) + "%" : "—"} | ` +
        `${wins.length ? f1(Math.min(...wins)) + "%" : "—"} | ${wins.length ? f1(Math.max(...wins)) + "%" : "—"} | ` +
        `${exps.length ? (mean(exps) >= 0 ? "+" : "") + f2(mean(exps)) + "%" : "—"} |`
    );
  }
  say();

  // ── 7. entry-methodology comparison ────────────────────────────────────
  say("## 7. Entry-methodology comparison");
  say();
  say(
    "Activation set held FIXED — only the choice of entry zone varies. Every methodology turns its " +
      "chosen zone into levels by the same rules production uses (stop beyond the retested zone, R:R from " +
      "the worst fill), so differences are attributable to zone choice alone."
  );
  say();
  // ── HARNESS ACCEPTANCE TEST ──
  // Methodology A must reproduce the production plans exactly. Without this,
  // differences between rows are not attributable to zone choice — which is
  // precisely how the previous version of this study went wrong.
  {
    const control = evaluateMethodology(METHODOLOGIES[0], baseline, barsByAsset);
    const prodPlans = baseline.filter((d) => d.swingPlan);
    let mismatches = 0;
    const byT = new Map(control.map((o) => [`${o.asset}:${o.t}`, o.plan]));
    for (const d of prodPlans) {
      const c = byT.get(`${d.asset}:${d.t}`);
      const p = d.swingPlan!;
      if (!c) { mismatches++; continue; }
      const same =
        Math.abs(c.entryLow - p.entryLow) < 1e-6 &&
        Math.abs(c.entryHigh - p.entryHigh) < 1e-6 &&
        Math.abs(c.stopPrice - p.stopPrice) < 1e-6 &&
        Math.abs(c.target1Price - p.target1Price) < 1e-6 &&
        Math.abs(c.target2Price - p.target2Price) < 1e-6;
      if (!same) mismatches++;
    }
    say(
      `**Harness acceptance test** — control reproduced ${prodPlans.length - mismatches}/${prodPlans.length} production plans ` +
        `exactly (entry, stop, TP1, TP2). ${mismatches === 0 ? "PASS — differences below are attributable to zone choice alone." : `**FAIL (${mismatches} mismatches) — the comparison below is NOT valid.**`}`
    );
    say();
  }

  say("| Methodology | Plans | Med standoff | Med R:R | Fill% | Med hrs to fill | n | Win | 95% CI | Expectancy | MFE | MAE | TP1 | TP2 | Stop | Med days held |");
  say("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const methodOutcomes = new Map<string, MethodOutcome[]>();
  for (const m of METHODOLOGIES) {
    const outs = evaluateMethodology(m, baseline, barsByAsset);
    methodOutcomes.set(m.label, outs);
    const st = summarizeMethod(outs);
    if (!st) { say(`| ${m.label} | 0 | — | — | — | — | — | — | — | — | — | — | — | — | — | — |`); continue; }
    say(
      `| ${m.label} | ${st.plans} | ${f2(st.medStandoff)} ATR | ${f2(st.medRr)} | ${f1(st.fillRate)}% | ${f1(st.medHoursToFill)}h | ` +
        `${st.n} | ${f1(st.winRate)}% | ${f1(st.ci[0])}–${f1(st.ci[1])}% | ${st.expectancy >= 0 ? "+" : ""}${f2(st.expectancy)}% | ` +
        `${f2(st.mfe)}% | ${f2(st.mae)}% | ${f1(st.tp1)}% | ${f1(st.tp2)}% | ${f1(st.stopped)}% | ${f1(st.medDaysHeld)}d |`
    );
  }
  say();

  say("### Long vs short, per methodology");
  say();
  say("| Methodology | Long n | Long win | Long exp | Short n | Short win | Short exp |");
  say("|---|---|---|---|---|---|---|");
  for (const m of METHODOLOGIES) {
    const outs = methodOutcomes.get(m.label) ?? [];
    const L = summarizeMethod(outs.filter((o) => o.direction === "long"));
    const S = summarizeMethod(outs.filter((o) => o.direction === "short"));
    say(
      `| ${m.label} | ${L?.n ?? 0} | ${L ? f1(L.winRate) + "%" : "—"} | ${L ? (L.expectancy >= 0 ? "+" : "") + f2(L.expectancy) + "%" : "—"} | ` +
        `${S?.n ?? 0} | ${S ? f1(S.winRate) + "%" : "—"} | ${S ? (S.expectancy >= 0 ? "+" : "") + f2(S.expectancy) + "%" : "—"} |`
    );
  }
  say();

  say("### Walk-forward per methodology");
  say();
  say("| Methodology | Folds w/ >=8 | Mean fold win | Worst | Best | Mean expectancy |");
  say("|---|---|---|---|---|---|");
  const foldEdges = (() => {
    const ts = [...new Set(baseline.map((r) => r.t))].sort((a, b) => a - b);
    return Array.from({ length: FOLDS + 1 }, (_, i) => ts[Math.min(Math.floor((i * ts.length) / FOLDS), ts.length - 1)]);
  })();
  for (const m of METHODOLOGIES) {
    const outs = methodOutcomes.get(m.label) ?? [];
    const wins: number[] = [];
    const exps: number[] = [];
    for (let f = 0; f < FOLDS; f++) {
      const lo = foldEdges[f] + (f > 0 ? EMBARGO_DAYS * 86_400_000 : 0);
      const hi = foldEdges[f + 1];
      const st = summarizeMethod(outs.filter((o) => o.t >= lo && o.t < hi));
      if (st && st.n >= 8) { wins.push(st.winRate); exps.push(st.expectancy); }
    }
    say(
      `| ${m.label} | ${wins.length}/${FOLDS} | ${wins.length ? f1(mean(wins)) + "%" : "—"} | ` +
        `${wins.length ? f1(Math.min(...wins)) + "%" : "—"} | ${wins.length ? f1(Math.max(...wins)) + "%" : "—"} | ` +
        `${exps.length ? (mean(exps) >= 0 ? "+" : "") + f2(mean(exps)) + "%" : "—"} |`
    );
  }
  say();

  // ── 8. TP2 diagnosis ───────────────────────────────────────────────────
  say("## 8. TP2 diagnosis");
  say();
  say(
    "Everything in R, so target distance and realized excursion are directly comparable. " +
      "`MFE p90` is the 90th percentile favourable excursion actually achieved — if TP2 sits beyond even that, " +
      "it is not a target the market declined to reach, it is a target the methodology never made reachable."
  );
  say();
  say("| Methodology | TP1 dist | TP2 dist | MFE median | MFE p90 | MFE max | TP2 within MFE p90? | TP1 hit% | TP2 hit% |");
  say("|---|---|---|---|---|---|---|---|---|");
  for (const m of METHODOLOGIES) {
    const outs = (methodOutcomes.get(m.label) ?? []).filter((o) => o.filled && o.mfePct !== null);
    if (!outs.length) continue;
    const st = summarizeMethod(outs);
    // MFE expressed in R: excursion% divided by the plan's own risk%.
    const mfeR = outs.map((o) => {
      const riskPct = (Math.abs(o.plan.entryRef - o.plan.stopPrice) / o.plan.entryRef) * 100;
      return riskPct > 0 ? (o.mfePct ?? 0) / riskPct : 0;
    });
    const sorted = [...mfeR].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const tp2 = median(outs.map((o) => o.tp2R));
    say(
      `| ${m.label} | ${f2(median(outs.map((o) => o.tp1R)))}R | ${f2(tp2)}R | ${f2(median(mfeR))}R | ${f2(p90)}R | ` +
        `${f2(sorted[sorted.length - 1])}R | ${p90 >= tp2 ? "yes" : "**no**"} | ${st ? f1(st.tp1) + "%" : "—"} | ${st ? f1(st.tp2) + "%" : "—"} |`
    );
  }
  say();

  const outPath = path.join(__dirname, "swingCalibration.md");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\n[swingCalibration] wrote ${outPath}`);
}

main();
