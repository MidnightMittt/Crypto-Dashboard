/*
 * ── Does the thesis veto know anything? ──────────────────────────────────
 *
 * `buildTradeRecommendation` blocks an entry when `thesis.dominant` opposes
 * `bias.verdict` (tradeRecommendation.ts:139). The RULE is symmetric. The
 * thesis' marginal distribution is not, so the FILTER is not: it removes a
 * large share of long setups and almost no short setups.
 *
 * A filter that fires on one side only is worth keeping if, and only if, the
 * days it removes were worse than the days it keeps. This script asks that
 * directly, and separately per side.
 *
 * "Would the OLD rule have vetoed this day" is read straight off the recorded
 * `thesisDominant` — the pre-deadband condition was exactly "dominant is
 * directional and opposes the bias". The first version of this script inferred
 * it from `action === "no-trade"` instead, which was exact at the time (the
 * replay passes no `evConstraint`, so the record gate cannot fire and a
 * directional bias reaching "no-trade" could only be the veto) but stopped
 * being computable the moment the gate changed, and would have silently
 * started lying rather than erroring. `thesisDominant` is recorded now.
 *
 * Read-only research. Consumes the committed replay output; writes nothing.
 */

import fs from "node:fs";
import path from "node:path";

const RESULTS = path.join(process.cwd(), "scripts/backtest/data/results.json");

interface Row {
  asset: string;
  date: string;
  biasVerdict: string | null;
  action: string | null;
  thesisRegime: string | null;
  thesisConviction: number | null;
  thesisDominant: string | null;
  trade: { side: string; netReturnPct: number } | null;
  forwardReturn1d: number | null;
  forwardReturn3d: number | null;
  forwardReturn7d: number | null;
}

const rows: Row[] = JSON.parse(fs.readFileSync(RESULTS, "utf8"));

if (rows.length && rows[0].thesisDominant === undefined) {
  console.error("results.json predates thesisDominant — re-run `npm run backtest` before this audit.");
  process.exit(1);
}

/* ── The sign convention ──────────────────────────────────────────────────
 * Returns are signed TOWARD the bias direction: positive means the bias was
 * right. This makes long and short groups directly comparable — a mean of
 * +0.5% means the same thing in both.
 */
function signed(r: Row, horizon: "forwardReturn1d" | "forwardReturn3d" | "forwardReturn7d"): number | null {
  const v = r[horizon];
  if (v === null || !Number.isFinite(v)) return null;
  if (r.biasVerdict === "bullish") return v;
  if (r.biasVerdict === "bearish") return -v;
  return null;
}

const directional = rows.filter((r) => r.biasVerdict === "bullish" || r.biasVerdict === "bearish");
/** The OLD rule: any directional `dominant` pointing the other way, no deadband. */
const vetoed = (r: Row) => r.thesisDominant !== null && r.thesisDominant !== "neutral" && r.thesisDominant !== r.biasVerdict;

/* ── 1. The asymmetry, stated as rates ──────────────────────────────────── */
console.log("=".repeat(78));
console.log("1. VETO RATE BY SIDE");
console.log("=".repeat(78));
console.log(`Replay rows: ${rows.length}  (directional bias on ${directional.length})`);
console.log("");
console.log("side      directional-days   vetoed   rate");
for (const side of ["bullish", "bearish"] as const) {
  const g = directional.filter((r) => r.biasVerdict === side);
  const v = g.filter(vetoed).length;
  console.log(
    `${side.padEnd(9)} ${String(g.length).padStart(16)} ${String(v).padStart(8)}   ${((100 * v) / g.length).toFixed(1)}%`
  );
}

/* ── 2. Deterministic block bootstrap ─────────────────────────────────────
 * Daily observations with 1-7 day forward horizons overlap, and BTC/ETH are
 * near-duplicates of each other on the same date. Blocks are drawn over the
 * DATE axis and take both assets with them, so neither source of dependence
 * is treated as independent evidence. No Math.random(): scripts in this repo
 * must be reproducible, so the generator is a seeded LCG.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const BLOCK_DAYS = 10; // >= the 7d horizon, so no block splits an overlap window
const DRAWS = 2000;

function blockSE(sample: Array<{ date: string; v: number }>): number | null {
  if (sample.length < 2) return null;
  const byDate = new Map<string, number[]>();
  for (const s of sample) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s.v);
    byDate.set(s.date, arr);
  }
  const dates = [...byDate.keys()].sort();
  const blocks: number[][] = [];
  for (let i = 0; i < dates.length; i += BLOCK_DAYS) {
    const vals: number[] = [];
    for (const d of dates.slice(i, i + BLOCK_DAYS)) vals.push(...byDate.get(d)!);
    if (vals.length) blocks.push(vals);
  }
  if (blocks.length < 2) return null;
  const rand = lcg(20260913);
  const means: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    let sum = 0;
    let n = 0;
    for (let b = 0; b < blocks.length; b++) {
      const blk = blocks[Math.floor(rand() * blocks.length)];
      for (const v of blk) {
        sum += v;
        n++;
      }
    }
    if (n) means.push(sum / n);
  }
  const m = means.reduce((a, b) => a + b, 0) / means.length;
  return Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / (means.length - 1));
}

function stat(group: Row[], horizon: "forwardReturn1d" | "forwardReturn3d" | "forwardReturn7d") {
  const sample = group
    .map((r) => ({ date: r.date, v: signed(r, horizon) }))
    .filter((x): x is { date: string; v: number } => x.v !== null);
  if (!sample.length) return null;
  const mean = sample.reduce((a, b) => a + b.v, 0) / sample.length;
  return { n: sample.length, mean, se: blockSE(sample), blocks: Math.ceil(new Set(sample.map((s) => s.date)).size / BLOCK_DAYS) };
}

/* ── The SE of the DIFFERENCE, which is the quantity actually being tested ──
 * Two per-group SEs cannot be combined in quadrature here: the groups are
 * complementary subsets of the SAME dates, so they are not independent draws.
 * The difference has to be re-formed inside each bootstrap replicate — resample
 * blocks once, recompute BOTH means from that same resample, difference them.
 * Replicates where a resample happens to contain none of one group are dropped
 * and counted, rather than silently treated as zero.
 */
function diffSE(
  vetoedRows: Row[],
  allowedRows: Row[],
  horizon: "forwardReturn1d" | "forwardReturn3d" | "forwardReturn7d"
): { se: number; dropped: number; blocks: number } | null {
  type Pt = { v: number; vetoed: boolean };
  const byDate = new Map<string, Pt[]>();
  const add = (rowsIn: Row[], isVeto: boolean) => {
    for (const r of rowsIn) {
      const v = signed(r, horizon);
      if (v === null) continue;
      const arr = byDate.get(r.date) ?? [];
      arr.push({ v, vetoed: isVeto });
      byDate.set(r.date, arr);
    }
  };
  add(vetoedRows, true);
  add(allowedRows, false);
  const dates = [...byDate.keys()].sort();
  const blocks: Pt[][] = [];
  for (let i = 0; i < dates.length; i += BLOCK_DAYS) {
    const pts: Pt[] = [];
    for (const d of dates.slice(i, i + BLOCK_DAYS)) pts.push(...byDate.get(d)!);
    if (pts.length) blocks.push(pts);
  }
  if (blocks.length < 2) return null;
  const rand = lcg(20260913);
  const diffs: number[] = [];
  let dropped = 0;
  for (let d = 0; d < DRAWS; d++) {
    let vs = 0, vn = 0, as = 0, an = 0;
    for (let b = 0; b < blocks.length; b++) {
      for (const p of blocks[Math.floor(rand() * blocks.length)]) {
        if (p.vetoed) { vs += p.v; vn++; } else { as += p.v; an++; }
      }
    }
    if (!vn || !an) { dropped++; continue; }
    diffs.push(as / an - vs / vn);
  }
  if (diffs.length < 2) return null;
  const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return { se: Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (diffs.length - 1)), dropped, blocks: blocks.length };
}

/* ── 3. The value test ────────────────────────────────────────────────────
 * If the veto is doing work, VETOED days should have WORSE signed forward
 * returns than ALLOWED days. If they are the same, the veto is removing
 * setups at random. If vetoed days are BETTER, it is removing the good ones.
 */
console.log("");
console.log("=".repeat(78));
console.log("2. SIGNED FORWARD RETURN — VETOED vs ALLOWED (positive = bias was right)");
console.log("=".repeat(78));
console.log("Blocks of 10 dates, both assets moving together, 2000 draws, seed 20260913.");

for (const horizon of ["forwardReturn1d", "forwardReturn3d", "forwardReturn7d"] as const) {
  console.log("");
  console.log(`── ${horizon.replace("forwardReturn", "")} ──`);
  console.log("side     group      n      mean%     blockSE    t");
  for (const side of ["bullish", "bearish"] as const) {
    const g = directional.filter((r) => r.biasVerdict === side);
    const v = stat(g.filter(vetoed), horizon);
    const a = stat(g.filter((r) => !vetoed(r)), horizon);
    for (const [label, s] of [
      ["vetoed", v],
      ["allowed", a],
    ] as const) {
      if (!s) {
        console.log(`${side.padEnd(8)} ${label.padEnd(10)} (empty)`);
        continue;
      }
      const t = s.se && s.se > 0 ? s.mean / s.se : null;
      console.log(
        `${side.padEnd(8)} ${label.padEnd(10)} ${String(s.n).padStart(5)}  ${s.mean.toFixed(3).padStart(8)}  ${
          s.se === null ? "     n/a" : s.se.toFixed(3).padStart(8)
        }  ${t === null ? "  n/a" : t.toFixed(2).padStart(5)}`
      );
    }
    /* The difference is the quantity of interest: does vetoing help? */
    if (v && a) {
      const diff = a.mean - v.mean;
      const ds = diffSE(g.filter(vetoed), g.filter((r) => !vetoed(r)), horizon);
      const dt = ds && ds.se > 0 ? diff / ds.se : null;
      console.log(
        `         → allowed−vetoed        ${diff.toFixed(3).padStart(8)}  ${
          ds ? ds.se.toFixed(3).padStart(8) : "     n/a"
        }  ${dt === null ? "  n/a" : dt.toFixed(2).padStart(5)}   (positive = veto helped)${
          ds && ds.dropped ? `  [${ds.dropped}/${DRAWS} replicates dropped: a group was empty]` : ""
        }`
      );
    }
  }
}

/* ── 4. What the veto is actually keyed on ────────────────────────────────
 * A veto that fires on 3/4 of one side's days is close to a constant. Report
 * the conviction distribution on vetoing days: if the opposing thesis is
 * mostly LOW conviction, the gate is blocking on a read the thesis itself
 * does not stand behind.
 */
console.log("");
console.log("=".repeat(78));
console.log("3. CONVICTION OF THE OPPOSING THESIS ON VETO DAYS");
console.log("=".repeat(78));
const vetoDays = directional.filter(vetoed);
const buckets = new Map<number, number>();
for (const r of vetoDays) {
  const c = r.thesisConviction ?? -1;
  buckets.set(c, (buckets.get(c) ?? 0) + 1);
}
console.log("conviction  days   share   (of the veto's own scale: >=7 Trending, <=2 thin)");
for (const c of [...buckets.keys()].sort((a, b) => a - b)) {
  const n = buckets.get(c)!;
  console.log(`${String(c).padStart(10)}  ${String(n).padStart(5)}  ${((100 * n) / vetoDays.length).toFixed(1).padStart(5)}%`);
}
const thin = vetoDays.filter((r) => (r.thesisConviction ?? 99) <= 2).length;
console.log("");
console.log(`Vetoes issued on a thesis with conviction <= 2 ("thin"): ${thin} of ${vetoDays.length} (${((100 * thin) / vetoDays.length).toFixed(1)}%)`);

/* ── 4b. Where the asymmetry actually comes from ──────────────────────────
 * The veto RULE is symmetric. It fires only when the two layers disagree, so
 * its per-side rate is a property of the two MARGINAL distributions, not of
 * the rule. If both layers lean the same way, disagreement is rare on that
 * side and common on the other — which is a statement about the layers.
 */
console.log("");
console.log("=".repeat(78));
console.log("4b. MARGINAL LOPSIDEDNESS OF THE TWO LAYERS");
console.log("=".repeat(78));
const bull = rows.filter((r) => r.biasVerdict === "bullish").length;
const bear = rows.filter((r) => r.biasVerdict === "bearish").length;
const neut = rows.length - bull - bear;
console.log(`bias.verdict      bullish ${bull} (${((100 * bull) / rows.length).toFixed(1)}%)   bearish ${bear} (${((100 * bear) / rows.length).toFixed(1)}%)   neutral ${neut} (${((100 * neut) / rows.length).toFixed(1)}%)`);
console.log("");
console.log("The veto fires on disagreement. Both layers lean bearish, so they agree on");
console.log("the short side and collide on the long side. The rate gap is the layers'.");

/* ── 4c. Deadband sensitivity ─────────────────────────────────────────────
 * `dominant` is `bullWeight > bearWeight` — a strict inequality with NO
 * deadband, so an arbitrarily thin lean vetoes exactly as hard as a strong
 * one. This scans what requiring conviction would do.
 *
 * READ THIS AS A SENSITIVITY CHECK, NOT A SELECTION PROCEDURE. The threshold
 * shipped is chosen from the file's own published conviction vocabulary
 * (convictionLabel: >=8 Strong, >=5 Moderate, >=2 Weak/Mixed), not from
 * whichever row of this table looks best.
 */
console.log("");
console.log("=".repeat(78));
console.log("4c. DEADBAND SENSITIVITY — vetoes surviving a minimum-conviction requirement");
console.log("=".repeat(78));
console.log("min   label                 long-vetoes  long-rate   short-vetoes  short-rate");
for (const min of [0, 2, 3, 5, 7, 8]) {
  const survives = (r: Row) => vetoed(r) && (r.thesisConviction ?? 0) >= min;
  const lg = directional.filter((r) => r.biasVerdict === "bullish");
  const sg = directional.filter((r) => r.biasVerdict === "bearish");
  const lv = lg.filter(survives).length;
  const sv = sg.filter(survives).length;
  const label = min >= 8 ? "Strong Agreement" : min >= 5 ? "Moderate Agreement" : min >= 2 ? "Weak / Mixed" : "(no deadband, today)";
  console.log(
    `${String(min).padStart(3)}   ${label.padEnd(20)}  ${String(lv).padStart(11)}  ${((100 * lv) / lg.length).toFixed(1).padStart(8)}%  ${String(sv).padStart(12)}  ${((100 * sv) / sg.length).toFixed(1).padStart(9)}%`
  );
}

/* ── 4d. What the veto was actually removing ──────────────────────────────
 * The forward-return test above asks whether the FLAG carries information.
 * This asks the operational question: of the trades that now get taken, how
 * did the ones the old rule would have blocked compare with the ones it
 * already let through? A filter earns its place by removing losers. If the
 * blocked cohort is also profitable, the filter was costing money whatever
 * its t-statistic says.
 *
 * Requires the current results.json, i.e. the post-deadband engine — under
 * the old rule these trades do not exist to measure.
 */
console.log("");
console.log("=".repeat(78));
console.log("4d. THE RELEASED COHORT — trades the old rule would have blocked");
console.log("=".repeat(78));
for (const side of ["long", "short"] as const) {
  const taken = rows.filter((r) => r.trade && r.trade.side === side);
  const released = taken.filter(vetoed);
  const already = taken.filter((r) => !vetoed(r));
  console.log("");
  console.log(`── ${side} ──`);
  console.log("cohort            n      exp%     win%");
  for (const [label, g] of [
    ["released", released],
    ["already-allowed", already],
  ] as const) {
    if (!g.length) {
      console.log(`${label.padEnd(16)} (none)`);
      continue;
    }
    const t = g.map((r) => r.trade!.netReturnPct);
    const m = t.reduce((a, b) => a + b, 0) / t.length;
    console.log(
      `${label.padEnd(16)} ${String(t.length).padStart(4)}  ${m.toFixed(3).padStart(8)}  ${((100 * t.filter((x) => x > 0).length) / t.length).toFixed(1).padStart(6)}`
    );
  }
  /* Paired block bootstrap on the difference, same construction as §2. */
  if (released.length && already.length) {
    const byDate = new Map<string, Array<{ v: number; rel: boolean }>>();
    for (const [g, rel] of [
      [released, true],
      [already, false],
    ] as const) {
      for (const r of g) {
        const arr = byDate.get(r.date) ?? [];
        arr.push({ v: r.trade!.netReturnPct, rel });
        byDate.set(r.date, arr);
      }
    }
    const dates = [...byDate.keys()].sort();
    const blocks: Array<Array<{ v: number; rel: boolean }>> = [];
    for (let i = 0; i < dates.length; i += BLOCK_DAYS) {
      const pts = dates.slice(i, i + BLOCK_DAYS).flatMap((d) => byDate.get(d)!);
      if (pts.length) blocks.push(pts);
    }
    const rand = lcg(20260913);
    const diffs: number[] = [];
    let dropped = 0;
    for (let d = 0; d < DRAWS; d++) {
      let rs = 0, rn = 0, as = 0, an = 0;
      for (let b = 0; b < blocks.length; b++) {
        for (const p of blocks[Math.floor(rand() * blocks.length)]) {
          if (p.rel) { rs += p.v; rn++; } else { as += p.v; an++; }
        }
      }
      if (!rn || !an) { dropped++; continue; }
      diffs.push(as / an - rs / rn);
    }
    if (diffs.length > 1) {
      const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const se = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (diffs.length - 1));
      const relMean = released.reduce((a, r) => a + r.trade!.netReturnPct, 0) / released.length;
      const alrMean = already.reduce((a, r) => a + r.trade!.netReturnPct, 0) / already.length;
      const diff = alrMean - relMean;
      console.log(
        `allowed − released  ${diff.toFixed(3).padStart(8)}   blockSE ${se.toFixed(3)}   t ${(diff / se).toFixed(2)}${
          dropped ? `   [${dropped}/${DRAWS} replicates dropped]` : ""
        }`
      );
      console.log(`${blocks.length} blocks. Positive = the veto was selecting the better trades.`);
    }
  }
}

/* ── 5. Regime label on veto days, for the write-up ──────────────────────── */
console.log("");
console.log("=".repeat(78));
console.log("4. REGIME LABEL ON VETO DAYS");
console.log("=".repeat(78));
const regimes = new Map<string, number>();
for (const r of vetoDays) regimes.set(r.thesisRegime ?? "(null)", (regimes.get(r.thesisRegime ?? "(null)") ?? 0) + 1);
for (const [k, n] of [...regimes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${((100 * n) / vetoDays.length).toFixed(1).padStart(5)}%  ${k}`);
}
