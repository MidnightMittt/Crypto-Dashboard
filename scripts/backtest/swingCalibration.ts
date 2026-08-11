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

interface Bar { t: number; high: number; low: number; close: number }

function resolveSwingPlan(
  plan: NonNullable<DayRecord["swingPlan"]>,
  bars: Bar[],
  fromT: number,
  fillWindowDays: number,
  maxHoldDays: number
): PlanOutcome {
  const DAY = 86_400_000;
  const isLong = plan.direction === "long";
  const forward = bars.filter((b) => b.t > fromT);

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
  const entry = plan.entryRef;
  const signed = (px: number) => ((isLong ? px - entry : entry - px) / entry) * 100;

  let mfe = 0;
  let mae = 0;
  let tp2 = false;

  for (let i = fillIdx; i < forward.length; i++) {
    const b = forward[i];
    const held = (b.t - fillBar.t) / 3_600_000;
    if (held > maxHoldDays * 24) {
      return { filled: true, hoursToFill, outcome: "timeout", returnPct: signed(forward[i - 1]?.close ?? b.close), mfePct: mfe, maePct: mae, hoursHeld: held };
    }
    mfe = Math.max(mfe, signed(isLong ? b.high : b.low));
    mae = Math.min(mae, signed(isLong ? b.low : b.high));
    if (isLong ? b.high >= plan.target2Price : b.low <= plan.target2Price) tp2 = true;

    // Stop checked FIRST within the bar — same pessimism execution.ts applies.
    const stopHit = isLong ? b.low <= plan.stopPrice : b.high >= plan.stopPrice;
    const tpHit = isLong ? b.high >= plan.target1Price : b.low <= plan.target1Price;
    if (stopHit) return { filled: true, hoursToFill, outcome: "stop", returnPct: signed(plan.stopPrice), mfePct: mfe, maePct: mae, hoursHeld: held };
    if (tpHit) return { filled: true, hoursToFill, outcome: tp2 ? "tp2" : "target", returnPct: signed(plan.target1Price), mfePct: mfe, maePct: mae, hoursHeld: held };
  }
  const last = forward[forward.length - 1];
  return {
    filled: true,
    hoursToFill,
    outcome: "timeout",
    returnPct: last ? signed(last.close) : null,
    mfePct: mfe,
    maePct: mae,
    hoursHeld: last ? (last.t - fillBar.t) / 3_600_000 : null,
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
    outcomes.push(resolveSwingPlan(d.swingPlan, bars, d.t, FILL_WINDOW_DAYS, MAX_HOLD_DAYS));
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

  const outPath = path.join(__dirname, "swingCalibration.md");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\n[swingCalibration] wrote ${outPath}`);
}

main();
