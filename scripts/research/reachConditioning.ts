import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EQUITY_PANEL } from "../../src/lib/markets/equityPanel";
import { Bar } from "../../src/lib/research/types";

/**
 * DOES THE VALIDATED MOMENTUM STATE CONDITION REACH PROBABILITY?
 *
 * The account trades one structure — bought options — and the metric that
 * prices them is breakeven reach: P(the underlying travels X% within the
 * tenor). Today that figure is UNCONDITIONAL: it pools every historical
 * window regardless of the name's state. The platform has exactly one
 * validated signal (momentum-12-1, long leg, on the declared panel). This
 * study asks the narrowest useful question joining them:
 *
 *   Is a name's 21-session UP-reach probability measurably different when
 *   it sits in the top vs bottom third of the panel's own 12-1 momentum
 *   ranking at entry?
 *
 * Declared design, before running:
 *  - Panel: the declared EQUITY_PANEL only (no scraping a data dir).
 *  - Target per name: its own FULL-SAMPLE median 21-session up-excursion,
 *    so unconditional reach ≈ 50% by construction and names pool without a
 *    volatility nuisance. (In-sample target — fine for a CONDITIONING
 *    contrast, since the target is a per-name constant identical across
 *    states; stated, not hidden.)
 *  - Entries: common dates, stride 21 sessions — non-overlapping windows.
 *  - State: 12-1 momentum (252-back to 21-back return), computed point-in-
 *    time at entry, ranked cross-sectionally per date into terciles.
 *  - Test: per date, mean(reach | top tercile) − mean(reach | bottom
 *    tercile); t-statistic over the TIME SERIES of date differences.
 *    Date-blocking is the whole design: names are cross-correlated within
 *    a date (rho ≈ 0.8 has burned this project before), so the honest unit
 *    is the date, not the (name, date) pair.
 *  - Power: report the smallest detectable difference at the realised
 *    number of date blocks. NO figure ships to the site unless the effect
 *    clears it — a conditioned number that cannot be distinguished from
 *    the unconditional one is decoration wearing a condition.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const HORIZON = 21;
const SIDE = (process.env.SIDE ?? "up") as "up" | "down";
const MOM_LONG = 252;
const MOM_SHORT = 21;

interface Loaded { symbol: string; bars: Bar[]; byTime: Map<number, number> }

const loaded = new Map<string, Loaded>();
for (const symbol of EQUITY_PANEL) {
  const f = path.join(DATA_DIR, `${symbol}.US.json`);
  if (!fs.existsSync(f)) continue;
  const bars: Bar[] = (JSON.parse(fs.readFileSync(f, "utf8")).bars ?? []) as Bar[];
  if (bars.length < MOM_LONG + HORIZON + 50) continue;
  loaded.set(symbol, { symbol, bars, byTime: new Map(bars.map((b, i) => [b.t, i])) });
}

// Common calendar: the intersection is fragile across 90 names; instead use
// SPY's dates as the grid and require each name to have that exact bar.
const spy = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "SPY.US.json"), "utf8")).bars as Bar[];
const grid = spy.map((b) => b.t);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per-name target: full-sample median 21-session up-excursion, %. */
const targetPct = new Map<string, number>();
for (const { symbol, bars } of loaded.values()) {
  const moves: number[] = [];
  for (let i = 0; i + HORIZON < bars.length; i++) {
    const entry = bars[i].close;
    if (!(entry > 0)) continue;
    if (SIDE === "up") {
      let hi = -Infinity;
      for (let j = i + 1; j <= i + HORIZON; j++) if (bars[j].high > hi) hi = bars[j].high;
      moves.push((hi / entry - 1) * 100);
    } else {
      let lo = Infinity;
      for (let j = i + 1; j <= i + HORIZON; j++) if (bars[j].low < lo && bars[j].low > 0) lo = bars[j].low;
      moves.push((lo / entry - 1) * 100);
    }
  }
  if (moves.length >= 100) targetPct.set(symbol, median(moves));
}

/** One date block: rank by momentum, record reach outcome per name. */
interface Block { date: string; topReach: number; bottomReach: number; nTop: number; nBottom: number }
const blocks: Block[] = [];

for (let g = MOM_LONG; g + HORIZON < grid.length; g += HORIZON) {
  const t0 = grid[g];
  const rows: { symbol: string; mom: number; reached: boolean }[] = [];

  for (const { symbol, bars, byTime } of loaded.values()) {
    const tgt = targetPct.get(symbol);
    if (tgt === undefined) continue;
    const i = byTime.get(t0);
    if (i === undefined || i < MOM_LONG || i + HORIZON >= bars.length) continue;

    const pNow = bars[i - MOM_SHORT].close; // 12-1: skip the most recent month
    const pThen = bars[i - MOM_LONG].close;
    if (!(pNow > 0 && pThen > 0)) continue;
    const mom = pNow / pThen - 1;

    const entry = bars[i].close;
    const level = entry * (1 + tgt / 100);
    let reached = false;
    for (let j = i + 1; j <= i + HORIZON; j++) {
      if (SIDE === "up" ? bars[j].high >= level : bars[j].low <= level) { reached = true; break; }
    }
    rows.push({ symbol, mom, reached });
  }

  if (rows.length < 30) continue;
  rows.sort((a, b) => b.mom - a.mom);
  const third = Math.floor(rows.length / 3);
  const top = rows.slice(0, third);
  const bottom = rows.slice(rows.length - third);
  blocks.push({
    date: new Date(t0).toISOString().slice(0, 10),
    topReach: top.filter((r) => r.reached).length / top.length,
    bottomReach: bottom.filter((r) => r.reached).length / bottom.length,
    nTop: top.length,
    nBottom: bottom.length,
  });
}

const diffs = blocks.map((b) => b.topReach - b.bottomReach);
const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1));
const se = sd / Math.sqrt(diffs.length);
const t = mean / se;
const topAvg = blocks.reduce((a, b) => a + b.topReach, 0) / blocks.length;
const botAvg = blocks.reduce((a, b) => a + b.bottomReach, 0) / blocks.length;
// Smallest difference detectable at t=2 with this many date blocks.
const detectable = 2 * se;

console.log(`SIDE=${SIDE}`);
console.log(`panel names loaded: ${loaded.size} of ${EQUITY_PANEL.length} declared; with targets: ${targetPct.size}`);
console.log(`date blocks (non-overlapping ${HORIZON}-session, cross-sectionally ranked): ${blocks.length}`);
console.log(`  first ${blocks[0]?.date}  last ${blocks[blocks.length - 1]?.date}  names/block ~${blocks[0]?.nTop! * 3}`);
console.log("");
console.log(`mean reach | TOP momentum tercile:    ${(topAvg * 100).toFixed(1)}%`);
console.log(`mean reach | BOTTOM momentum tercile: ${(botAvg * 100).toFixed(1)}%`);
console.log(`mean per-date difference (top-bottom): ${(mean * 100).toFixed(2)}pp   sd ${(sd * 100).toFixed(1)}pp`);
console.log(`t over ${diffs.length} date blocks: ${t.toFixed(2)}`);
console.log(`smallest detectable difference at t=2: ${(detectable * 100).toFixed(2)}pp`);
console.log("");
console.log(t >= 2 || t <= -2
  ? "DETECTED at the date-block level. Eligible to ship as a conditioned figure IF it also survives a sanity split (see below)."
  : "NOT DETECTED. The conditioned figure would be decoration; report the null and ship nothing.");

// Era split — one regime can own the whole effect (one-slice memory).
const half = Math.floor(blocks.length / 2);
for (const [label, slice] of [["first half", diffs.slice(0, half)], ["second half", diffs.slice(half)]] as const) {
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  const s = Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / (slice.length - 1)) / Math.sqrt(slice.length);
  console.log(`  ${label}: ${(m * 100).toFixed(2)}pp  t=${(m / s).toFixed(2)}  (${slice.length} blocks)`);
}
