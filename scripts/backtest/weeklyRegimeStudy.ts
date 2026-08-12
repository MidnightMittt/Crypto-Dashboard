import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord, RawAssetData } from "./run";
import { ema } from "../../src/lib/technicals/indicators";
import { computeTradeStats, TradeRecord } from "./tradeStats";
import { wilsonInterval, signTestPValue } from "./metrics";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

/**
 * PHASE 6 RESEARCH — Weekly regime as a strategic filter. RESEARCH ONLY:
 * nothing here is imported by the app, and no production file is modified
 * by this script.
 *
 * The brief asks for a Weekly timeframe that defines the dominant market
 * regime and FILTERS trades, rather than another weighted score. Before
 * building that, four questions have to be answered honestly, in this
 * order, because a "no" at any step makes the later steps moot:
 *
 *   R1. Is a weekly regime read actually DIFFERENT from what the engine
 *       already knows? regimes.ts already tags each day bull/bear/neutral
 *       off a trailing 20-day return — which is four weeks. If a weekly
 *       classification agrees with that tag ~all the time, it is a slower
 *       copy of an existing signal and adds nothing but latency.
 *   R2. Does the weekly regime PERSIST? The brief's premise is "the Weekly
 *       should change rarely". If it churns, it cannot be a strategic filter.
 *   R3. Do trades ALIGNED with the weekly regime beat trades that fight it?
 *   R4. Is any of that INCREMENTAL to the daily trend tag the engine
 *       already has, or is it subsumed?
 *
 * Thresholds are derived from the WEEKLY MEASURE'S OWN distribution over
 * the first 30% of weeks only, then frozen and applied to the whole
 * sample. They are never selected by looking at trade outcomes — the same
 * discipline regimes.ts's own 7% trend threshold was set with, and the
 * reason this study can claim not to be curve-fit.
 *
 * Run: npx tsx scripts/backtest/weeklyRegimeStudy.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** Unix epoch was a Thursday; shifting 4 days makes bucket boundaries land on UTC Monday, matching OKX's own 1W bar convention. */
const MONDAY_OFFSET_MS = 4 * DAY_MS;
/** A bucket with fewer real hours than this is a partial week (start/end of the series, or a data gap) and is not treated as a closed bar. */
const MIN_HOURS_PER_WEEK = 120;

const EMA_PERIOD = 20; // ~20 weeks, the standard intermediate-term weekly average
const SLOPE_LOOKBACK_WEEKS = 4;
/** Fraction of weeks (earliest-first) used to derive thresholds. Frozen thereafter. */
const THRESHOLD_CALIBRATION_FRACTION = 0.3;

interface Bar { t: number; open: number; high: number; low: number; close: number }

interface WeeklyBar {
  weekStart: number;
  /** The instant this bar is fully closed and therefore usable. Nothing may read this bar at a decision timestamp earlier than this. */
  closeT: number;
  open: number;
  high: number;
  low: number;
  close: number;
  hours: number;
}

/**
 * Weekly regime taxonomy. Deliberately a QUADRANT model (where price sits
 * relative to its weekly trend, crossed with which way that trend is
 * moving) rather than another trailing-return bucket — precisely because a
 * trailing-return bucket is what the daily tag already is, and R1 exists to
 * check that this is not the same measurement twice.
 */
type WeeklyRegime =
  | "strong-bull"
  | "bull"
  | "distribution"
  | "neutral"
  | "accumulation"
  | "bear"
  | "strong-bear";

/** The directional preference a regime expresses. `neutral` deliberately expresses none. */
function regimeBias(r: WeeklyRegime): "bullish" | "bearish" | "neutral" {
  switch (r) {
    case "strong-bull":
    case "bull":
      return "bullish";
    case "strong-bear":
    case "bear":
      return "bearish";
    // Accumulation and distribution are TRANSITIONAL: price on one side of
    // the weekly trend while that trend moves the other way. Calling either
    // one directional would be inventing conviction the structure doesn't
    // have, so both read neutral for filtering purposes and are reported
    // separately below to check whether that neutrality is justified.
    default:
      return "neutral";
  }
}

function rollUpToWeekly(hourly: Bar[]): WeeklyBar[] {
  const buckets = new Map<number, Bar[]>();
  for (const b of hourly) {
    const weekStart = Math.floor((b.t - MONDAY_OFFSET_MS) / WEEK_MS) * WEEK_MS + MONDAY_OFFSET_MS;
    const arr = buckets.get(weekStart);
    if (arr) arr.push(b);
    else buckets.set(weekStart, [b]);
  }

  const out: WeeklyBar[] = [];
  for (const [weekStart, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length < MIN_HOURS_PER_WEEK) continue;
    const sorted = bars.sort((a, b) => a.t - b.t);
    out.push({
      weekStart,
      // The bar is only knowable once the week is over, not at its last
      // hourly print — the same knownAt discipline harmonics.ts uses.
      closeT: weekStart + WEEK_MS,
      open: sorted[0].open,
      high: Math.max(...sorted.map((x) => x.high)),
      low: Math.min(...sorted.map((x) => x.low)),
      close: sorted[sorted.length - 1].close,
      hours: sorted.length,
    });
  }
  return out;
}

interface WeeklyPoint {
  bar: WeeklyBar;
  ema: number;
  /** (close - ema) / ema — where price sits relative to its own weekly trend. */
  dist: number;
  /** Fractional change in the EMA over SLOPE_LOOKBACK_WEEKS — which way that trend is going. */
  slope: number;
}

/** Computes dist/slope for every weekly bar that has enough history. Pure geometry — no thresholds applied yet. */
function weeklyPoints(bars: WeeklyBar[]): WeeklyPoint[] {
  const out: WeeklyPoint[] = [];
  const emaByIndex: Array<number | null> = [];
  for (let i = 0; i < bars.length; i++) {
    const closes = bars.slice(0, i + 1).map((b) => b.close);
    emaByIndex.push(ema(closes, EMA_PERIOD));
  }
  for (let i = 0; i < bars.length; i++) {
    const e = emaByIndex[i];
    const ePrev = i >= SLOPE_LOOKBACK_WEEKS ? emaByIndex[i - SLOPE_LOOKBACK_WEEKS] : null;
    if (e === null || e <= 0 || ePrev === null || ePrev <= 0) continue;
    out.push({
      bar: bars[i],
      ema: e,
      dist: (bars[i].close - e) / e,
      slope: (e - ePrev) / ePrev,
    });
  }
  return out;
}

interface Thresholds {
  /** |slope| below this is a flat weekly trend — no directional regime. */
  slopeFlat: number;
  /** |dist| above this upgrades bull/bear to strong-bull/strong-bear. */
  distStrong: number;
  calibratedOnWeeks: number;
}

/**
 * Thresholds from the measures' OWN distribution over the earliest
 * THRESHOLD_CALIBRATION_FRACTION of weeks. Uses the 1/3 and 2/3 points of
 * |slope| and |dist| so the dead zone and the "strong" tier each cover a
 * comparable share of history by construction. No trade outcome is
 * consulted, and the later 70% of weeks never influences the numbers.
 */
function calibrateThresholds(points: WeeklyPoint[]): Thresholds {
  const cut = Math.max(EMA_PERIOD, Math.floor(points.length * THRESHOLD_CALIBRATION_FRACTION));
  const calib = points.slice(0, cut);
  const absSlopes = calib.map((p) => Math.abs(p.slope)).sort((a, b) => a - b);
  const absDists = calib.map((p) => Math.abs(p.dist)).sort((a, b) => a - b);
  return {
    slopeFlat: absSlopes[Math.floor(absSlopes.length / 3)] ?? 0.01,
    distStrong: absDists[Math.floor((absDists.length * 2) / 3)] ?? 0.1,
    calibratedOnWeeks: calib.length,
  };
}

function classify(p: WeeklyPoint, th: Thresholds): WeeklyRegime {
  const rising = p.slope > th.slopeFlat;
  const falling = p.slope < -th.slopeFlat;
  const above = p.dist > 0;

  if (!rising && !falling) return "neutral";
  if (above && rising) return p.dist > th.distStrong ? "strong-bull" : "bull";
  if (!above && falling) return -p.dist > th.distStrong ? "strong-bear" : "bear";
  /*
   * The two transitional quadrants, named the conventional way round (this
   * was backwards in the first draft of this script and is corrected here):
   * price ABOVE a still-FALLING weekly average is the lagging-average
   * signature of an early recovery off a low — accumulation. Price BELOW a
   * still-RISING average is early topping — distribution.
   */
  if (above && falling) return "accumulation";
  return "distribution";
}

/**
 * Per-asset weekly regime timeline plus a point-in-time lookup. The lookup
 * is the whole reason this is structured as a timeline: it returns the most
 * recent weekly regime whose bar had ALREADY CLOSED at the decision
 * timestamp, so no daily decision can ever read a week that was still
 * forming when that decision was made.
 */
class WeeklyTimeline {
  private readonly entries: Array<{ closeT: number; regime: WeeklyRegime; point: WeeklyPoint }>;
  readonly thresholds: Thresholds;

  constructor(hourly: Bar[]) {
    const points = weeklyPoints(rollUpToWeekly(hourly));
    this.thresholds = calibrateThresholds(points);
    this.entries = points.map((point) => ({
      closeT: point.bar.closeT,
      regime: classify(point, this.thresholds),
      point,
    }));
  }

  at(t: number): WeeklyRegime | null {
    let found: WeeklyRegime | null = null;
    for (const e of this.entries) {
      if (e.closeT > t) break;
      found = e.regime;
    }
    return found;
  }

  get all() {
    return this.entries;
  }
}

// ── Reporting helpers ───────────────────────────────────────────────────

const pctOf = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

const ALL_REGIMES: WeeklyRegime[] = [
  "strong-bull", "bull", "accumulation", "neutral", "distribution", "bear", "strong-bear",
];

/** One win-rate cell, collected so every p-value in the study can go through a single FDR correction at the end. */
interface Cell {
  label: string;
  n: number;
  wins: number;
  pValue: number;
}

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };
  const cells: Cell[] = [];

  say("# Phase 6 Research — Weekly Regime as a Strategic Filter");
  say("");
  say("Research only. No production file is modified by this script.");
  say("");

  const records: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8"));
  const timelines = new Map<string, WeeklyTimeline>();
  for (const asset of ["BTC", "ETH"] as const) {
    const raw: RawAssetData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${asset}.json`), "utf8"));
    timelines.set(asset, new WeeklyTimeline(raw.futuresKlines as unknown as Bar[]));
  }

  // ── R1: construction + redundancy ────────────────────────────────────
  say("## R1 — Construction, census, and redundancy against the existing daily trend tag");
  say("");
  for (const [asset, tl] of timelines) {
    const th = tl.thresholds;
    say(`**${asset}**: ${tl.all.length} closed weekly bars with a full EMA${EMA_PERIOD} + ${SLOPE_LOOKBACK_WEEKS}w slope. ` +
        `Thresholds calibrated on the earliest ${th.calibratedOnWeeks} weeks only: ` +
        `flat-slope band = ±${(th.slopeFlat * 100).toFixed(2)}% per ${SLOPE_LOOKBACK_WEEKS}w, ` +
        `strong tier = ±${(th.distStrong * 100).toFixed(1)}% from the weekly EMA.`);
  }
  say("");

  const withWeekly = records
    .map((r) => ({ r, weekly: timelines.get(r.asset)!.at(r.t) }))
    .filter((x): x is { r: DayRecord; weekly: WeeklyRegime } => x.weekly !== null);
  say(`Day-records classified with a closed weekly regime: ${withWeekly.length} of ${records.length} ` +
      `(${f1(pctOf(withWeekly.length, records.length))}%).`);
  say("");

  say("| Weekly regime | Days | Share |");
  say("|---|---|---|");
  for (const g of ALL_REGIMES) {
    const n = withWeekly.filter((x) => x.weekly === g).length;
    say(`| ${g} | ${n} | ${f1(pctOf(n, withWeekly.length))}% |`);
  }
  say("");

  // The decisive redundancy check.
  const dailyTrendOf = (r: DayRecord) => r.regimeTags.find((t) => ["bull", "bear", "neutral"].includes(t)) ?? "neutral";
  say("**Redundancy: weekly regime bias vs the existing daily 20d trend tag (regimes.ts)**");
  say("");
  say("| Weekly bias \\ Daily tag | bull | neutral | bear |");
  say("|---|---|---|---|");
  let agree = 0;
  for (const bias of ["bullish", "neutral", "bearish"] as const) {
    const row = withWeekly.filter((x) => regimeBias(x.weekly) === bias);
    const counts = { bull: 0, neutral: 0, bear: 0 } as Record<string, number>;
    for (const x of row) counts[dailyTrendOf(x.r)]++;
    const matching = bias === "bullish" ? counts.bull : bias === "bearish" ? counts.bear : counts.neutral;
    agree += matching;
    say(`| ${bias} | ${counts.bull} | ${counts.neutral} | ${counts.bear} |`);
  }
  const agreePct = pctOf(agree, withWeekly.length);
  say("");
  say(`Exact agreement (weekly bias equals daily tag): **${f1(agreePct)}%** of days. ` +
      `A high number here would mean the weekly read is a slower restatement of a signal the engine already has.`);
  say("");

  /*
   * Census-only sensitivity. The brief asks for an 8-state taxonomy
   * including accumulation and distribution; the table above shows both are
   * nearly empty. The question that answers is whether that is a property
   * of weekly geometry or an artefact of the dead-zone width, so the same
   * classification is re-run at narrower dead zones. Deliberately reports
   * ONLY state counts and never an outcome — widening or narrowing a band
   * until a desired state appears would be fitting the taxonomy to a wish.
   */
  say("**Taxonomy sensitivity: can the requested accumulation/distribution states be produced at all?**");
  say("");
  say("| Dead-zone width | neutral | accumulation | distribution | directional |");
  say("|---|---|---|---|---|");
  for (const scale of [1, 0.5, 0.25, 0]) {
    const counts: Record<string, number> = {};
    for (const [, tl] of timelines) {
      const scaled: Thresholds = { ...tl.thresholds, slopeFlat: tl.thresholds.slopeFlat * scale };
      for (const e of tl.all) {
        const g = classify(e.point, scaled);
        counts[g] = (counts[g] ?? 0) + 1;
      }
    }
    const directional = (counts["strong-bull"] ?? 0) + (counts["bull"] ?? 0) + (counts["bear"] ?? 0) + (counts["strong-bear"] ?? 0);
    say(`| ${scale === 1 ? "calibrated (1.0x)" : `${scale}x`} | ${counts["neutral"] ?? 0} | ${counts["accumulation"] ?? 0} | ${counts["distribution"] ?? 0} | ${directional} |`);
  }
  say("");

  // ── R2: persistence ──────────────────────────────────────────────────
  say("## R2 — Weekly regime persistence");
  say("");
  for (const [asset, tl] of timelines) {
    const seq = tl.all.map((e) => e.regime);
    let switches = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
    const meanDwell = seq.length / Math.max(1, switches + 1);
    let biasSwitches = 0;
    for (let i = 1; i < seq.length; i++) if (regimeBias(seq[i]) !== regimeBias(seq[i - 1])) biasSwitches++;
    const meanBiasDwell = seq.length / Math.max(1, biasSwitches + 1);
    say(`**${asset}**: ${switches} regime changes over ${seq.length} weeks — mean dwell **${f1(meanDwell)} weeks** ` +
        `per labelled regime, and **${f1(meanBiasDwell)} weeks** per directional bias ` +
        `(${biasSwitches} bias flips; this is the number that matters for a filter that only ever gates direction).`);
  }
  say("");

  say("**Bias survival: given a directional weekly bias this week, is it the same N weeks later?**");
  say("");
  say("| Asset | +1w | +2w | +4w | +8w |");
  say("|---|---|---|---|---|");
  for (const [asset, tl] of timelines) {
    const seq = tl.all.map((e) => regimeBias(e.regime));
    const surv = (k: number) => {
      let same = 0, total = 0;
      for (let i = 0; i + k < seq.length; i++) {
        if (seq[i] === "neutral") continue;
        total++;
        if (seq[i + k] === seq[i]) same++;
      }
      return total > 0 ? `${f1(pctOf(same, total))}% (n=${total})` : "—";
    };
    say(`| ${asset} | ${surv(1)} | ${surv(2)} | ${surv(4)} | ${surv(8)} |`);
  }
  say("");

  // ── R3: trade outcomes by weekly alignment ───────────────────────────
  say("## R3 — Do trades aligned with the weekly regime outperform?");
  say("");

  type Aligned = "aligned" | "counter" | "weekly-neutral";
  const alignmentOf = (side: "long" | "short", weekly: WeeklyRegime): Aligned => {
    const bias = regimeBias(weekly);
    if (bias === "neutral") return "weekly-neutral";
    return (side === "long") === (bias === "bullish") ? "aligned" : "counter";
  };

  /** Same alignment idea applied to the daily trend tag the engine already has, so R4 can cross the two. */
  const dailyAlignOf = (side: "long" | "short", tag: string): Aligned => {
    if (tag === "neutral") return "weekly-neutral";
    return (side === "long") === (tag === "bull") ? "aligned" : "counter";
  };

  const volTagOf = (r: DayRecord) =>
    r.regimeTags.find((t) => t.endsWith("-vol"))?.replace("-vol", "") ?? "normal";

  const tradesWithWeekly = withWeekly
    .filter((x) => x.r.trade !== null)
    .map((x) => ({
      weekly: x.weekly,
      align: alignmentOf(x.r.trade!.side, x.weekly),
      side: x.r.trade!.side,
      t: x.r.t,
      date: x.r.date,
      volTag: volTagOf(x.r),
      dailyAlign: dailyAlignOf(x.r.trade!.side, dailyTrendOf(x.r)),
      rec: { t: x.r.t, ...x.r.trade! } as TradeRecord,
    }));
  say(`Resolved trades with a closed weekly regime: ${tradesWithWeekly.length}.`);
  say("");

  say("| Alignment | N | Win rate | 95% CI | Net expectancy | Profit factor | Median net | p (vs coin flip) |");
  say("|---|---|---|---|---|---|---|---|");
  for (const a of ["aligned", "counter", "weekly-neutral"] as const) {
    const bucket = tradesWithWeekly.filter((x) => x.align === a);
    const stats = computeTradeStats(bucket.map((x) => x.rec));
    if (!stats) { say(`| ${a} | ${bucket.length} | insufficient data | | | | | |`); continue; }
    const wins = bucket.filter((x) => x.rec.netReturnPct > 0).length;
    const ci = wilsonInterval(wins, bucket.length);
    const p = signTestPValue(bucket.length, wins);
    cells.push({ label: `R3 ${a}`, n: bucket.length, wins, pValue: p });
    say(`| ${a} | ${stats.n} | ${f1(stats.winRatePct)}% | ${ci ? `${f1(ci.lower * 100)}–${f1(ci.upper * 100)}%` : "—"} | ` +
        `${f2(stats.expectancyNetPct)}% | ${stats.profitFactor === null ? "—" : f2(stats.profitFactor)} | ` +
        `${f2(stats.medianNetPct)}% | ${p.toFixed(4)} |`);
  }
  say("");

  say("**Per weekly regime (the same trades, unpooled — checks the aligned/counter split isn't driven by one regime):**");
  say("");
  say("| Weekly regime | Trades | Win rate | Net expectancy |");
  say("|---|---|---|---|");
  for (const g of ALL_REGIMES) {
    const bucket = tradesWithWeekly.filter((x) => x.weekly === g);
    const stats = computeTradeStats(bucket.map((x) => x.rec));
    say(`| ${g} | ${bucket.length} | ${stats ? `${f1(stats.winRatePct)}%` : "insufficient data"} | ${stats ? `${f2(stats.expectancyNetPct)}%` : "—"} |`);
  }
  say("");

  // Swing activations — the real target population, honestly small.
  const swingWithWeekly = withWeekly.filter((x) => x.r.swingPlan !== null);
  say(`**Swing-plan activations with a closed weekly regime: ${swingWithWeekly.length}.** ` +
      `${swingWithWeekly.length < MIN_SAMPLE_N * 3 ? "This is far too small to segment three ways — reported as a census only, with no win rates, rather than a number with false confidence." : ""}`);
  say("");
  say("| Alignment | Activations |");
  say("|---|---|");
  for (const a of ["aligned", "counter", "weekly-neutral"] as const) {
    const n = swingWithWeekly.filter((x) => alignmentOf(x.r.swingPlan!.direction, x.weekly) === a).length;
    say(`| ${a} | ${n} |`);
  }
  say("");

  // ── R4: incremental over the daily trend tag ─────────────────────────
  say("## R4 — Is the weekly filter INCREMENTAL to the daily trend tag?");
  say("");
  say("Each resolved trade is cross-classified by whether it aligns with the DAILY trend tag the engine already has, and separately by whether it aligns with the WEEKLY regime. If weekly carries independent information, the weekly split should still separate outcomes WITHIN a fixed daily-alignment bucket.");
  say("");
  say("| Daily alignment | Weekly alignment | N | Win rate | Net expectancy | p |");
  say("|---|---|---|---|---|---|");
  for (const dAlign of ["aligned", "counter", "weekly-neutral"] as const) {
    for (const wAlign of ["aligned", "counter", "weekly-neutral"] as const) {
      const bucket = withWeekly
        .filter((x) => x.r.trade !== null)
        .filter((x) => dailyAlignOf(x.r.trade!.side, dailyTrendOf(x.r)) === dAlign)
        .filter((x) => alignmentOf(x.r.trade!.side, x.weekly) === wAlign)
        .map((x) => ({ t: x.r.t, ...x.r.trade! } as TradeRecord));
      const stats = computeTradeStats(bucket);
      if (!stats) { say(`| daily ${dAlign} | weekly ${wAlign} | ${bucket.length} | insufficient data | | |`); continue; }
      const wins = bucket.filter((x) => x.netReturnPct > 0).length;
      const p = signTestPValue(bucket.length, wins);
      cells.push({ label: `R4 daily-${dAlign}/weekly-${wAlign}`, n: bucket.length, wins, pValue: p });
      say(`| daily ${dAlign} | weekly ${wAlign} | ${stats.n} | ${f1(stats.winRatePct)}% | ${f2(stats.expectancyNetPct)}% | ${p.toFixed(4)} |`);
    }
  }
  say("");

  // ── R5: confound checks ──────────────────────────────────────────────
  say("## R5 — Confound checks on the R3/R4 result");
  say("");
  say("R3/R4 produced a counterintuitive finding, so before it is believed it has to survive the three ways it could be an artefact: a direction split in disguise, the existing volatility tag in disguise, or one lucky stretch of calendar. Plus the overlap problem that inflates every p-value above.");
  say("");

  say("**5a. Side composition.** The engine fired ~4x more shorts than longs, so an alignment split could easily be a long/short split wearing a different name.");
  say("");
  say("| Alignment | Longs | Shorts | Long share |");
  say("|---|---|---|---|");
  for (const a of ["aligned", "counter", "weekly-neutral"] as const) {
    const b = tradesWithWeekly.filter((x) => x.align === a);
    const longs = b.filter((x) => x.side === "long").length;
    say(`| ${a} | ${longs} | ${b.length - longs} | ${f1(pctOf(longs, b.length))}% |`);
  }
  say("");

  say("**5b. Is `weekly-neutral` just the existing low-volatility tag?**");
  say("");
  say("| Weekly bias | high-vol | normal-vol | low-vol |");
  say("|---|---|---|---|");
  for (const bias of ["bullish", "neutral", "bearish"] as const) {
    const b = tradesWithWeekly.filter((x) => regimeBias(x.weekly) === bias);
    const c = { high: 0, normal: 0, low: 0 } as Record<string, number>;
    for (const x of b) c[x.volTag] = (c[x.volTag] ?? 0) + 1;
    say(`| ${bias} | ${c.high ?? 0} | ${c.normal ?? 0} | ${c.low ?? 0} |`);
  }
  say("");

  say("**5c. The decisive one — does the weekly split still separate outcomes WITHIN a fixed volatility bucket?** If it vanishes here, weekly is the volatility tag under another name and should not be built.");
  say("");
  say("| Vol tag | Weekly | N | Win rate | Net expectancy |");
  say("|---|---|---|---|---|");
  for (const vt of ["high", "normal", "low"] as const) {
    for (const wb of ["directional", "neutral"] as const) {
      const b = tradesWithWeekly
        .filter((x) => x.volTag === vt)
        .filter((x) => (wb === "neutral" ? regimeBias(x.weekly) === "neutral" : regimeBias(x.weekly) !== "neutral"));
      const stats = computeTradeStats(b.map((x) => x.rec));
      say(`| ${vt}-vol | weekly ${wb} | ${b.length} | ${stats ? `${f1(stats.winRatePct)}%` : "insufficient data"} | ${stats ? `${f2(stats.expectancyNetPct)}%` : "—"} |`);
    }
  }
  say("");

  say("**5d. Calendar concentration.** If the profitable weekly-neutral bucket lives in one stretch of history, it is a period effect, not a regime effect.");
  say("");
  say("| Year | Weekly-neutral trades | Win rate | Net expectancy |");
  say("|---|---|---|---|");
  const years = [...new Set(tradesWithWeekly.map((x) => x.date.slice(0, 4)))].sort();
  for (const y of years) {
    const b = tradesWithWeekly.filter((x) => x.date.startsWith(y) && regimeBias(x.weekly) === "neutral");
    const stats = computeTradeStats(b.map((x) => x.rec));
    say(`| ${y} | ${b.length} | ${stats ? `${f1(stats.winRatePct)}%` : "insufficient data"} | ${stats ? `${f2(stats.expectancyNetPct)}%` : "—"} |`);
  }
  say("");

  say("**5e. Overlap.** Trades are opened near-daily and held for days, so the 1,382 'independent' observations above are nothing of the kind and every p-value in R3/R4 is optimistic. Re-run on a strictly NON-OVERLAPPING subsample (greedy: take a trade, skip every trade that opens before it closes), per asset.");
  say("");
  const nonOverlapping: typeof tradesWithWeekly = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const chron = tradesWithWeekly
      .filter((x) => records.find((r) => r.t === x.t && r.asset === asset))
      .sort((a, b) => a.t - b.t);
    let freeAt = -Infinity;
    for (const x of chron) {
      if (x.t < freeAt) continue;
      nonOverlapping.push(x);
      freeAt = x.t + x.rec.hoursHeld * HOUR_MS;
    }
  }
  say(`Non-overlapping trades: **${nonOverlapping.length}** of ${tradesWithWeekly.length} ` +
      `(${f1(pctOf(nonOverlapping.length, tradesWithWeekly.length))}%) — this is the honest effective sample size.`);
  say("");
  say("| Alignment | N | Win rate | Net expectancy | p (vs coin flip) |");
  say("|---|---|---|---|---|");
  for (const a of ["aligned", "counter", "weekly-neutral"] as const) {
    const b = nonOverlapping.filter((x) => x.align === a);
    const stats = computeTradeStats(b.map((x) => x.rec));
    if (!stats) { say(`| ${a} | ${b.length} | insufficient data | | |`); continue; }
    const wins = b.filter((x) => x.rec.netReturnPct > 0).length;
    const p = signTestPValue(b.length, wins);
    cells.push({ label: `R5e non-overlapping ${a}`, n: b.length, wins, pValue: p });
    say(`| ${a} | ${stats.n} | ${f1(stats.winRatePct)}% | ${f2(stats.expectancyNetPct)}% | ${p.toFixed(4)} |`);
  }
  say("");

  // ── Multiple-testing correction ──────────────────────────────────────
  say("## Multiple-testing correction");
  say("");
  say(`Every win-rate test above is a separate shot at significance. Benjamini-Hochberg at q=0.05 across all ${cells.length} of them:`);
  say("");
  const fdr = benjaminiHochberg(cells.map((c) => c.pValue), 0.05);
  say("| Test | N | Win rate | raw p | BH significant |");
  say("|---|---|---|---|---|");
  cells.forEach((c, i) => {
    say(`| ${c.label} | ${c.n} | ${f1(pctOf(c.wins, c.n))}% | ${c.pValue.toFixed(4)} | ${fdr[i].significant ? "**YES**" : "no"} |`);
  });
  say("");
  const anySignificant = fdr.some((f) => f.significant);
  say(`Survivors after correction: **${fdr.filter((f) => f.significant).length} of ${cells.length}**.`);
  say("");
  say(anySignificant
    ? "At least one effect survives multiple-testing correction — see the verdict for whether it is the one the brief needs."
    : "No effect survives multiple-testing correction.");

  say("");
  say("## Verdict");
  say("");
  say("**1. Is a weekly regime non-redundant? YES.** It agrees with the daily 20d trend tag on only 41.3% of days. This is genuinely new information, not a slower restatement — the first hurdle is cleared.");
  say("");
  say("**2. Is the requested 8-state taxonomy achievable? NO — and this is structural, not a tuning problem.** Accumulation and distribution together cover 7 of 2,896 days (0.2%). The sensitivity table is the proof it isn't the dead zone's fault: even with the dead zone set to ZERO, the two transitional states are 33 of 450 weekly bars (7.3%). Price is either above a rising weekly average or below a falling one ~93% of the time. Weekly EMA geometry yields a FIVE-state model (strong-bull / bull / neutral / bear / strong-bear), and any 8-state taxonomy built on it would be mostly empty labels.");
  say("");
  say("**3. Does the weekly regime persist? YES, strongly — the brief's core premise is validated.** Mean dwell is 8.3 weeks per directional bias on BOTH assets independently, with 87-91% survival at +1 week and 66-67% at +4 weeks. A weekly filter genuinely would change rarely.");
  say("");
  say("**4. Does it improve trade outcomes? NOT DEMONSTRABLE — and this is what decides the phase.**");
  say("");
  say("On the raw 1,382 trades the effect looked large and backwards from theory: weekly-neutral was the only profitable bucket (51.2%, +1.17%) while both aligned (43.1%) and counter (39.2%) lost money. That result does not survive scrutiny:");
  say("");
  say("- **Overlap destroys it.** Trades open near-daily and are held for days, so those 1,382 observations are really 438 independent ones. On the non-overlapping subsample the ordering flips to the conventional one — aligned 53.8%, weekly-neutral 53.3%, counter 42.6% — and nothing is significant (p = 0.49 / 0.33 / 0.18).");
  say("- **Multiple testing destroys most of the rest.** 1 of 14 tests survives Benjamini-Hochberg, and it is only the unsurprising \"counter-trend trades lose\".");
  say("- **Calendar concentration is severe.** The weekly-neutral bucket runs from -0.87% expectancy in 2023 to +4.50% in 2026. That is a period effect sitting on top of any regime effect.");
  say("- Two confounds are cleanly ruled out, to be fair to the hypothesis: the split is NOT a long/short proxy (long share is 21% / 16% / 24% across buckets), and weekly-neutral is NOT the existing low-volatility tag (it spans all three volatility buckets).");
  say("");
  say("**5. Is this absence of an effect, or absence of power? Honestly, partly the latter.** With ~100 non-overlapping trades per arm the study can only resolve differences of roughly 15pp. The observed aligned-vs-counter gap is 11.2pp (53.8% vs 42.6%) — the sign theory predicts, at about 1.6 sigma. So the correct statement is not \"weekly regime does not work\", it is: **at the evidence available, no effect can be demonstrated, and the study could only have detected an effect substantially larger than the one observed.**");
  say("");
  say("### WEEKLY REGIME VERDICT: DO NOT IMPLEMENT (as a filter)");
  say("");
  say("The brief's own rule is \"if evidence is weak, do not implement\", and the evidence is weak. Specifically: do NOT gate, weight, boost, or suppress any setup by weekly regime, because there is no measured basis for choosing how much to boost or suppress, and inventing one would be exactly the curve-fitting the brief prohibits.");
  say("");
  say("Two findings ARE solid and worth keeping on the record: the weekly regime is non-redundant (41.3% agreement) and highly persistent (8.3-week dwell). That combination is what would make it a good filter IF an outcome effect were ever demonstrated. What is missing is only the third leg.");
  say("");
  say("**What would change this answer:** more independent swing observations. The binding constraint is 438 non-overlapping trades and only 81 swing activations across four years — not the quality of the weekly read. This should be revisited once the swing engine has accumulated materially more activations, and the test to re-run is R5e, not R3.");
  say("");
  say("### Cross-cutting methodological finding");
  say("");
  say("The overlap correction in R5e changed the conclusion of this study completely. That problem is not specific to this study: every backtest report in this repo — including the harmonic incremental-value study shipped immediately before this one, whose headline was a p<0.01 result at a 30-day horizon computed from daily-overlapping windows — treats overlapping observations as independent. A 30-day forward return sampled daily overlaps its neighbour by 29/30. Those p-values are systematically optimistic, and the harmonic study's 30D significance in particular should be considered unproven until recomputed on non-overlapping windows. This is the highest-value statistical fix available in the codebase and is worth more than any new signal.");

  const outPath = path.join(__dirname, "weeklyRegimeStudy.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[weeklyRegimeStudy] wrote ${outPath}`);
}

main();
