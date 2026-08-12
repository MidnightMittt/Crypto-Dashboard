import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord } from "./run";
import { detectHarmonics, HarmonicPattern, Candle } from "./harmonics";
import { levelReached, HourBar } from "../../src/lib/research/tradeExecution";
import { CONTINUOUS_SESSION } from "../../src/lib/research/types";

/**
 * Harmonic pattern study — RESEARCH ONLY, nothing wired to production.
 *
 * Answers one question, and it is NOT "do harmonics win more than half the
 * time": it is whether harmonics add information the engine does not already
 * have from Daily/4H structure, S/R and divergence.
 *
 * Run: npx tsx scripts/backtest/harmonicStudy.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const HORIZONS = [1, 3, 7, 14, 21, 30];
const R_LEVELS = [0.5, 1, 1.5, 2, 3];

/** `open` is carried so the shared level primitive can detect a gap. Crypto never gaps, but the type must not lie. */
interface Bar { t: number; open: number; high: number; low: number; close: number }

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

/** Rolls hourly bars up to a fixed bucket, matching run.ts's own convention. */
function rollUp(hourly: Bar[], hours: number): Candle[] {
  const out: Candle[] = [];
  const size = hours * HOUR;
  let bucket: Bar[] = [];
  let start = 0;
  for (const b of hourly) {
    const s = Math.floor(b.t / size) * size;
    if (s !== start && bucket.length) {
      out.push({ t: bucket[bucket.length - 1].t, open: bucket[0].close, high: Math.max(...bucket.map((x) => x.high)), low: Math.min(...bucket.map((x) => x.low)), close: bucket[bucket.length - 1].close });
      bucket = [];
    }
    start = s;
    bucket.push(b);
  }
  if (bucket.length) out.push({ t: bucket[bucket.length - 1].t, open: bucket[0].close, high: Math.max(...bucket.map((x) => x.high)), low: Math.min(...bucket.map((x) => x.low)), close: bucket[bucket.length - 1].close });
  return out;
}

interface Outcome {
  fwd: Record<number, number | null>;
  maxR: number;
  minR: number;
  stopped: boolean;
}

/**
 * Forward outcome from an arbitrary decision timestamp, direction-adjusted.
 * `stopPrice` defines R; for a harmonic that is the X level.
 */
function outcomeFrom(bars: Bar[], fromT: number, entry: number, stopPrice: number, bullish: boolean): Outcome | null {
  const fwd: Record<number, number | null> = {};
  for (const h of HORIZONS) fwd[h] = null;
  const risk = Math.abs(entry - stopPrice);
  if (risk <= 0 || entry <= 0) return null;

  let maxR = 0;
  let minR = 0;
  let stopped = false;
  const forward = bars.filter((b) => b.t > fromT);
  if (!forward.length) return null;

  for (const b of forward) {
    const heldD = (b.t - fromT) / DAY;
    if (heldD > Math.max(...HORIZONS)) break;
    const fav = ((bullish ? b.high - entry : entry - b.low) / risk);
    const adv = ((bullish ? b.low - entry : entry - b.high) / risk);
    if (fav > maxR) maxR = fav;
    if (adv < minR) minR = adv;
    for (const h of HORIZONS) {
      if (heldD <= h) fwd[h] = ((bullish ? b.close - entry : entry - b.close) / entry) * 100;
    }
    // Shared level primitive, not a hand-written comparison — see targetCalibration.
    if (levelReached(b as HourBar, stopPrice, bullish ? "at-or-below" : "at-or-above", CONTINUOUS_SESSION)) { stopped = true; break; }
  }
  return { fwd, maxR, minR, stopped };
}

interface Row {
  asset: string;
  tf: "1D" | "4H";
  p: HarmonicPattern;
  o: Outcome;
  /** Same pattern measured from the NAIVE timestamp, to quantify stolen hindsight. */
  naive: Outcome | null;
}

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  const mw: MarketWideData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "MARKET.json"), "utf8"));
  const rows: Row[] = [];
  const dayRecords: DayRecord[] = [];
  const barsByAsset = new Map<string, Bar[]>();

  for (const a of ["BTC", "ETH"] as const) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${a}.json`), "utf8")) as RawAssetData;
    const bars = data.futuresKlines as unknown as Bar[];
    barsByAsset.set(a, bars);
    dayRecords.push(...replayAsset(data, mw));

    for (const [tf, hours] of [["1D", 24], ["4H", 4]] as const) {
      const candles = rollUp(bars, hours);
      for (const p of detectHarmonics(candles)) {
        const bullish = p.direction === "bullish";

        /*
         * ENTRY MUST BE THE PRICE AT knownAt, NOT D'S PRICE.
         *
         * This is the subtle trap the whole design exists to avoid, and the
         * first version of this study fell into it. D is a pivot: for a
         * bullish pattern D is a LOW, and the very definition of a fractal
         * low guarantees the next `lookback` bars are higher. Entering at
         * D's price while measuring from `knownAt` therefore books a
         * risk-free gain that no one could have taken — it produced a 87%
         * one-day win rate and a 98.5% Crab, which is what exposed it.
         *
         * By knownAt the pattern is knowable and price has already left D.
         * The only honest entry is the close of that bar.
         */
        const entryBar = bars.find((b) => b.t >= p.knownAtT);
        if (!entryBar) continue;

        const o = outcomeFrom(bars, p.knownAtT, entryBar.close, p.invalidationPrice, bullish);
        if (!o) continue;

        // The naive comparison keeps D's own bar AND D's price — i.e. exactly
        // the hindsight version — so section 2 measures the full gap.
        const naive = outcomeFrom(bars, p.completedAtT, p.completionPrice, p.invalidationPrice, bullish);
        rows.push({ asset: a, tf, p, o, naive });
      }
    }
  }

  say("# Harmonic Pattern Study");
  say();
  say(`Generated ${new Date().toISOString()} · research only, nothing wired to production.`);
  say();

  // ── 1. detection census ──
  say("## 1. Detection census");
  say();
  say(`Total completed patterns: **${rows.length}** (BTC + ETH, Daily + 4H, ~4 years)`);
  say();
  say("| Pattern | 1D | 4H | Bullish | Bearish | Median quality |");
  say("|---|---|---|---|---|---|");
  const names = [...new Set(rows.map((r) => r.p.name))];
  for (const n of names) {
    const rs = rows.filter((r) => r.p.name === n);
    say(
      `| ${n} | ${rs.filter((r) => r.tf === "1D").length} | ${rs.filter((r) => r.tf === "4H").length} | ` +
        `${rs.filter((r) => r.p.direction === "bullish").length} | ${rs.filter((r) => r.p.direction === "bearish").length} | ` +
        `${f2(median(rs.map((r) => r.p.quality)))} |`
    );
  }
  say();

  // ── 2. look-ahead cost ──
  say("## 2. Look-ahead: what the naive timestamp would have stolen");
  say();
  say(
    "Every pattern measured twice. The honest row enters at the CLOSE OF THE BAR AT WHICH THE PATTERN BECAME " +
      "KNOWABLE. The naive row enters at D's own price on D's own bar — which is unobtainable, because a fractal " +
      "low is only a low once the following bars have printed higher. The gap IS the hindsight, and it is large."
  );
  say();
  const withNaive = rows.filter((r) => r.naive);
  say("| Timestamp | n | Median maxR | 1R reached | Stopped |");
  say("|---|---|---|---|---|");
  say(`| knownAt + tradeable entry (honest) | ${withNaive.length} | ${f2(median(withNaive.map((r) => r.o.maxR)))} | ${f1(pct(withNaive.filter((r) => r.o.maxR >= 1).length, withNaive.length))}% | ${f1(pct(withNaive.filter((r) => r.o.stopped).length, withNaive.length))}% |`);
  say(`| completedAt + D-price (naive) | ${withNaive.length} | ${f2(median(withNaive.map((r) => r.naive!.maxR)))} | ${f1(pct(withNaive.filter((r) => r.naive!.maxR >= 1).length, withNaive.length))}% | ${f1(pct(withNaive.filter((r) => r.naive!.stopped).length, withNaive.length))}% |`);
  say();

  // ── 3. forward outcomes ──
  say("## 3. Forward outcomes from knownAt (direction-adjusted)");
  say();
  say(`| Segment | n | ${HORIZONS.map((h) => `${h}d win`).join(" | ")} | Median maxR |`);
  say(`|---|---|${HORIZONS.map(() => "---").join("|")}|---|`);
  const seg = (label: string, rs: Row[]) => {
    if (rs.length < 5) return;
    const cells = HORIZONS.map((h) => {
      const vals = rs.map((r) => r.o.fwd[h]).filter((v): v is number => v !== null);
      return vals.length ? `${f1(pct(vals.filter((v) => v > 0).length, vals.length))}%` : "—";
    });
    say(`| ${label} | ${rs.length} | ${cells.join(" | ")} | ${f2(median(rs.map((r) => r.o.maxR)))} |`);
  };
  seg("ALL harmonics", rows);
  seg("1D only", rows.filter((r) => r.tf === "1D"));
  seg("4H only", rows.filter((r) => r.tf === "4H"));
  seg("bullish", rows.filter((r) => r.p.direction === "bullish"));
  seg("bearish", rows.filter((r) => r.p.direction === "bearish"));
  seg("quality >= 0.8", rows.filter((r) => r.p.quality >= 0.8));
  for (const n of names) seg(n, rows.filter((r) => r.p.name === n));
  say();

  // ── 4. R-level reachability ──
  say("## 4. Probability of reaching each R level (R defined by the X invalidation)");
  say();
  say(`| Segment | n | ${R_LEVELS.map((r) => `${r}R`).join(" | ")} | Stopped |`);
  say(`|---|---|${R_LEVELS.map(() => "---").join("|")}|---|`);
  const rseg = (label: string, rs: Row[]) => {
    if (rs.length < 5) return;
    say(`| ${label} | ${rs.length} | ${R_LEVELS.map((r) => `${f1(pct(rs.filter((x) => x.o.maxR >= r).length, rs.length))}%`).join(" | ")} | ${f1(pct(rs.filter((r) => r.o.stopped).length, rs.length))}% |`);
  };
  rseg("ALL", rows);
  rseg("1D", rows.filter((r) => r.tf === "1D"));
  rseg("4H", rows.filter((r) => r.tf === "4H"));
  rseg("quality >= 0.8", rows.filter((r) => r.p.quality >= 0.8));
  say();

  // ── 5. INCREMENTAL VALUE ──
  say("## 5. Incremental value over the existing engine");
  say();
  say(
    "The question is not whether harmonics win — it is whether they say anything the engine does not already " +
      "know. Baseline is every replayed day with a directional bias; harmonic days are those where a pattern " +
      "became knowable within the prior 3 days AND pointed the same way as the bias."
  );
  say();

  const directional = dayRecords.filter((d) => d.biasVerdict && d.biasVerdict !== "neutral");
  const harmonicByAsset = new Map<string, Row[]>();
  for (const r of rows) {
    if (!harmonicByAsset.has(r.asset)) harmonicByAsset.set(r.asset, []);
    harmonicByAsset.get(r.asset)!.push(r);
  }

  const hasHarmonic = (d: DayRecord, minQuality: number): boolean => {
    const want = d.biasVerdict === "bullish" ? "bullish" : "bearish";
    return (harmonicByAsset.get(d.asset) ?? []).some(
      (r) => r.p.direction === want && r.p.quality >= minQuality && d.t - r.p.knownAtT >= 0 && d.t - r.p.knownAtT <= 3 * DAY
    );
  };

  const fwdWin = (ds: DayRecord[], key: keyof DayRecord) => {
    const vals = ds
      .map((d) => {
        const raw = d[key] as number | null;
        if (raw === null || raw === undefined) return null;
        return d.biasVerdict === "bearish" ? -raw : raw;
      })
      .filter((v): v is number => v !== null);
    if (!vals.length) return null;
    const wins = vals.filter((v) => v > 0).length;
    return { n: vals.length, win: pct(wins, vals.length), ci: wilson(wins, vals.length), mean: mean(vals) };
  };

  say("| Group | n | 7d win | 95% CI | 7d mean | 14d win | 30d win |");
  say("|---|---|---|---|---|---|---|");
  const groups: Array<[string, DayRecord[]]> = [
    ["BASELINE (all directional days)", directional],
    ["+ harmonic agrees", directional.filter((d) => hasHarmonic(d, 0))],
    ["+ HIGH-QUALITY harmonic agrees", directional.filter((d) => hasHarmonic(d, 0.8))],
  ];
  for (const [label, ds] of groups) {
    const w7 = fwdWin(ds, "forwardReturn7d");
    const w14 = fwdWin(ds, "forwardReturn14d");
    const w30 = fwdWin(ds, "forwardReturn30d");
    if (!w7) { say(`| ${label} | 0 | — | — | — | — | — |`); continue; }
    say(
      `| ${label} | ${w7.n} | ${f1(w7.win)}% | ${f1(w7.ci[0])}–${f1(w7.ci[1])}% | ${w7.mean >= 0 ? "+" : ""}${f2(w7.mean)}% | ` +
        `${w14 ? f1(w14.win) + "%" : "—"} | ${w30 ? f1(w30.win) + "%" : "—"} |`
    );
  }
  say();

  const out = path.join(__dirname, "harmonicStudy.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\n[harmonicStudy] wrote ${out}`);
}

main();
