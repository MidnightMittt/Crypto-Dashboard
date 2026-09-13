/**
 * WHY THE SHORT BOOK LOSES MONEY.
 *
 * The execution replay reports 961 shorts at -0.128% net expectancy (PF 0.945)
 * against 239 longs at +2.141% (PF 2.73). That is the largest unexplained
 * number on the site, and "shorts are bad" is not a diagnosis.
 *
 * A short's return decomposes into three things that are worth separating
 * because they have three different fixes:
 *
 *   1. DRIFT      — what a short loses simply by being short an asset that
 *                   rose over the holding window. Fix: don't be short, or be
 *                   short less often. Nothing to do with signal quality.
 *   2. TIMING     — whether the engine picks moments that fall MORE than
 *                   average. This is the only part that is signal. Fix: a
 *                   better signal, or stop claiming this one works.
 *   3. MACHINERY  — what the stop / target / time-stop add or destroy versus
 *                   simply holding the same window. Fix: plan geometry.
 *
 * The decomposition is exact rather than modelled, because a timeout closes at
 * exactly 168h and `forwardReturn7d` is the underlying's return over exactly
 * 168h from the same timestamp. So `-forwardReturn7d` IS the passive short over
 * the identical window — not a proxy for it. Verified on timeout rows, where
 * grossReturnPct == -forwardReturn7d to the last decimal.
 *
 * Read-only. Regenerates nothing. Run: npx tsx scripts/audit/shortBook.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Trade {
  side: "long" | "short";
  outcome: string;
  grossReturnPct: number;
  netReturnPct: number;
  feeAndSlippagePct: number;
  fundingCostPct: number;
  mfePct: number;
  maePct: number;
  hoursHeld: number;
}

interface Row {
  asset: string;
  date: string;
  action: string;
  biasScore: number;
  biasVerdict: string;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  trade: Trade | null;
  forwardReturn7d: number | null;
}

const rows: Row[] = JSON.parse(
  readFileSync(resolve("scripts/backtest/data/results.json"), "utf8"),
);

/* Seeded — Math.random() would make this irreproducible across runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const BLOCK_DAYS = 10;
const DRAWS = 4000;

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * Block bootstrap over the DATE axis, carrying BTC and ETH together so
 * cross-sectional correlation is absorbed by construction, with block length
 * >= the 7d forward horizon so overlap is absorbed too.
 *
 * `valueOf` may return null to exclude a row; a statistic is the mean over the
 * rows that survive inside each replicate. For a DIFFERENCE between two
 * subsets, pass both selectors and the difference is re-formed inside every
 * replicate — the two groups share dates and are not independent, so their SEs
 * cannot be combined in quadrature afterwards.
 */
function blockBootstrap(
  pool: Row[],
  valueA: (r: Row) => number | null,
  valueB: ((r: Row) => number | null) | null,
  seed: number,
): { point: number; se: number; t: number; blocks: number; nA: number; nB: number } {
  const dates = [...new Set(pool.map((r) => r.date))].sort();
  const byDate = new Map<string, Row[]>();
  for (const r of pool) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const blocks: Row[][] = [];
  for (let i = 0; i + BLOCK_DAYS <= dates.length; i += BLOCK_DAYS) {
    blocks.push(dates.slice(i, i + BLOCK_DAYS).flatMap((d) => byDate.get(d) ?? []));
  }

  const stat = (sample: Row[]): number | null => {
    const a: number[] = [];
    const b: number[] = [];
    for (const r of sample) {
      const va = valueA(r);
      if (va !== null) a.push(va);
      if (valueB) {
        const vb = valueB(r);
        if (vb !== null) b.push(vb);
      }
    }
    if (!a.length) return null;
    if (!valueB) return mean(a);
    if (!b.length) return null;
    return mean(a) - mean(b);
  };

  const point = stat(pool);
  const rand = lcg(seed);
  const reps: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const sample: Row[] = [];
    for (let k = 0; k < blocks.length; k++) sample.push(...blocks[Math.floor(rand() * blocks.length)]);
    const s = stat(sample);
    if (s !== null) reps.push(s);
  }
  const m = mean(reps);
  const se = Math.sqrt(mean(reps.map((x) => (x - m) ** 2)));
  const nA = pool.filter((r) => valueA(r) !== null).length;
  const nB = valueB ? pool.filter((r) => valueB(r) !== null).length : 0;
  return { point: point ?? NaN, se, t: (point ?? NaN) / se, blocks: blocks.length, nA, nB };
}

const shorts = rows.filter((r) => r.trade?.side === "short");
const longs = rows.filter((r) => r.trade?.side === "long");

console.log(`\n=== SHORT BOOK DIAGNOSIS — ${shorts.length} shorts, ${longs.length} longs ===`);
console.log(`block bootstrap: ${BLOCK_DAYS}-day blocks over the date axis, ${DRAWS} draws, BTC+ETH together\n`);

/* ── 1. Is the short book even a decision? ───────────────────────────────── */
console.log("── 1. How the engine arrives at 4x as many shorts as longs ──");
const verdictCount = new Map<string, number>();
for (const r of rows) verdictCount.set(r.biasVerdict, (verdictCount.get(r.biasVerdict) ?? 0) + 1);
for (const [v, n] of [...verdictCount].sort((a, b) => b[1] - a[1])) {
  console.log(`  bias ${v.padEnd(9)} ${String(n).padStart(5)}  ${((n / rows.length) * 100).toFixed(1)}%`);
}
const scores = rows.map((r) => r.biasScore).sort((a, b) => a - b);
const q = (p: number) => scores[Math.floor(p * (scores.length - 1))];
console.log(
  `  biasScore  min ${q(0)}  p10 ${q(0.1)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  max ${q(1)}  mean ${mean(scores).toFixed(2)}`,
);
console.log(`  share of days with biasScore < 50: ${((scores.filter((s) => s < 50).length / scores.length) * 100).toFixed(1)}%`);

/* ── 2. TIMING: does a short entry pick moments that fall more than average? ─ */
console.log("\n── 2. TIMING — underlying 7d return, short-entry days vs everything else ──");
const fwd = (r: Row) => (r.forwardReturn7d ?? null);
const isShort = (r: Row) => r.trade?.side === "short";
const isLong = (r: Row) => r.trade?.side === "long";

for (const [label, sel] of [
  ["short-entry days", isShort],
  ["long-entry days", isLong],
] as Array<[string, (r: Row) => boolean]>) {
  const d = blockBootstrap(
    rows,
    (r) => (sel(r) ? fwd(r) : null),
    (r) => (!sel(r) ? fwd(r) : null),
    20260913,
  );
  const own = mean(rows.filter(sel).map(fwd).filter((x): x is number => x !== null));
  const other = mean(rows.filter((r) => !sel(r)).map(fwd).filter((x): x is number => x !== null));
  console.log(
    `  ${label.padEnd(18)} own ${pct(own)}  rest ${pct(other)}  diff ${pct(d.point)}  blockSE ${d.se.toFixed(3)}  t=${d.t.toFixed(2)}  (n=${d.nA} vs ${d.nB}, ${d.blocks} blocks)`,
  );
}
console.log("  A short needs the underlying to FALL. A negative diff on the short row is edge; a positive diff is anti-edge.");

/* ── 3. DRIFT vs MACHINERY: actual short return vs the passive short ─────── */
console.log("\n── 3. DECOMPOSITION — actual short vs passive short over the identical 168h ──");
const passiveShort = (r: Row) => (isShort(r) && r.forwardReturn7d !== null ? -r.forwardReturn7d : null);
const actualShort = (r: Row) => (isShort(r) ? (r.trade as Trade).netReturnPct : null);
const grossShort = (r: Row) => (isShort(r) ? (r.trade as Trade).grossReturnPct : null);

const passiveMean = mean(shorts.map(passiveShort).filter((x): x is number => x !== null));
const actualMean = mean(shorts.map(actualShort).filter((x): x is number => x !== null));
const grossMean = mean(shorts.map(grossShort).filter((x): x is number => x !== null));
const feeMean = mean(shorts.map((r) => (r.trade as Trade).feeAndSlippagePct));
const fundMean = mean(shorts.map((r) => (r.trade as Trade).fundingCostPct));

console.log(`  passive short, hold 168h, no stop/target, no costs : ${pct(passiveMean)}`);
console.log(`  actual short, gross (stop/target/time-stop applied) : ${pct(grossMean)}`);
console.log(`  actual short, net                                  : ${pct(actualMean)}`);
console.log(`    fee+slippage drag ${pct(-feeMean)}   funding ${pct(-fundMean)} (negative = short PAID, positive = short RECEIVED)`);
const machinery = blockBootstrap(rows, grossShort, passiveShort, 20260914);
console.log(
  `  machinery contribution (gross - passive) ${pct(machinery.point)}  blockSE ${machinery.se.toFixed(3)}  t=${machinery.t.toFixed(2)}  (${machinery.blocks} blocks)`,
);

const passiveLong = (r: Row) => (isLong(r) && r.forwardReturn7d !== null ? r.forwardReturn7d : null);
const grossLong = (r: Row) => (isLong(r) ? (r.trade as Trade).grossReturnPct : null);
const machL = blockBootstrap(rows, grossLong, passiveLong, 20260915);
console.log(
  `  same for longs: passive ${pct(mean(longs.map(passiveLong).filter((x): x is number => x !== null)))}  gross ${pct(mean(longs.map(grossLong).filter((x): x is number => x !== null)))}  machinery ${pct(machL.point)}  blockSE ${machL.se.toFixed(3)}  t=${machL.t.toFixed(2)}`,
);

/* ── 4. Payoff geometry: what win rate would this stop/target need? ──────── */
console.log("\n── 4. PAYOFF GEOMETRY — the win rate each side's plan requires ──");
for (const [label, book] of [["short", shorts], ["long", longs]] as Array<[string, Row[]]>) {
  const wins = book.filter((r) => (r.trade as Trade).netReturnPct > 0);
  const losses = book.filter((r) => (r.trade as Trade).netReturnPct <= 0);
  const aw = mean(wins.map((r) => (r.trade as Trade).netReturnPct));
  const al = Math.abs(mean(losses.map((r) => (r.trade as Trade).netReturnPct)));
  const winRate = wins.length / book.length;
  const breakeven = al / (aw + al);
  console.log(
    `  ${label.padEnd(6)} avg win ${pct(aw)}  avg loss ${pct(-al)}  payoff ${(aw / al).toFixed(2)}x  win rate ${(winRate * 100).toFixed(1)}%  breakeven needs ${(breakeven * 100).toFixed(1)}%  gap ${((winRate - breakeven) * 100).toFixed(1)}pp`,
  );
  // Where does the plan put the stop and target, in percent of entry?
  const withPlan = book.filter((r) => r.entryPrice && r.stopPrice && r.targetPrice);
  const stopDist = mean(withPlan.map((r) => (Math.abs(r.stopPrice! - r.entryPrice!) / r.entryPrice!) * 100));
  const tgtDist = mean(withPlan.map((r) => (Math.abs(r.targetPrice! - r.entryPrice!) / r.entryPrice!) * 100));
  console.log(`         planned stop ${stopDist.toFixed(2)}% away, target ${tgtDist.toFixed(2)}% away, planned R:R ${(tgtDist / stopDist).toFixed(2)}x`);
}

/* ── 5. Outcome mix ──────────────────────────────────────────────────────── */
console.log("\n── 5. OUTCOME MIX — where each side's trades end ──");
for (const [label, book] of [["short", shorts], ["long", longs]] as Array<[string, Row[]]>) {
  const byOutcome = new Map<string, Row[]>();
  for (const r of book) {
    const o = (r.trade as Trade).outcome;
    byOutcome.set(o, [...(byOutcome.get(o) ?? []), r]);
  }
  console.log(`  ${label}:`);
  for (const [o, list] of [...byOutcome].sort((a, b) => b[1].length - a[1].length)) {
    const m = mean(list.map((r) => (r.trade as Trade).netReturnPct));
    console.log(
      `    ${o.padEnd(9)} n=${String(list.length).padStart(4)} ${((list.length / book.length) * 100).toFixed(0).padStart(3)}%  mean ${pct(m)}  contribution ${pct((m * list.length) / book.length)}`,
    );
  }
}

/* ── 6. Concentration: does one slice carry the whole number? ───────────── */
console.log("\n── 6. CONCENTRATION — the aggregate with the largest contributor removed ──");
{
  const byYear = new Map<string, Row[]>();
  for (const r of shorts) {
    const y = r.date.slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), r]);
  }
  for (const [y, list] of [...byYear].sort()) {
    const m = mean(list.map((r) => (r.trade as Trade).netReturnPct));
    const rest = shorts.filter((r) => r.date.slice(0, 4) !== y);
    console.log(
      `  ${y}  n=${String(list.length).padStart(4)}  exp ${pct(m)}   short book without ${y}: ${pct(mean(rest.map((r) => (r.trade as Trade).netReturnPct)))}`,
    );
  }
  const sorted = [...shorts].sort((a, b) => (a.trade as Trade).netReturnPct - (b.trade as Trade).netReturnPct);
  const drop = (n: number) => pct(mean(sorted.slice(n, sorted.length - n).map((r) => (r.trade as Trade).netReturnPct)));
  console.log(`  trimmed: drop 1 worst+best ${drop(1)}   drop 5 ${drop(5)}   drop 25 ${drop(25)}`);
  for (const a of ["BTC", "ETH"]) {
    const list = shorts.filter((r) => r.asset === a);
    console.log(`  ${a}  n=${list.length}  exp ${pct(mean(list.map((r) => (r.trade as Trade).netReturnPct)))}`);
  }
}

/* ── 7. Is the short expectancy distinguishable from a passive short? ───── */
console.log("\n── 7. THE VERDICT LINE ──");
{
  const b = blockBootstrap(rows, actualShort, null, 20260916);
  console.log(`  short net expectancy      ${pct(b.point)}  blockSE ${b.se.toFixed(3)}  t=${b.t.toFixed(2)}  (n=${b.nA}, ${b.blocks} blocks)`);
  const p = blockBootstrap(rows, passiveShort, null, 20260917);
  console.log(`  passive short, same days  ${pct(p.point)}  blockSE ${p.se.toFixed(3)}  t=${p.t.toFixed(2)}`);
  const vsPassive = blockBootstrap(rows, actualShort, passiveShort, 20260918);
  console.log(`  engine short - passive    ${pct(vsPassive.point)}  blockSE ${vsPassive.se.toFixed(3)}  t=${vsPassive.t.toFixed(2)}`);
  const allDays = blockBootstrap(rows, (r) => (isShort(r) ? null : null), null, 1);
  void allDays;
  const unconditional = mean(rows.map(fwd).filter((x): x is number => x !== null));
  console.log(`  for scale: unconditional 7d return across all ${rows.length} day-records ${pct(unconditional)} (a short gives up ${pct(-unconditional)} to drift by existing)`);
}

/* ── 8. Does biasScore discriminate at all? ─────────────────────────────── */
console.log("\n── 8. DOES THE SCORE DISCRIMINATE — forward 7d return by biasScore decile ──");
{
  const scored = rows.filter((r) => r.forwardReturn7d !== null).sort((a, b) => a.biasScore - b.biasScore);
  const size = Math.floor(scored.length / 10);
  const deciles: Row[][] = [];
  for (let i = 0; i < 10; i++) deciles.push(scored.slice(i * size, i === 9 ? scored.length : (i + 1) * size));
  for (let i = 0; i < 10; i++) {
    const d = deciles[i];
    const m = mean(d.map((r) => r.forwardReturn7d!));
    const lo = d[0].biasScore;
    const hi = d[d.length - 1].biasScore;
    const bar = "#".repeat(Math.max(0, Math.round(m * 2 + 6)));
    console.log(`  D${String(i + 1).padStart(2)}  score ${String(lo).padStart(2)}-${String(hi).padEnd(2)}  n=${String(d.length).padStart(4)}  fwd7d ${pct(m).padStart(8)}  ${bar}`);
  }
  // Bottom decile minus top decile: if the score works, LOW score => LOW forward return.
  const loSet = new Set(deciles[0].map((r) => `${r.asset}|${r.date}`));
  const hiSet = new Set(deciles[9].map((r) => `${r.asset}|${r.date}`));
  const spread = blockBootstrap(
    rows,
    (r) => (hiSet.has(`${r.asset}|${r.date}`) ? r.forwardReturn7d : null),
    (r) => (loSet.has(`${r.asset}|${r.date}`) ? r.forwardReturn7d : null),
    20260919,
  );
  console.log(`  top decile - bottom decile ${pct(spread.point)}  blockSE ${spread.se.toFixed(3)}  t=${spread.t.toFixed(2)}  (a working score makes this POSITIVE)`);

  // Spearman rank correlation, score vs forward return.
  const byScore = [...scored].sort((a, b) => a.biasScore - b.biasScore);
  const byRet = [...scored].sort((a, b) => a.forwardReturn7d! - b.forwardReturn7d!);
  const rankS = new Map(byScore.map((r, i) => [`${r.asset}|${r.date}`, i]));
  const rankR = new Map(byRet.map((r, i) => [`${r.asset}|${r.date}`, i]));
  const n = scored.length;
  let sd = 0;
  for (const r of scored) {
    const k = `${r.asset}|${r.date}`;
    sd += (rankS.get(k)! - rankR.get(k)!) ** 2;
  }
  const rho = 1 - (6 * sd) / (n * (n * n - 1));
  console.log(`  Spearman rho(biasScore, fwd7d) = ${rho.toFixed(4)} over n=${n}`);
}

/* ── 9. Point-in-time recentring counterfactual ─────────────────────────── */
console.log("\n── 9. COUNTERFACTUAL — what if the neutral point tracked the score's own history? ──");
{
  /*
   * `verdictFromScore` pivots on a hard 50. The score's median is 41, so the
   * pivot sits 9 points above the middle of the distribution the score
   * actually produces, and "bearish" collects 62% of days by construction.
   *
   * Recentring on the FULL-SAMPLE median would be look-ahead. This uses an
   * EXPANDING WINDOW: each day's pivot is the median of every score strictly
   * BEFORE it, seeded by the first 180 day-records. That is the honest version
   * and it is what a live implementation could actually compute.
   */
  const ordered = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const seen: number[] = [];
  const SEED = 180;
  let bear = 0;
  let bull = 0;
  let neut = 0;
  const bearRows: Row[] = [];
  const bullRows: Row[] = [];
  for (const r of ordered) {
    if (seen.length >= SEED) {
      const s = [...seen].sort((a, b) => a - b);
      const pivot = s[Math.floor(s.length / 2)];
      if (r.biasScore <= pivot - 6) {
        bear++;
        bearRows.push(r);
      } else if (r.biasScore >= pivot + 6) {
        bull++;
        bullRows.push(r);
      } else neut++;
    }
    seen.push(r.biasScore);
  }
  const tot = bear + bull + neut;
  console.log(`  pivot = expanding-window median (seeded ${SEED} records), same +/-6 band:`);
  console.log(`    bearish ${bear} (${((bear / tot) * 100).toFixed(1)}%)   neutral ${neut} (${((neut / tot) * 100).toFixed(1)}%)   bullish ${bull} (${((bull / tot) * 100).toFixed(1)}%)`);
  console.log(`    for comparison, the shipped hard-50 pivot: bearish 61.9%, neutral 25.1%, bullish 13.0%`);
  const bearSet = new Set(bearRows.map((r) => `${r.asset}|${r.date}`));
  const bullSet = new Set(bullRows.map((r) => `${r.asset}|${r.date}`));
  const bearFwd = mean(bearRows.map((r) => r.forwardReturn7d).filter((x): x is number => x != null));
  const bullFwd = mean(bullRows.map((r) => r.forwardReturn7d).filter((x): x is number => x != null));
  console.log(`    fwd7d on recentred-bearish days ${pct(bearFwd)}   on recentred-bullish days ${pct(bullFwd)}`);
  const sep = blockBootstrap(
    rows,
    (r) => (bullSet.has(`${r.asset}|${r.date}`) ? r.forwardReturn7d : null),
    (r) => (bearSet.has(`${r.asset}|${r.date}`) ? r.forwardReturn7d : null),
    20260920,
  );
  console.log(`    bullish - bearish separation ${pct(sep.point)}  blockSE ${sep.se.toFixed(3)}  t=${sep.t.toFixed(2)}`);
  // Same separation under the SHIPPED pivot, for a like-for-like comparison.
  const shipSep = blockBootstrap(
    rows,
    (r) => (r.biasVerdict === "bullish" ? r.forwardReturn7d : null),
    (r) => (r.biasVerdict === "bearish" ? r.forwardReturn7d : null),
    20260921,
  );
  console.log(`    shipped pivot, same statistic ${pct(shipSep.point)}  blockSE ${shipSep.se.toFixed(3)}  t=${shipSep.t.toFixed(2)}`);

  /*
   * THE OBVIOUS OBJECTION, TESTED RATHER THAN WAVED AWAY.
   *
   * Recentring moves the book from 62% short to 48% long over a window in
   * which crypto rose. "Be long more often in a bull market" earns drift and
   * would look exactly like this. Three checks:
   *
   *   (a) the SEPARATION is a difference between two legs on shared dates, so
   *       common drift cancels out of it by construction — but only if both
   *       legs exist in every era, so:
   *   (b) per-year separation, and
   *   (c) where the pivot actually sat, to see whether it is tracking the
   *       score or just sliding.
   */
  console.log("\n  (a) drift objection — per-year, both legs:");
  const years = [...new Set(ordered.map((r) => r.date.slice(0, 4)))].sort();
  for (const y of years) {
    const yb = bearRows.filter((r) => r.date.startsWith(y));
    const yl = bullRows.filter((r) => r.date.startsWith(y));
    const yAll = rows.filter((r) => r.date.startsWith(y) && r.forwardReturn7d != null);
    const bm = mean(yb.map((r) => r.forwardReturn7d).filter((x): x is number => x != null));
    const lm = mean(yl.map((r) => r.forwardReturn7d).filter((x): x is number => x != null));
    const am = mean(yAll.map((r) => r.forwardReturn7d!));
    const sepY = lm - bm;
    console.log(
      `    ${y}  bearish n=${String(yb.length).padStart(3)} ${pct(bm).padStart(8)}   bullish n=${String(yl.length).padStart(4)} ${pct(lm).padStart(8)}   sep ${pct(sepY).padStart(8)}   (all days that year ${pct(am)})`,
    );
  }

  console.log("\n  (c) where the expanding-window pivot actually sat:");
  const seen2: number[] = [];
  const marks = new Map<string, number>();
  for (const r of ordered) {
    if (seen2.length >= SEED) {
      const s = [...seen2].sort((a, b) => a - b);
      marks.set(r.date.slice(0, 7), s[Math.floor(s.length / 2)]);
    }
    seen2.push(r.biasScore);
  }
  const monthKeys = [...marks.keys()].sort();
  const sample = monthKeys.filter((_, i) => i % 6 === 0);
  console.log(`    ${sample.map((m) => `${m}:${marks.get(m)}`).join("  ")}`);
  console.log(`    (shipped pivot is the constant 50 at every one of these dates)`);
}
console.log();
