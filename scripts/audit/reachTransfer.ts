import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { BarsPanel } from "../../src/lib/research/barsPanel";
import { atrPctSeries } from "../../src/lib/technicals/indicators";
import {
  REACH_DISTANCE_ATR_BUCKETS,
  REACH_TOUCH_BUCKETS,
} from "../../src/lib/dossier/equityExpectations";

/**
 * DOES THE CALIBRATED REACH TABLE TRANSFER TO A PRICE NOBODY DEFENDS?
 *
 * ── The question, and why it is not academic ──────────────────────────
 *
 * One statistic on this site has a forward record: reach probability.
 * `forwardReachRecord.json` holds 1,171 resolved windows, promised 54.43%,
 * delivered 52.18%. That record is the reason a tradeable option screen can
 * rank by reach at all rather than by something that merely looks
 * decision-relevant.
 *
 * But the record does not calibrate "reach" in general. It calibrates ONE
 * estimator: `reachRateFor(distanceAtr, touches, ...)`, a pooled bucket
 * lookup over levels the replay measured — support and resistance ZONES, at
 * a distance expressed in the symbol's own ATR, over a 10-session window.
 * It takes no symbol argument. Its population is structural levels.
 *
 * An option's breakeven is not a structural level. It is wherever strike plus
 * premium happens to land — a price with no order flow defending it, no touch
 * history, and no reason for anyone to care that it exists. Quoting the
 * structural table at a breakeven is an extrapolation ACROSS POPULATIONS,
 * and the forward record travels with the population it was measured on, not
 * with the word "reach".
 *
 * If structural levels are magnets, the table reads HIGH at a breakeven and
 * every contract on the screen looks likelier to pay than it is. That is the
 * expensive direction, so it gets measured before anything ranks by it.
 *
 * ── What is measured ──────────────────────────────────────────────────
 *
 * The arbitrary-price counterpart of the same estimator, on the same panel,
 * with the same 10-session window and the same bucket edges:
 *
 *   level = close(i) x (1 +- d x atrPct(i)/100)     d in ATR units
 *   reached = any high in (i, i+10] >= level        (up)
 *             any low  in (i, i+10] <= level        (down)
 *
 * No zone, no touch count, no structure of any kind. Just a price that far
 * away. Everything else is held to the replay's convention: Wilder ATR over
 * 14 bars from `atrPctSeries` (same-length-with-nulls, so bar i cannot carry
 * a value computed from bar i+1), interpolated fills dropped because a
 * carried close has zero range and would understate both the ATR and the
 * excursion, and windows that cannot complete DROPPED rather than scored as
 * misses. That last one is not a detail: a truncated window recorded as a
 * miss is a failure scored on evidence that does not exist, and it is the
 * mirror of the censoring that once made the forward record read 100%.
 *
 * ── Why three distances per bucket rather than one ────────────────────
 *
 * The published table gives a rate per BUCKET, and a bucket is wide: the
 * "2 ATR" cell holds every level from 1.0 to 2.0 ATR away. The distances
 * inside it are not uniformly distributed and the replay does not publish
 * their distribution, so there is no single distance at which to evaluate the
 * arbitrary rate and claim a like-for-like comparison. Evaluating at the far
 * edge alone would bias the arbitrary rate LOW — further away is reached less
 * often — and manufacture exactly the magnet effect this script exists to
 * look for.
 *
 * So each bucket is evaluated at its near edge, its midpoint and its far
 * edge, and the structural rate is placed against that RANGE. A structural
 * rate sitting inside the range is unremarkable: the difference is bucket
 * geometry, not population. A structural rate above the NEAR edge cannot be
 * explained by geometry at all — the near edge is the most reachable distance
 * the bucket contains — and that is the magnet finding.
 *
 * ── The second question, which is free once the first is set up ───────
 *
 * The replay's reach cells pool direction: `buildZoneReachCells` records
 * whether a level was reached, never whether it sat above or below. A call
 * needs price UP; a put needs price DOWN. If up and down reach rates differ
 * materially at the same ATR distance, then quoting a pooled table for a call
 * is mis-specified independently of the structural question, and the screen
 * needs a directional estimator whatever the answer to the first question is.
 *
 * Both are reported. Neither is adjusted for the other.
 *
 * ── What this script may not do ───────────────────────────────────────
 *
 * It reads bars and the published reach cells. It does not read the IV/RV
 * collector, the pending forward legs, or any option chain, so it cannot
 * contaminate the screen declared on /validation. It writes nothing.
 *
 *   npx tsx scripts/audit/reachTransfer.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(__dirname_, "..", "..", "src", "data", "barsPanel.json");
const STATS = path.join(__dirname_, "..", "..", "src", "data", "equityExecutionStats.json");

/** The replay's zone window, and the forward record's. Both are 10. */
const HORIZON_SESSIONS = 10;

/** Wilder's period, as every other ATR consumer in the repo uses it. */
const ATR_PERIOD = 14;

/** Bars a symbol needs before it contributes anything. */
const MIN_BARS = ATR_PERIOD + HORIZON_SESSIONS + 30;

interface Bar {
  high: number;
  low: number;
  close: number;
}

interface PublishedCell {
  distanceAtrMax: number;
  touchesMin: number;
  kind?: string;
  source?: string;
  attempts: number;
  reached: number;
  reachRatePct: number;
}

/** Panel rows to bars, interpolated fills dropped — the `realBars` convention. */
function realBars(panel: BarsPanel, symbol: string): Bar[] {
  const sp = panel.symbols[symbol];
  if (!sp) return [];
  const filled = new Set(sp.interpolated);
  const out: Bar[] = [];
  for (let i = 0; i < panel.sessions.length; i++) {
    const row = sp.bars[i];
    if (!row || filled.has(i)) continue;
    out.push({ high: row[1], low: row[2], close: row[3] });
  }
  return out;
}

interface Tally {
  attempts: number;
  reached: number;
  /** Non-overlapping windows the same span would hold. */
  independent: number;
}

const tally = (): Tally => ({ attempts: 0, reached: 0, independent: 0 });

function rate(t: Tally): number | null {
  return t.attempts > 0 ? (t.reached / t.attempts) * 100 : null;
}

/**
 * Reach to an arbitrary price `d` ATR away, over one symbol.
 *
 * Every session with a full forward window is an attempt, which is the
 * replay's convention and means windows OVERLAP. The independent count is
 * carried alongside rather than instead: it is what the rate is worth, and
 * the published table does not report its own.
 */
function measure(
  bars: Bar[],
  atrPct: (number | null)[],
  d: number,
  dir: "up" | "down",
  /**
   * Per-session log drift to remove, in the DRIFT-CONTROLLED pass. The level
   * is a fixed price and the bars walk toward or away from it, so drift is
   * removed by letting the level travel with the trend rather than by
   * rebuilding the bars: a threshold that drifts up at the same rate the name
   * does asks "did price beat its own trend by d ATR", which is the question
   * a mechanism has to answer and a rising tide does not.
   */
  driftPerSession = 0
): Tally {
  const t = tally();
  const last = bars.length - HORIZON_SESSIONS;
  for (let i = ATR_PERIOD; i < last; i++) {
    const a = atrPct[i];
    const close = bars[i].close;
    if (a === null || !(a > 0) || !(close > 0)) continue;
    const move = (d * a) / 100;
    const level = dir === "up" ? close * (1 + move) : close * (1 - move);
    t.attempts++;
    for (let j = i + 1; j <= i + HORIZON_SESSIONS; j++) {
      const threshold = driftPerSession === 0 ? level : level * Math.exp(driftPerSession * (j - i));
      const hit = dir === "up" ? bars[j].high >= threshold : bars[j].low <= threshold;
      if (hit) {
        t.reached++;
        break;
      }
    }
  }
  t.independent = Math.floor(t.attempts / HORIZON_SESSIONS);
  return t;
}

/** Mean per-session log return over the bars actually used. */
function driftOf(bars: Bar[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].close;
    const b = bars[i].close;
    if (a > 0 && b > 0) {
      sum += Math.log(b / a);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function add(into: Tally, from: Tally): void {
  into.attempts += from.attempts;
  into.reached += from.reached;
  into.independent += from.independent;
}

const panel = JSON.parse(fs.readFileSync(PANEL, "utf8")) as BarsPanel;
const stats = JSON.parse(fs.readFileSync(STATS, "utf8")) as { reach?: PublishedCell[] };
const published = stats.reach ?? [];

const symbols = Object.keys(panel.symbols).sort();
const usable: string[] = [];
const dropped: string[] = [];
const loaded = new Map<string, { bars: Bar[]; atrPct: (number | null)[]; drift: number }>();
for (const s of symbols) {
  const bars = realBars(panel, s);
  if (bars.length < MIN_BARS) {
    dropped.push(`${s}@${bars.length}`);
    continue;
  }
  usable.push(s);
  loaded.set(s, { bars, atrPct: atrPctSeries(bars, ATR_PERIOD), drift: driftOf(bars) });
}

console.log(
  `panel: ${panel.sessions.length} sessions ${panel.sessions[0]} -> ` +
    `${panel.sessions[panel.sessions.length - 1]}, ${usable.length} of ${symbols.length} symbols ` +
    `with >= ${MIN_BARS} real bars`
);
console.log(`horizon ${HORIZON_SESSIONS} sessions, ATR Wilder ${ATR_PERIOD}`);
/* Named rather than counted: a silent exclusion reads as full coverage. */
if (dropped.length > 0) console.log(`excluded for short history: ${dropped.join(", ")}`);
{
  const drifts = usable.map((s) => loaded.get(s)!.drift);
  const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const up = drifts.filter((d) => d > 0).length;
  console.log(
    `panel drift: mean ${(mean * 100).toFixed(3)}%/session ` +
      `(${(mean * 252 * 100).toFixed(0)}%/yr annualised), ${up} of ${drifts.length} symbols positive`
  );
}
console.log("");

/*
 * The finite buckets only. `Infinity` is the catch-all the replay uses for
 * anything past 8 ATR and has no far edge to evaluate at, so there is no
 * range to place a structural rate inside.
 */
const buckets = REACH_DISTANCE_ATR_BUCKETS.filter((b) => Number.isFinite(b));

interface Row {
  bucket: number;
  nearEdge: number;
  /** up/down/pooled arbitrary rates at near, mid, far. */
  probes: { d: number; up: number | null; down: number | null; pooled: number | null }[];
  independent: number;
}

const rows: Row[] = [];
for (let bi = 0; bi < buckets.length; bi++) {
  const far = buckets[bi];
  const near = bi === 0 ? 0.1 : buckets[bi - 1];
  const mid = (near + far) / 2;
  const probes: Row["probes"] = [];
  let independent = 0;
  for (const d of [near, mid, far]) {
    const up = tally();
    const down = tally();
    for (const s of usable) {
      const { bars, atrPct } = loaded.get(s)!;
      add(up, measure(bars, atrPct, d, "up"));
      add(down, measure(bars, atrPct, d, "down"));
    }
    const pooled: Tally = {
      attempts: up.attempts + down.attempts,
      reached: up.reached + down.reached,
      independent: up.independent + down.independent,
    };
    if (d === near) independent = pooled.independent;
    probes.push({ d, up: rate(up), down: rate(down), pooled: rate(pooled) });
  }
  rows.push({ bucket: far, nearEdge: near, probes, independent });
}

const pct = (v: number | null) => (v === null ? "    —" : `${v.toFixed(1).padStart(5)}`);

console.log("── an arbitrary price d ATR away, reached within 10 sessions ──");
console.log("  d ATR      up    down  pooled     gap up-down");
for (const r of rows) {
  console.log(`  bucket <= ${r.bucket}`);
  for (const p of r.probes) {
    const gap = p.up !== null && p.down !== null ? p.up - p.down : null;
    console.log(
      `   ${p.d.toFixed(2).padStart(5)}   ${pct(p.up)}   ${pct(p.down)}   ${pct(p.pooled)}` +
        `      ${gap === null ? "—" : `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp`}`
    );
  }
}

/*
 * The comparison the script exists for. Both published populations are shown
 * because they answer different questions — "plan" is the levels the planner
 * actually priced, "zone" is all structure at any distance — and a breakeven
 * resembles neither, so seeing both bounds the extrapolation rather than
 * picking whichever is closer.
 */
console.log("\n── published structural rate against the arbitrary-price range ──");
console.log("  touchesMin 0, kind all. VERDICT reads off the NEAR edge:");
console.log("  a structural rate above it cannot be bucket geometry.\n");
console.log("  bucket  source   struct   arbitrary near..far   verdict");
for (const src of ["plan", "zone"]) {
  for (const r of rows) {
    const cell = published.find(
      (c) =>
        c.distanceAtrMax === r.bucket &&
        c.touchesMin === REACH_TOUCH_BUCKETS[0] &&
        (c.kind ?? "all") === "all" &&
        (c.source ?? "plan") === src
    );
    if (!cell) continue;
    const near = r.probes[0].pooled;
    const far = r.probes[2].pooled;
    if (near === null || far === null) continue;
    const s = cell.reachRatePct;
    const verdict =
      s > near ? `MAGNET  +${(s - near).toFixed(1)}pp over near edge` : s < far ? "below far edge" : "inside range";
    console.log(
      `  ${String(r.bucket).padStart(5)}   ${src.padEnd(6)}  ${s.toFixed(1).padStart(5)}%   ` +
        `${near.toFixed(1).padStart(5)}% .. ${far.toFixed(1).padStart(5)}%      ${verdict}`
    );
  }
  console.log("");
}

/*
 * THE DIRECTION GAP, AGAINST ITS CONTROL.
 *
 * Up reaches more often than down at every distance in the raw pass. The
 * obvious explanation is not a mechanism: this panel is miners, datacentre
 * names and high-beta semis over a period the market rose, and a level above
 * a rising price is reached because the price rose. That is the market, not
 * the screen, and the register already records one finding that turned out to
 * be exactly this.
 *
 * The control removes each symbol's OWN mean session drift by letting the
 * threshold travel with it. What survives is the part of the asymmetry that
 * is not the trend — the genuine skew of the excursion distribution. If the
 * gap collapses, the pooled table is the right thing to quote for a call and
 * no directional adjustment belongs on the screen.
 */
console.log("── the direction gap, raw and with each symbol's own drift removed ──");
console.log("  d ATR    raw up  raw dn   gap    ctl up  ctl dn   gap    survives");
const DRIFT_PROBES = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0];
for (const d of DRIFT_PROBES) {
  const raw = { up: tally(), down: tally() };
  const ctl = { up: tally(), down: tally() };
  for (const s of usable) {
    const { bars, atrPct, drift } = loaded.get(s)!;
    add(raw.up, measure(bars, atrPct, d, "up"));
    add(raw.down, measure(bars, atrPct, d, "down"));
    add(ctl.up, measure(bars, atrPct, d, "up", drift));
    add(ctl.down, measure(bars, atrPct, d, "down", drift));
  }
  const ru = rate(raw.up)!;
  const rd = rate(raw.down)!;
  const cu = rate(ctl.up)!;
  const cd = rate(ctl.down)!;
  const rawGap = ru - rd;
  const ctlGap = cu - cd;
  const share = rawGap !== 0 ? (ctlGap / rawGap) * 100 : 0;
  console.log(
    `   ${d.toFixed(2).padStart(5)}   ${pct(ru)}   ${pct(rd)}  ${(rawGap >= 0 ? "+" : "") + rawGap.toFixed(1)}pp   ` +
      `${pct(cu)}   ${pct(cd)}  ${(ctlGap >= 0 ? "+" : "") + ctlGap.toFixed(1)}pp    ${share.toFixed(0)}% of raw`
  );
}

const totalIndependent = rows[0]?.independent ?? 0;
console.log(
  `\narbitrary-price rates rest on ~${totalIndependent.toLocaleString()} non-overlapping windows ` +
    `across ${usable.length} correlated symbols, so the honest breadth is lower still. ` +
    `The published cells report attempts only and carry no independence count of their own.`
);
