import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord } from "./run";
import { levelReached, HourBar } from "../../src/lib/research/tradeExecution";
import { CONTINUOUS_SESSION } from "../../src/lib/research/types";

/**
 * Target calibration study — RESEARCH ONLY. Changes no production target.
 *
 * METHOD. Rather than testing a list of target methodologies one at a time —
 * which invites picking whichever cell looks best — this measures the thing
 * every target methodology is ultimately betting on:
 *
 *     HOW FAR, IN R, DOES A FILLED PLAN ACTUALLY TRAVEL BEFORE ITS STOP?
 *
 * Each plan is resolved with its production entry and production stop but NO
 * TARGET AT ALL, held until the stop or the horizon. Recording the maximum
 * favourable excursion in R gives the complete distribution, and from that the
 * hit rate of ANY fixed-R target follows arithmetically:
 *
 *     P(target at X R hits) = P(maxR >= X)
 *
 * No target methodology can beat that curve; every one of them is just a rule
 * for choosing X. Expectancy at each X then follows from the same run, with no
 * additional fitting and nothing to overfit — there are no free parameters.
 *
 * LOOK-AHEAD. Entry, stop and the plan itself come from the production replay
 * at the historical close. Only the OUTCOME uses subsequent bars, which is
 * what an outcome is. No future information constructs any level.
 *
 * Run: npx tsx scripts/backtest/targetCalibration.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** How long a planned entry may stay unfilled before it expires. */
const FILL_WINDOW_DAYS = 14;
/** Swing-relevant horizons the study reports over. */
const HORIZON_DAYS = [1, 3, 7, 14, 21, 30];
/** R multiples tested as candidate targets. */
const R_LEVELS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];

/** `open` is carried so the shared level primitive can detect a gap. Crypto never gaps, but the type must not lie. */
interface Bar { t: number; open: number; high: number; low: number; close: number }
type Plan = NonNullable<DayRecord["swingPlan"]>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(100 * (c - s)) / d, (100 * (c + s)) / d];
}

interface Excursion {
  asset: string;
  t: number;
  direction: "long" | "short";
  regime: string;
  /** Max favourable excursion in R before the stop was hit (or the horizon ended). */
  maxR: number;
  /** Whether the stop was hit at all within the horizon. */
  stopped: boolean;
  /** Hours from fill to the stop, when stopped. */
  hoursToStop: number | null;
  /** Hours from fill to the moment maxR was first reached. */
  hoursToMaxR: number;
  /** maxR restricted to each horizon, so target reachability can be reported per holding period. */
  maxRByHorizon: Record<number, number>;
}

/**
 * Resolves a plan with NO TARGET: fill on first touch of the entry zone, then
 * hold until the stop or `horizonDays`, recording how far it travelled.
 */
function excursionOf(plan: Plan, bars: Bar[], fromT: number, horizonDays: number): Excursion | null {
  const isLong = plan.direction === "long";
  const forward = bars.filter((b) => b.t > fromT);

  const fillIdx = forward.findIndex(
    (b) => b.t - fromT <= FILL_WINDOW_DAYS * DAY && b.low <= plan.entryHigh && b.high >= plan.entryLow
  );
  if (fillIdx === -1) return null;

  const fill = forward[fillIdx];
  const entry = plan.entryRef;
  const risk = Math.abs(entry - plan.stopPrice);
  if (risk <= 0) return null;

  const rOf = (px: number) => ((isLong ? px - entry : entry - px) / risk);

  let maxR = 0;
  let hoursToMaxR = 0;
  let stopped = false;
  let hoursToStop: number | null = null;
  const maxRByHorizon: Record<number, number> = {};
  for (const h of HORIZON_DAYS) maxRByHorizon[h] = 0;

  for (let i = fillIdx; i < forward.length; i++) {
    const b = forward[i];
    const heldH = (b.t - fill.t) / HOUR;
    const heldD = heldH / 24;
    if (heldD > horizonDays) break;

    const favourable = rOf(isLong ? b.high : b.low);
    if (favourable > maxR) {
      maxR = favourable;
      hoursToMaxR = heldH;
    }
    for (const h of HORIZON_DAYS) {
      if (heldD <= h && favourable > maxRByHorizon[h]) maxRByHorizon[h] = favourable;
    }

    // Stop checked after recording the bar's favourable extreme, and the loop
    // ends here: the same pessimistic intrabar convention resolveTrade uses.
    // Routed through the SHARED level primitive rather than re-deriving the
    // comparison, so this study cannot drift from the canonical exit rule and
    // is gap-safe if it is ever pointed at a session market.
    if (levelReached(b as HourBar, plan.stopPrice, isLong ? "at-or-below" : "at-or-above", CONTINUOUS_SESSION)) {
      stopped = true;
      hoursToStop = heldH;
      break;
    }
  }

  return { asset: "", t: fromT, direction: plan.direction, regime: "", maxR, stopped, hoursToStop, hoursToMaxR, maxRByHorizon };
}

/**
 * Expectancy of a target placed at `r`, in R, assuming the trade is exited at
 * the target if reached and at the stop otherwise.
 *
 * A plan that reached `r` is counted as +r; one that stopped without reaching
 * it as -1; one that neither reached nor stopped inside the horizon is scored
 * at its terminal excursion, which is the honest treatment of an open trade
 * rather than silently dropping it.
 */
function expectancyAt(xs: Excursion[], r: number): { hitPct: number; ci: [number, number]; expectancy: number } {
  let total = 0;
  let hits = 0;
  for (const x of xs) {
    if (x.maxR >= r) {
      hits++;
      total += r;
    } else if (x.stopped) {
      total += -1;
    } else {
      total += x.maxR; // still open at the horizon; credit what it actually had
    }
  }
  return { hitPct: pct(hits, xs.length), ci: wilson(hits, xs.length), expectancy: total / Math.max(1, xs.length) };
}

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  const mw: MarketWideData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "MARKET.json"), "utf8"));
  const records: DayRecord[] = [];
  const barsByAsset = new Map<string, Bar[]>();
  for (const a of ["BTC", "ETH"] as const) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${a}.json`), "utf8")) as RawAssetData;
    records.push(...replayAsset(data, mw));
    barsByAsset.set(a, data.futuresKlines as unknown as Bar[]);
  }

  const MAX_H = Math.max(...HORIZON_DAYS);
  const excursions: Excursion[] = [];
  for (const d of records) {
    if (!d.swingPlan) continue;
    const bars = barsByAsset.get(d.asset);
    if (!bars) continue;
    const e = excursionOf(d.swingPlan, bars, d.t, MAX_H);
    if (!e) continue;
    e.asset = d.asset;
    e.regime = d.regimeTags?.join(" · ") ?? "unlabelled";
    excursions.push(e);
  }

  say("# Target Calibration Study");
  say();
  say(`Generated ${new Date().toISOString()} · research only, no production target changed.`);
  say();
  say(
    "Every plan resolved with its **production entry and production stop but no target**, held to the stop " +
      `or ${MAX_H} days. The maximum favourable excursion in R is then the complete answer to what any target ` +
      "could have achieved: `P(target at X R hits) = P(maxR ≥ X)`. No methodology can beat that curve — each is " +
      "only a rule for choosing X — so there is nothing here to overfit."
  );
  say();
  say(`Filled plans analysed: **${excursions.length}** (of ${records.filter((r) => r.swingPlan).length} plans).`);
  say();

  // ── 1. excursion distribution ──
  say("## 1. How far do filled plans actually travel?");
  say();
  const all = excursions.map((e) => e.maxR).sort((a, b) => a - b);
  const q = (f: number) => all[Math.floor(all.length * f)];
  say("| Percentile | max R reached |");
  say("|---|---|");
  for (const [label, f] of [["p10", 0.1], ["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["p90", 0.9], ["max", 0.999]] as const) {
    say(`| ${label} | ${f2(q(f as number))}R |`);
  }
  say();
  say(`Stop hit within the horizon: **${f1(pct(excursions.filter((e) => e.stopped).length, excursions.length))}%**`);
  say(`Median hours to peak excursion: ${f1(median(excursions.map((e) => e.hoursToMaxR)))}h`);
  say(`Median hours to stop (when stopped): ${f1(median(excursions.filter((e) => e.stopped).map((e) => e.hoursToStop ?? 0)))}h`);
  say();

  // ── 2. the target curve ──
  say("## 2. Hit rate and expectancy by target distance");
  say();
  say("This is the whole study in one table. Expectancy is in R.");
  say();
  say("| Target | Hit rate | 95% CI | Expectancy (R) |");
  say("|---|---|---|---|");
  for (const r of R_LEVELS) {
    const e = expectancyAt(excursions, r);
    say(`| ${f1(r)}R | ${f1(e.hitPct)}% | ${f1(e.ci[0])}–${f1(e.ci[1])}% | ${e.expectancy >= 0 ? "+" : ""}${f2(e.expectancy)} |`);
  }
  say();

  // ── 3. by horizon ──
  say("## 3. Target reachability by holding period");
  say();
  say("Share of filled plans whose excursion reached each R level WITHIN each horizon.");
  say();
  say(`| Horizon | ${R_LEVELS.map((r) => `${r}R`).join(" | ")} |`);
  say(`|---|${R_LEVELS.map(() => "---").join("|")}|`);
  for (const h of HORIZON_DAYS) {
    const cells = R_LEVELS.map((r) => `${f1(pct(excursions.filter((e) => e.maxRByHorizon[h] >= r).length, excursions.length))}%`);
    say(`| ${h}d | ${cells.join(" | ")} |`);
  }
  say();

  // ── 4. segments ──
  say("## 4. Segments");
  say();
  say("| Segment | n | Median maxR | Stop% | 1R hit | 2R hit | 3R hit |");
  say("|---|---|---|---|---|---|---|");
  const segs: Array<[string, Excursion[]]> = [
    ["all", excursions],
    ["long", excursions.filter((e) => e.direction === "long")],
    ["short", excursions.filter((e) => e.direction === "short")],
    ["BTC", excursions.filter((e) => e.asset === "BTC")],
    ["ETH", excursions.filter((e) => e.asset === "ETH")],
  ];
  for (const [label, xs] of segs) {
    if (!xs.length) continue;
    say(
      `| ${label} | ${xs.length} | ${f2(median(xs.map((e) => e.maxR)))}R | ${f1(pct(xs.filter((e) => e.stopped).length, xs.length))}% | ` +
        `${f1(expectancyAt(xs, 1).hitPct)}% | ${f1(expectancyAt(xs, 2).hitPct)}% | ${f1(expectancyAt(xs, 3).hitPct)}% |`
    );
  }
  say();

  // ── 5. IS / OOS / walk-forward on the chosen curve ──
  say("## 5. In-sample / out-of-sample / walk-forward");
  say();
  const sorted = [...excursions].sort((a, b) => a.t - b.t);
  const cut = Math.floor(sorted.length * 0.6);
  say("| Window | n | 1R hit | 2R hit | 3R hit | Best-expectancy target |");
  say("|---|---|---|---|---|---|");
  const best = (xs: Excursion[]) => {
    let bR = R_LEVELS[0];
    let bE = -Infinity;
    for (const r of R_LEVELS) {
      const e = expectancyAt(xs, r).expectancy;
      if (e > bE) { bE = e; bR = r; }
    }
    return `${f1(bR)}R (${bE >= 0 ? "+" : ""}${f2(bE)})`;
  };
  for (const [label, xs] of [["IS (first 60%)", sorted.slice(0, cut)], ["OOS (last 40%)", sorted.slice(cut)]] as const) {
    say(`| ${label} | ${xs.length} | ${f1(expectancyAt(xs, 1).hitPct)}% | ${f1(expectancyAt(xs, 2).hitPct)}% | ${f1(expectancyAt(xs, 3).hitPct)}% | ${best(xs)} |`);
  }
  const FOLDS = 5;
  for (let f = 0; f < FOLDS; f++) {
    const size = Math.floor(sorted.length / FOLDS);
    const xs = sorted.slice(f * size, (f + 1) * size);
    if (xs.length < 8) continue;
    say(`| fold ${f + 1} | ${xs.length} | ${f1(expectancyAt(xs, 1).hitPct)}% | ${f1(expectancyAt(xs, 2).hitPct)}% | ${f1(expectancyAt(xs, 3).hitPct)}% | ${best(xs)} |`);
  }
  say();

  const out = path.join(__dirname, "targetCalibration.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\n[targetCalibration] wrote ${out}`);
}

main();
