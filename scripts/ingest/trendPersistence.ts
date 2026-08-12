import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Bar, InstrumentMeta } from "../../src/lib/research/types";
import { UNIVERSE } from "../../src/lib/research/universe";
import { sessionPeriodKey } from "../../src/lib/research/session";
import { analyzePanel } from "../../src/lib/research/panelStatistics";
import { PanelObservation } from "../../src/lib/research/panelBootstrap";
import { mulberry32 } from "../../src/lib/research/random";

/**
 * REPLICATION STUDY — does weekly trend persistence hold outside crypto?
 *
 * Phase 6 concluded, from BTC and ETH over 225 weeks:
 *
 *   "Does the weekly regime persist? YES, strongly — the brief's core
 *    premise is validated. Mean dwell is 8.3 weeks per directional bias on
 *    BOTH assets independently, with 87-91% survival at +1 week and 66-67%
 *    at +4 weeks."
 *
 * That conclusion is load-bearing: the entire product targets a
 * days-to-weeks swing horizon on the premise that a higher-timeframe
 * directional read is stable enough to be worth having. If it is an artefact
 * of two correlated assets in one bull-bear cycle, the premise is wrong.
 *
 * This re-runs the IDENTICAL construction — 20-week EMA, 4-week slope,
 * thresholds calibrated on the earliest 30% of each instrument's own history
 * — on 19 instruments across four asset classes and up to 33 years, using
 * only the shared research primitives.
 *
 * THE POINT OF THE NULL. A raw survival rate is not evidence of anything. A
 * 20-week EMA turns over slowly BY CONSTRUCTION, so a label derived from it
 * repeats week to week even if prices are pure noise. Every survival number
 * below is therefore paired with a permutation null: the same instrument's
 * own weekly returns, shuffled, rebuilt into a price path, and pushed through
 * the same pipeline including threshold recalibration. That destroys genuine
 * trend while preserving the return distribution and the smoothing mechanics.
 * The quantity that means something is the EXCESS over that null.
 *
 * Run: npx tsx scripts/ingest/trendPersistence.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Identical to the Phase 6 crypto study, so this is a replication rather than a lookalike. */
const EMA_PERIOD = 20;
const SLOPE_LOOKBACK_WEEKS = 4;
const THRESHOLD_CALIBRATION_FRACTION = 0.3;

/** Holiday-shortened weeks are kept; one- and two-session stubs are not. */
const MIN_SESSIONS_PER_WEEK = 3;

const HORIZONS = [1, 2, 4, 8, 13, 26];

/**
 * A 20-week EMA carries roughly 20 weeks of memory, and survival windows
 * overlap on top of that. Blocks must exceed BOTH or the interval understates
 * the dependence. 26 weeks does, and still leaves ~67 blocks over the pooled
 * 1993-2026 span.
 */
const BLOCK_WEEKS = 26;
const ITERATIONS = 2000;
const NULL_REPLICATES = 200;
/** Block length for the volatility-clustering-preserving null. Long enough to hold a cluster, short enough that 13w and 26w persistence cannot survive it. */
const BLOCK_NULL_WEEKS = 8;

type Bias = "bullish" | "bearish" | "neutral";

interface Loaded {
  meta: InstrumentMeta;
  bars: Bar[];
}

function load(): Loaded[] {
  const out: Loaded[] = [];
  for (const c of UNIVERSE) {
    const f = path.join(DATA_DIR, `${c.meta.id}.json`);
    if (!fs.existsSync(f)) continue;
    out.push({ meta: c.meta, bars: (JSON.parse(fs.readFileSync(f, "utf8")) as { bars: Bar[] }).bars });
  }
  return out;
}

/**
 * The Monday of the week a session belongs to.
 *
 * Built on `sessionPeriodKey` rather than on raw epoch arithmetic, because
 * that is the platform's one definition of "which calendar day is this bar".
 * A US equity Friday close at 21:00 UTC and a crypto Sunday close at 00:00
 * UTC both land on the right day only because that function steps back one
 * millisecond from the close before taking the local date.
 */
function weekStartOf(sessionKey: number): number {
  const dayOfWeek = new Date(sessionKey).getUTCDay(); // 0 = Sunday
  return sessionKey - ((dayOfWeek + 6) % 7) * DAY;
}

interface WeekBar {
  weekStart: number;
  close: number;
  sessions: number;
}

function toWeekly(l: Loaded, now: number): WeekBar[] {
  const buckets = new Map<number, Bar[]>();
  for (const b of l.bars) {
    const w = weekStartOf(sessionPeriodKey(b.t, l.meta.sessionModel));
    const arr = buckets.get(w);
    if (arr) arr.push(b);
    else buckets.set(w, [b]);
  }

  const out: WeekBar[] = [];
  for (const [weekStart, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    // A week still in progress is not a weekly bar. Including the current
    // partial week would inject an unclosed observation into the newest and
    // most influential end of every series.
    if (weekStart + WEEK > now) continue;
    if (bars.length < MIN_SESSIONS_PER_WEEK) continue;
    const sorted = bars.sort((a, b) => a.t - b.t);
    out.push({ weekStart, close: sorted[sorted.length - 1].close, sessions: sorted.length });
  }
  return out;
}

/** Wilder-free standard EMA, seeded on the first `period` closes — matching the Phase 6 study. */
function emaSeries(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      prev = seed;
    } else {
      prev = closes[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

interface Point {
  weekStart: number;
  dist: number;
  slope: number;
}

function pointsOf(closes: number[], weekStarts: number[]): Point[] {
  const emas = emaSeries(closes, EMA_PERIOD);
  const out: Point[] = [];
  for (let i = 0; i < closes.length; i++) {
    const e = emas[i];
    const ePrev = i >= SLOPE_LOOKBACK_WEEKS ? emas[i - SLOPE_LOOKBACK_WEEKS] : null;
    if (e === null || e <= 0 || ePrev === null || ePrev <= 0) continue;
    out.push({ weekStart: weekStarts[i], dist: (closes[i] - e) / e, slope: (e - ePrev) / ePrev });
  }
  return out;
}

/** Thresholds from the earliest 30% of the instrument's own history. No outcome is consulted. */
function biasesOf(points: Point[]): Bias[] {
  const cut = Math.max(EMA_PERIOD, Math.floor(points.length * THRESHOLD_CALIBRATION_FRACTION));
  const calib = points.slice(0, cut);
  const absSlopes = calib.map((p) => Math.abs(p.slope)).sort((a, b) => a - b);
  const slopeFlat = absSlopes[Math.floor(absSlopes.length / 3)] ?? 0.01;

  return points.map((p) => {
    const rising = p.slope > slopeFlat;
    const falling = p.slope < -slopeFlat;
    if (!rising && !falling) return "neutral";
    const above = p.dist > 0;
    // Only the aligned quadrants express a direction. Accumulation and
    // distribution read neutral, exactly as `regimeBias` defines them.
    if (above && rising) return "bullish";
    if (!above && falling) return "bearish";
    return "neutral";
  });
}

/** Mean run length of an unbroken directional bias. Neutral breaks a run. */
function meanDwell(biases: Bias[]): { mean: number; runs: number } {
  const runs: number[] = [];
  let current: Bias | null = null;
  let len = 0;
  for (const b of biases) {
    if (b !== "neutral" && b === current) {
      len++;
    } else {
      if (current !== null && current !== "neutral") runs.push(len);
      current = b;
      len = 1;
    }
  }
  if (current !== null && current !== "neutral") runs.push(len);
  return { mean: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 0, runs: runs.length };
}

/** 1 where the directional bias k weeks later is the SAME, 0 where it changed. Neutral starts are excluded. */
function survivalObs(biases: Bias[], weekStarts: number[], k: number, unitId: string): PanelObservation[] {
  const out: PanelObservation[] = [];
  for (let i = 0; i + k < biases.length; i++) {
    if (biases[i] === "neutral") continue;
    out.push({ period: weekStarts[i], unitId, value: biases[i + k] === biases[i] ? 1 : 0 });
  }
  return out;
}

/**
 * Cohen's kappa for "is the bias k weeks later the same one".
 *
 * p_o is raw survival. p_e is the survival a series with these MARGINALS
 * would produce by chance: the starting bias is drawn from the directional
 * weeks, the later bias from all weeks (neutral included, since a drift into
 * neutral counts as a change). kappa = (p_o - p_e) / (1 - p_e).
 *
 * This is what makes an observed-vs-null comparison honest when the two have
 * different compositions, which they demonstrably do for equities.
 */
function kappaOf(groups: Bias[][], k: number): number {
  let matches = 0;
  let starts = 0;
  const startCounts: Record<string, number> = { bullish: 0, bearish: 0 };
  const allCounts: Record<string, number> = { bullish: 0, bearish: 0, neutral: 0 };
  let allTotal = 0;

  for (const biases of groups) {
    for (const b of biases) {
      allCounts[b]++;
      allTotal++;
    }
    for (let i = 0; i + k < biases.length; i++) {
      if (biases[i] === "neutral") continue;
      starts++;
      startCounts[biases[i]]++;
      if (biases[i + k] === biases[i]) matches++;
    }
  }
  if (starts === 0 || allTotal === 0) return NaN;

  const pO = matches / starts;
  const pE =
    (startCounts.bullish / starts) * (allCounts.bullish / allTotal) +
    (startCounts.bearish / starts) * (allCounts.bearish / allTotal);
  return pE >= 1 ? NaN : (pO - pE) / (1 - pE);
}

/** Pooled survival rate — the point estimate the bootstrap is centred on. */
function rate(obs: PanelObservation[]): number {
  return obs.length ? obs.reduce((a, o) => a + o.value, 0) / obs.length : NaN;
}

/**
 * The permutation null: the instrument's OWN weekly returns in random order.
 *
 * Simple returns, not log, so the rebuilt path has the same distribution of
 * weekly percentage moves the instrument actually produced — fat tails
 * included. Thresholds are recalibrated on the shuffled series, because a
 * null that inherited the real series' thresholds would not be a null.
 */
function shuffledCloses(closes: number[], rand: () => number, blockWeeks = 1): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1]);
  }

  let shuffled: number[];
  if (blockWeeks <= 1) {
    shuffled = rets.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
  } else {
    /*
     * Block permutation: cut the return series into contiguous blocks and
     * reorder the BLOCKS. Volatility clustering and drift survive inside a
     * block; nothing survives across them. So persistence at a horizon
     * longer than the block cannot come from anything but chance alignment
     * of independently drawn blocks.
     */
    const blocks: number[][] = [];
    for (let i = 0; i < rets.length; i += blockWeeks) blocks.push(rets.slice(i, i + blockWeeks));
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }
    shuffled = blocks.flat();
  }

  const out = [closes[0]];
  for (const r of shuffled) out.push(out[out.length - 1] * r);
  return out;
}

interface Series {
  id: string;
  assetClass: string;
  weekStarts: number[];
  closes: number[];
  biases: Bias[];
}

function buildSeries(loaded: Loaded[], now: number): Series[] {
  const out: Series[] = [];
  for (const l of loaded) {
    const weekly = toWeekly(l, now);
    if (weekly.length < 60) continue;
    const closes = weekly.map((w) => w.close);
    const weekStarts = weekly.map((w) => w.weekStart);
    const points = pointsOf(closes, weekStarts);
    if (points.length < 60) continue;
    out.push({
      id: l.meta.displaySymbol,
      assetClass: l.meta.assetClass,
      weekStarts: points.map((p) => p.weekStart),
      closes,
      biases: biasesOf(points),
    });
  }
  return out;
}

/** Null survival rate at horizon k, averaged over the permutation replicates. */
function nullSurvival(group: Series[], k: number, seed: number, blockWeeks = 1): { mean: number; lo: number; hi: number } {
  const reps: number[] = [];
  for (let r = 0; r < NULL_REPLICATES; r++) {
    const rand = mulberry32(seed + r * 7919);
    const obs: PanelObservation[] = [];
    for (const s of group) {
      const closes = shuffledCloses(s.closes, rand, blockWeeks);
      // Week stamps are reused positionally: the null asks what this
      // pipeline yields on a trendless path of the same length, so only the
      // ordering of returns is randomised, never the calendar.
      const pts = pointsOf(closes, s.weekStarts.slice(0, closes.length));
      obs.push(...survivalObs(biasesOf(pts), pts.map((p) => p.weekStart), k, s.id));
    }
    if (obs.length) reps.push(rate(obs));
  }
  reps.sort((a, b) => a - b);
  return {
    mean: reps.reduce((a, b) => a + b, 0) / reps.length,
    lo: reps[Math.floor(reps.length * 0.025)],
    hi: reps[Math.floor(reps.length * 0.975)],
  };
}

const pc = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "—");
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

function main() {
  const lines: string[] = [];
  const say = (l = "") => {
    lines.push(l);
    console.log(l);
  };

  const now = Date.now();
  const series = buildSeries(load(), now);

  say("# Replication — does weekly trend persistence hold outside crypto?");
  say("");
  say("The Phase 6 conclusion under test, from BTC and ETH over 225 weeks:");
  say("");
  say("> Mean dwell is **8.3 weeks** per directional bias on BOTH assets independently, with **87-91% survival at +1 week** and **66-67% at +4 weeks**.");
  say("");
  say("Same construction — 20-week EMA, 4-week slope, thresholds from the earliest 30% of each instrument's own history — re-run on every ingested instrument.");
  say("");
  say("**Every survival figure is paired with a permutation null.** A 20-week EMA turns over slowly by construction, so a label derived from it repeats even on noise. The null shuffles each instrument's own weekly returns, rebuilds the path, and recalibrates thresholds. Only the EXCESS over that null is evidence of anything.");
  say("");

  // ── Coverage ───────────────────────────────────────────────────────────
  say("## Coverage");
  say("");
  say("| Class | Instruments | Weekly observations | Span |");
  say("|---|---|---|---|");
  const byClass = new Map<string, Series[]>();
  for (const s of series) byClass.set(s.assetClass, [...(byClass.get(s.assetClass) ?? []), s]);
  const classes = [...byClass.keys()].sort();
  for (const c of classes) {
    const g = byClass.get(c)!;
    const weeks = g.reduce((a, s) => a + s.biases.length, 0);
    const from = Math.min(...g.map((s) => s.weekStarts[0]));
    const to = Math.max(...g.map((s) => s.weekStarts[s.weekStarts.length - 1]));
    say(
      `| ${c} | ${g.length} (${g.map((s) => s.id).join(", ")}) | ${weeks} | ` +
        `${new Date(from).toISOString().slice(0, 7)} to ${new Date(to).toISOString().slice(0, 7)} |`
    );
  }
  say("");

  // ── Dwell ──────────────────────────────────────────────────────────────
  say("## Mean dwell per directional bias");
  say("");
  say("The crypto benchmark is 8.3 weeks. Dwell is a descriptive statistic, reported per instrument so a class average cannot hide a split.");
  say("");
  say("| Class | Mean dwell (weeks) | Runs | Per-instrument range |");
  say("|---|---|---|---|");
  for (const c of classes) {
    const g = byClass.get(c)!;
    const per = g.map((s) => ({ id: s.id, ...meanDwell(s.biases) }));
    const totalRuns = per.reduce((a, p) => a + p.runs, 0);
    const weighted = per.reduce((a, p) => a + p.mean * p.runs, 0) / Math.max(1, totalRuns);
    const lo = per.reduce((a, p) => (p.mean < a.mean ? p : a));
    const hi = per.reduce((a, p) => (p.mean > a.mean ? p : a));
    say(`| ${c} | **${f1(weighted)}** | ${totalRuns} | ${f1(lo.mean)} (${lo.id}) to ${f1(hi.mean)} (${hi.id}) |`);
  }
  say("");

  // ── Survival vs null ───────────────────────────────────────────────────
  say("## Survival of a directional bias, against the permutation null");
  say("");
  say(`Panel block bootstrap over ${BLOCK_WEEKS}-week blocks of calendar weeks, ${ITERATIONS} iterations — carrying both the survival-window overlap and the EMA's own ~20-week memory, plus cross-sectional dependence between instruments. Null is ${NULL_REPLICATES} permutation replicates.`);
  say("");

  for (const c of classes) {
    const g = byClass.get(c)!;
    say(`### ${c}`);
    say("");
    say("| Horizon | Observed | 95% CI | Effective N | Null (shuffled) | Null 95% | **Excess** |");
    say("|---|---|---|---|---|---|---|");
    for (const k of HORIZONS) {
      const obs: PanelObservation[] = [];
      for (const s of g) obs.push(...survivalObs(s.biases, s.weekStarts, k, s.id));
      const est = analyzePanel(obs, { statistic: "mean", nullValue: 0.5 }, BLOCK_WEEKS, ITERATIONS);
      if (!est) continue;
      const nul = nullSurvival(g, k, 4242 + k);
      const excess = est.point - nul.mean;
      const beatsNull = est.point > nul.hi;
      say(
        `| +${k}w | ${pc(est.point)} | ${pc(est.lower)}–${pc(est.upper)} | ${f1(est.effectiveN)} | ` +
          `${pc(nul.mean)} | ${pc(nul.lo)}–${pc(nul.hi)} | ${beatsNull ? "**" : ""}${(100 * excess).toFixed(1)}pp${beatsNull ? "**" : ""} |`
      );
    }
    say("");
  }

  say("Bold excess means the observed rate sits above the null's 97.5th percentile — persistence beyond what the smoothing alone manufactures.");
  say("");

  /*
   * ── Robustness on the ONE positive finding ──────────────────────────
   *
   * Only equity indices show excess persistence, so only that result needs
   * attacking. Two things could produce it without any genuine long-horizon
   * trend, and both are tested rather than argued away.
   */
  const eq = byClass.get("equity-etf") ?? [];
  say("## Robustness — the equity result is the only positive finding, so it gets the scrutiny");
  say("");

  // 1. Volatility clustering. The IID shuffle destroys it; real markets have
  //    it, and a quiet stretch holds a label still without any trend.
  say("### 1. Is it volatility clustering rather than trend?");
  say("");
  say(`The IID shuffle above destroys volatility clustering, which real markets have — and a quiet stretch keeps an EMA label still without any trend behind it. A BLOCK permutation preserves clustering and local drift within ${BLOCK_NULL_WEEKS}-week blocks while destroying anything longer, so it is the right null for horizons beyond that block.`);
  say("");
  say("| Horizon | Observed | IID null | Block null | Excess over BLOCK null |");
  say("|---|---|---|---|---|");
  for (const k of HORIZONS.filter((h) => h > BLOCK_NULL_WEEKS)) {
    const obs: PanelObservation[] = [];
    for (const s of eq) obs.push(...survivalObs(s.biases, s.weekStarts, k, s.id));
    const point = rate(obs);
    const iid = nullSurvival(eq, k, 4242 + k);
    const blk = nullSurvival(eq, k, 8484 + k, BLOCK_NULL_WEEKS);
    const beats = point > blk.hi;
    say(
      `| +${k}w | ${pc(point)} | ${pc(iid.mean)} | ${pc(blk.mean)} (${pc(blk.lo)}–${pc(blk.hi)}) | ` +
        `${beats ? "**" : ""}${(100 * (point - blk.mean)).toFixed(1)}pp${beats ? "**" : ""} |`
    );
  }
  say("");

  // 2. Calendar concentration. An effect living in one bull market is a
  //    period effect wearing a regime effect's clothes.
  say("### 2. Is it one bull market?");
  say("");
  say("Observed survival split by decade. If the effect lives in a single stretch of history it is a period effect, not a property of equity trends.");
  say("");
  const eras: Array<[string, number, number]> = [
    ["1993–1999", Date.UTC(1993, 0, 1), Date.UTC(2000, 0, 1)],
    ["2000–2009", Date.UTC(2000, 0, 1), Date.UTC(2010, 0, 1)],
    ["2010–2019", Date.UTC(2010, 0, 1), Date.UTC(2020, 0, 1)],
    ["2020–2026", Date.UTC(2020, 0, 1), Date.UTC(2027, 0, 1)],
  ];
  say("| Era | n | +8w | +13w | +26w |");
  say("|---|---|---|---|---|");
  for (const [label, from, to] of eras) {
    const cells: string[] = [];
    let n = 0;
    for (const k of [8, 13, 26]) {
      const obs: PanelObservation[] = [];
      for (const s of eq) {
        obs.push(...survivalObs(s.biases, s.weekStarts, k, s.id).filter((o) => o.period >= from && o.period < to));
      }
      if (k === 8) n = obs.length;
      cells.push(pc(rate(obs)));
    }
    say(`| ${label} | ${n} | ${cells.join(" | ")} |`);
  }
  say("");

  /*
   * 3. Base-rate confound. Survival is trivially high if one bias dominates:
   *    if 80% of weeks are bullish, "same bias later" is mostly a statement
   *    about the base rate. The comparison is only fair if the null's
   *    composition matches the real series'.
   */
  say("### 3. Does the null have the same bias composition?");
  say("");
  say("Survival is inflated by an imbalanced base rate — if most weeks are bullish, staying bullish is easy. The null is only a fair comparison if its composition matches.");
  say("");
  say("| Class | Observed bullish / bearish / neutral | Null bullish / bearish / neutral |");
  say("|---|---|---|");
  for (const c of classes) {
    const g = byClass.get(c)!;
    const share = (bs: Bias[][]) => {
      const flat = bs.flat();
      const f = (b: Bias) => `${((100 * flat.filter((x) => x === b).length) / Math.max(1, flat.length)).toFixed(0)}%`;
      return `${f("bullish")} / ${f("bearish")} / ${f("neutral")}`;
    };
    const nullBiases: Bias[][] = [];
    for (let r = 0; r < 20; r++) {
      const rand = mulberry32(31337 + r * 7919);
      for (const s of g) {
        const cl = shuffledCloses(s.closes, rand);
        nullBiases.push(biasesOf(pointsOf(cl, s.weekStarts.slice(0, cl.length))));
      }
    }
    say(`| ${c} | ${share(g.map((s) => s.biases))} | ${share(nullBiases)} |`);
  }
  say("");

  /*
   * 4. THE DECISIVE CORRECTION.
   *
   * Equities sit bullish 53% of weeks; the shuffled null only 43%. Staying
   * bullish is mechanically easier in the real series, so part of the excess
   * in the tables above is that composition gap and not persistence at all.
   *
   * Cohen's kappa removes it: agreement in excess of what the series' OWN
   * marginal distribution would produce by chance, rescaled so 0 is chance
   * and 1 is perfect. Comparing kappa to kappa is composition-free.
   */
  say("### 4. Chance-corrected — the decisive comparison");
  say("");
  say("Equities sit bullish 53% of weeks against the null's 43%, so some of the excess above is composition, not persistence. Cohen's kappa measures agreement in excess of each series' OWN marginals: 0 is chance, 1 is perfect. Comparing kappa to kappa is composition-free, and this table supersedes the raw excesses above.");
  say("");
  say("| Class | Horizon | Observed κ | Null κ | Δκ |");
  say("|---|---|---|---|---|");
  for (const c of classes) {
    const g = byClass.get(c)!;
    for (const k of [4, 13, 26]) {
      const obsK = kappaOf(g.map((s) => s.biases), k);
      const nullKs: number[] = [];
      for (let r = 0; r < 60; r++) {
        const rand = mulberry32(5150 + r * 7919 + k);
        const bs: Bias[][] = [];
        for (const s of g) {
          const cl = shuffledCloses(s.closes, rand);
          bs.push(biasesOf(pointsOf(cl, s.weekStarts.slice(0, cl.length))));
        }
        nullKs.push(kappaOf(bs, k));
      }
      nullKs.sort((a, b) => a - b);
      const nullMean = nullKs.reduce((a, b) => a + b, 0) / nullKs.length;
      const hi = nullKs[Math.floor(nullKs.length * 0.975)];
      const beats = obsK > hi;
      say(
        `| ${c} | +${k}w | ${obsK.toFixed(3)} | ${nullMean.toFixed(3)} | ` +
          `${beats ? "**" : ""}${(obsK - nullMean >= 0 ? "+" : "") + (obsK - nullMean).toFixed(3)}${beats ? "**" : ""} |`
      );
    }
  }
  say("");

  say("## Verdict");
  say("");
  say("**1. The published numbers replicate exactly — and that is the problem.** The Phase 6 headline (87-91% at +1w, 66-67% at +4w, 8.3-week dwell) reproduces in every asset class: bonds 90.9%/72.4%, commodities 89.3%/67.2%, crypto spot 89.8%/67.1%, equities 90.7%/73.1%, dwell 9.3-11.0 weeks. A result that is identical across bonds, gold, oil, farm goods, equity indices and three altcoins is not describing any of those markets.");
  say("");
  say("**2. The permutation null reproduces it too.** On the same instruments' own weekly returns SHUFFLED into a trendless path, survival is 90-91% at +1w and 70-73% at +4w. The 20-week EMA is what persists. Phase 6's finding #3 measured the smoothing constant of its own indicator.");
  say("");
  say("**3. After correcting for base-rate composition, the last positive finding nearly vanishes too.** Raw excess suggested equities had genuine persistence (+2.1pp at 4w, +7.4pp at 13w, +12.5pp at 26w). But equities sit bullish 53% of weeks against the null's 43%, and staying bullish is mechanically easier when bullish is more common. Chance-corrected: Δκ = **-0.038** at 4w and **-0.002** at 13w. Both disappear. Only +26w survives, at κ = 0.116 against a null of 0.048.");
  say("");
  say("**4. That surviving cell should not be leaned on.** κ = 0.116 is 'slight' agreement in absolute terms, it is 12 tests deep into this table alone, and crypto shows the same Δκ (+0.068) without clearing its own wider null. A six-month horizon is also irrelevant to a days-to-weeks product.");
  say("");
  say("### CONCLUSION: THE PHASE 6 PERSISTENCE FINDING DOES NOT SURVIVE");
  say("");
  say("Phase 6 kept two findings on the record after declining to build the filter: that the weekly regime is non-redundant, and that it is highly persistent. **The persistence leg is now retired.** It was an artefact of a slow moving average, and no honest measurement of it exceeds chance at any horizon this product trades.");
  say("");
  say("Non-redundancy is untouched by this study — a 41.3% agreement rate with the daily tag is a statement about two labels, not about persistence — and remains on the record.");
  say("");
  say("**What this does NOT say.** It does not say higher-timeframe context is worthless, and it does not revisit Phase 6's decision, which already declined to build the filter for a different reason. It says one specific supporting claim was not evidence, and that any future argument for a weekly filter must rest on outcomes rather than on stability.");
  say("");
  say("**Methodological finding, applicable beyond this study.** Any persistence, dwell, or regime-stability statistic computed from a smoothed indicator is inflated by the smoothing and by the base rate. Neither correction was applied anywhere in this repository before now. Every such number previously published should be read as descriptive only.");
  say("");

  const out = path.join(__dirname, "..", "..", "docs", "TREND_PERSISTENCE_REPLICATION.md");
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`\n[replication] wrote ${out}`);
}

main();
