/**
 * FUNDING_BANDS calibration measurement — read-only.
 *
 *   npx tsx scripts/audit/fundingBands.ts [results.json]
 *
 * ENGINE_VERSION 9.0.0 shipped the funding SIGN fix and explicitly deferred the
 * band EDGES, saying the recalibration "needs its own measurement". This is that
 * measurement. It changes nothing; it prints what a recalibration would do.
 *
 * ── The question it was written to answer ──────────────────────────────
 *
 * `funding` carries the largest weight in METRIC_WEIGHTS (0.15, ~24% of the
 * crypto edge roster) and speaks on 1.1% of days, because +/-0.04%/8h is
 * roughly p99 of observed funding. A neutral metric is not an absentee: it adds
 * its weight to `totalWeight` while contributing 0 to `weightedSum`, so today
 * funding is a permanent 24%-weight damper toward 50.
 *
 * The obvious repair is percentile bands. The reason not to just do it is that
 * on the 30-33 days funding currently DOES speak it was measured to be a
 * perfect duplicate of squeezeRisk (n=30, 100% agreement) and a perfect inverse
 * of basis (n=33, 0% agreement). Making a redundant-or-contradictory voter
 * speak on most days at 24% of weight could be worse than leaving it mute. So
 * the test that matters is not "does funding predict" — it is "does funding
 * predict CONDITIONAL ON squeezeRisk and basis already voting".
 *
 * ── The question it actually answered ──────────────────────────────────
 *
 * Both bands read a rank, and when this script was first run that rank was
 * broken by ties. 26.8% of the replay sits at exactly 0.010000%/8h — the
 * Binance default — and `computeFundingPercentile` counted ties as BELOW
 * (`values.filter(v => v <= current)`), so the single most ordinary reading in
 * the series ranked at a median of p94, and squeezeRisk's largest component
 * read `|94 - 50| * 2 = 88` of 100 crowding on the most boring print the
 * exchange emits.
 *
 * *** 9.2.0 FIXED THAT, AND IT IS WHY THE COLUMN LABELS READ AS THEY DO. ***
 *
 * `computeFundingPercentile` now uses the midrank convention
 * `(below + 0.5*equal)/n`, and the replay bounds its lookback to the same
 * 30 days `readHistory` retains in production. So the two ranks this script
 * still evaluates every candidate band against are no longer
 * defective-vs-corrected. They are:
 *
 *   "shipped"  — read straight off results.json, i.e. what the ENGINE now
 *                computes: 30-day window, midrank ties. This is the one that
 *                matters; it is the deployed statistic.
 *   "midrank"  — this script's own reconstruction over an EXPANDING window of
 *                daily rows. Retained as a window-sensitivity arm: it answers
 *                "would a band edge survive if the lookback were four years
 *                instead of thirty days".
 *
 * Both are evaluated because a band edge that only works at one lookback is a
 * fitted constant, not a finding. The names are kept for continuity with the
 * 9.0.0/9.1.0 entries that quote this script's output.
 *
 * ── What this script refuses to do ─────────────────────────────────────
 *
 * It sweeps candidate edges and prints a forward-return spread for each. It
 * does NOT nominate the best one. Reading an edge off that table is picking a
 * constant off an outcome table — the guard already written into
 * pivotEffect.ts section 5. An edge has to be justified by what the band LABELS
 * assert ("Crowded Longs" names a tail, not a coin flip) and then measured, in
 * that order. Section 5 exists to answer "is there any signal here at all".
 *
 * ── Discipline ─────────────────────────────────────────────────────────
 *
 * Block bootstrap over the DATE axis, BTC and ETH drawn together so
 * cross-sectional correlation is absorbed by construction; BLOCK_DAYS = 10 >=
 * the 7d forward horizon so overlap is absorbed too; the statistic is re-formed
 * inside every replicate, because complementary subsets share dates and
 * treating them as independent is the quadrature error that turned t = -0.92
 * into -4.09 on the veto audit. Seeded LCG — Math.random() would make this
 * irreproducible.
 *
 * Both ranks are point-in-time. The shipped one is computed in the replay from
 * `fundingRate.filter(p => p.t < t && p.t >= t - HISTORY_RETENTION_MS)` —
 * strictly prior, bounded to 30 days. The midrank reconstruction below ranks
 * each day against ALL strictly-prior days of the SAME asset. Neither is
 * look-ahead. They differ in window and in granularity — the shipped rank sees
 * the 8-hourly series, the reconstruction sees daily rows — so the
 * reconstruction is a SENSITIVITY arm, not a drop-in replacement.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { FUNDING_BANDS, fundingBandVerdict } from "../../src/lib/sentiment/bands";
import { METRIC_WEIGHTS } from "../../src/lib/signals/scoring";

interface Row {
  asset: string;
  date: string;
  weightedFundingRatePct: number | null;
  fundingPercentile: number | null;
  basisPct: number | null;
  squeezeScore: number | null;
  biasVerdict: string | null;
  metrics: Array<{ id: string; verdict: string }>;
  forwardReturn7d: number | null;
  /** Tie-corrected expanding midrank, computed below. Not a replay field. */
  midrank?: number | null;
}

const path = process.argv[2] ?? resolve("scripts/backtest/data/results.json");
const rows: Row[] = JSON.parse(readFileSync(path, "utf8"));

/* Seeded — Math.random() would make this irreproducible across runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const BLOCK_DAYS = 10;
const DRAWS = 4000;
const SEED = 20260913;
/** Minimum rows on EACH side before a stratum contributes a difference. */
const MIN_ARM = 25;

type Verdict = "bullish" | "bearish" | "neutral";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
};
/** Share of the sample at or below `v`, in percent — the inverse of quantile. */
const rankOf = (sorted: number[], v: number) => {
  let below = 0;
  for (const x of sorted) if (x <= v) below++;
  return (below / sorted.length) * 100;
};
const pearson = (xs: number[], ys: number[]) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
};

const metricVerdict = (r: Row, id: string): Verdict =>
  (r.metrics?.find((m) => m.id === id)?.verdict as Verdict) ?? "neutral";

/**
 * Expanding midrank, per asset, strictly prior days only. Ties contribute half
 * their mass, which is the standard correction and the whole difference from
 * the shipped `below = v <= current` rule.
 */
function attachMidranks(all: Row[]) {
  for (const asset of new Set(all.map((r) => r.asset))) {
    const series = all.filter((r) => r.asset === asset).sort((a, b) => a.date.localeCompare(b.date));
    const prior: number[] = [];
    for (const r of series) {
      const v = r.weightedFundingRatePct;
      if (v === null || !Number.isFinite(v) || prior.length < 12) {
        r.midrank = null;
      } else {
        let below = 0;
        let equal = 0;
        for (const p of prior) {
          if (p < v) below++;
          else if (p === v) equal++;
        }
        r.midrank = ((below + 0.5 * equal) / prior.length) * 100;
      }
      if (v !== null && Number.isFinite(v)) prior.push(v);
    }
  }
}
attachMidranks(rows);

/**
 * Block bootstrap over the DATE axis. `stat` sees a whole resampled panel and
 * returns one number, so a difference between two SUBSETS is re-formed inside
 * every replicate rather than formed once from two independently-resampled
 * halves.
 */
function bootstrap(
  pool: Row[],
  stat: (sample: Row[]) => number | null,
  seed: number
): { point: number; se: number; t: number } {
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
  const point = stat(pool);
  const rand = lcg(seed);
  const reps: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const sample: Row[] = [];
    for (let k = 0; k < blocks.length; k++) sample.push(...blocks[Math.floor(rand() * blocks.length)]);
    const s = stat(sample);
    if (s !== null && Number.isFinite(s)) reps.push(s);
  }
  const m = mean(reps);
  const se = Math.sqrt(mean(reps.map((x) => (x - m) ** 2)));
  return { point: point ?? NaN, se, t: (point ?? NaN) / se };
}

const evaluable = rows.filter((r) => r.forwardReturn7d !== null);
const fundingValues = rows
  .map((r) => r.weightedFundingRatePct)
  .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  .sort((a, b) => a - b);

console.log(`\n=== FUNDING_BANDS CALIBRATION ===`);
console.log(`${rows.length} asset-days from ${path}`);
console.log(`${evaluable.length} carry forwardReturn7d; ${BLOCK_DAYS}-day blocks, ${DRAWS} draws, BTC+ETH together\n`);

// ── 1. Where the shipped edges actually sit ───────────────────────────

console.log(`--- 1. THE DISTRIBUTION THE EDGES ARE DRAWN ON ---\n`);
console.log(`weightedFundingRatePct, %/8h, pooled n=${fundingValues.length}`);
for (const q of [0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1]) {
  console.log(`  p${String(Math.round(q * 100)).padStart(3)}  ${quantile(fundingValues, q).toFixed(5)}`);
}
console.log(`  mean  ${mean(fundingValues).toFixed(5)}   sd ${sd(fundingValues).toFixed(5)}`);
console.log(`  share negative: ${((fundingValues.filter((v) => v < 0).length / fundingValues.length) * 100).toFixed(1)}%`);
console.log(`\nwhere the shipped band edges fall as percentiles of that sample:`);
for (const edge of [-0.15, -0.04, 0.04, 0.15]) {
  console.log(`  ${edge >= 0 ? "+" : ""}${edge.toFixed(2)}%/8h  ->  p${rankOf(fundingValues, edge).toFixed(2)}`);
}
for (const asset of [...new Set(rows.map((r) => r.asset))].sort()) {
  const v = rows
    .filter((r) => r.asset === asset)
    .map((r) => r.weightedFundingRatePct)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  console.log(
    `  ${asset}: median ${quantile(v, 0.5).toFixed(5)}  p99 ${quantile(v, 0.99).toFixed(5)}  max ${quantile(v, 1).toFixed(5)}  n=${v.length}`
  );
}

// ── 2. What the shipped bands do, and what the silence costs ──────────

console.log(`\n--- 2. THE SHIPPED BANDS TODAY ---\n`);
const shippedCounts = new Map<string, number>();
for (const r of rows) {
  if (r.weightedFundingRatePct === null) continue;
  const b = FUNDING_BANDS.find(
    (x) => (r.weightedFundingRatePct as number) >= x.min && (r.weightedFundingRatePct as number) <= x.max
  );
  shippedCounts.set(b?.label ?? "?", (shippedCounts.get(b?.label ?? "?") ?? 0) + 1);
}
for (const b of FUNDING_BANDS) {
  const n = shippedCounts.get(b.label) ?? 0;
  console.log(`  ${b.label.padEnd(16)} ${String(n).padStart(5)}  ${((n / rows.length) * 100).toFixed(2)}%`);
}
const shippedSpeaks = rows.filter(
  (r) => r.weightedFundingRatePct !== null && fundingBandVerdict(r.weightedFundingRatePct) !== "neutral"
);
const edgeWeight = Object.values(METRIC_WEIGHTS).reduce((a, b) => a + b, 0);
const share = (METRIC_WEIGHTS.funding / edgeWeight) * 100;
console.log(`\n  funding speaks on ${shippedSpeaks.length}/${rows.length} = ${((shippedSpeaks.length / rows.length) * 100).toFixed(2)}% of days`);
console.log(`  funding weight ${METRIC_WEIGHTS.funding} of ${edgeWeight.toFixed(2)} total = ${share.toFixed(1)}% of the roster`);
console.log(
  `  a neutral metric still enters totalWeight, so on ${((1 - shippedSpeaks.length / rows.length) * 100).toFixed(1)}% of days that ${share.toFixed(1)}% is a pure damper toward 50`
);

// ── 3. The rank is broken by ties, and the break is live ──────────────

console.log(`\n--- 3. THE RANK BOTH BAND SCHEMES READ ---\n`);
const counts = new Map<number, number>();
for (const v of fundingValues) counts.set(v, (counts.get(v) ?? 0) + 1);
const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
console.log(`  ${counts.size} distinct funding values across ${fundingValues.length} rows`);
console.log(
  `  modal value ${modal[0].toFixed(6)}%/8h occurs ${modal[1]} times = ${((modal[1] / fundingValues.length) * 100).toFixed(1)}% of the sample (the Binance default)`
);
console.log(
  `  mass strictly below it ${((fundingValues.filter((v) => v < modal[0]).length / fundingValues.length) * 100).toFixed(1)}%, above it ${((fundingValues.filter((v) => v > modal[0]).length / fundingValues.length) * 100).toFixed(1)}%`
);
const atModal = rows
  .filter((r) => r.weightedFundingRatePct === modal[0] && r.fundingPercentile !== null)
  .map((r) => r.fundingPercentile as number)
  .sort((a, b) => a - b);
const atModalMid = rows
  .filter((r) => r.weightedFundingRatePct === modal[0] && r.midrank != null)
  .map((r) => r.midrank as number)
  .sort((a, b) => a - b);
console.log(
  `\n  Before 9.2.0, computeFundingPercentile counted ties as BELOW and ranked this modal value at a`
);
console.log(
  `  median of p94, handing squeezeRisk |94-50|*2 = 88 of 100 crowding on the most ordinary print`
);
console.log(`  in the series. It now uses the midrank (below + 0.5*equal)/n. The modal value ranks at`);
console.log(
  `    shipped   (30d, midrank):  min p${atModal[0]}  median p${quantile(atModal, 0.5).toFixed(0)}  max p${atModal[atModal.length - 1]}   (n=${atModal.length})`
);
console.log(
  `    expanding (4y,  midrank):  min p${atModalMid[0].toFixed(0)}  median p${quantile(atModalMid, 0.5).toFixed(0)}  max p${atModalMid[atModalMid.length - 1].toFixed(0)}`
);
const shippedRanks = rows.filter((r) => r.fundingPercentile !== null).map((r) => r.fundingPercentile as number).sort((a, b) => a - b);
const midRanks = rows.filter((r) => r.midrank != null).map((r) => r.midrank as number).sort((a, b) => a - b);
console.log(`\n  a point-in-time rank should be roughly uniform. Quartiles of each (pre-9.2.0 was 24/43/91):`);
console.log(
  `    shipped   (30d, midrank):  p25 ${quantile(shippedRanks, 0.25).toFixed(0)}  median ${quantile(shippedRanks, 0.5).toFixed(0)}  p75 ${quantile(shippedRanks, 0.75).toFixed(0)}  (n=${shippedRanks.length})`
);
console.log(
  `    expanding (4y,  midrank):  p25 ${quantile(midRanks, 0.25).toFixed(0)}  median ${quantile(midRanks, 0.5).toFixed(0)}  p75 ${quantile(midRanks, 0.75).toFixed(0)}  (n=${midRanks.length})`
);
const modalRows = rows.filter((r) => r.weightedFundingRatePct === modal[0]);
const otherRows = rows.filter((r) => r.weightedFundingRatePct !== modal[0] && r.weightedFundingRatePct !== null);
const sqMean = (rs: Row[]) => mean(rs.map((r) => r.squeezeScore).filter((x): x is number => x != null));
const sqBear = (rs: Row[]) => (rs.filter((r) => metricVerdict(r, "squeezeRisk") === "bearish").length / rs.length) * 100;
console.log(
  `\n  THIS RANK IS LIVE. computeSqueezeRisk uses |percentile-50|*2 as "Funding crowding" at 0.35 weight,`
);
console.log(`  its single largest component, and positioning.ts renders it as a sentence to the user.`);
console.log(
  `  At the modal value's median rank of p${quantile(atModal, 0.5).toFixed(0)}, crowding now reads ${(Math.abs(quantile(atModal, 0.5) - 50) * 2).toFixed(0)} of 100 rather than 88.`
);
console.log(`  Downstream, on this replay (pre-9.2.0: 72.5 / 82.6% vs 59.4 / 75.3%):`);
console.log(
  `    modal-funding days  n=${modalRows.length}  mean squeezeScore ${sqMean(modalRows).toFixed(1)}  squeezeRisk bearish ${sqBear(modalRows).toFixed(1)}%`
);
console.log(
  `    every other day     n=${otherRows.length}  mean squeezeScore ${sqMean(otherRows).toFixed(1)}  squeezeRisk bearish ${sqBear(otherRows).toFixed(1)}%`
);

// ── 4. Candidate percentile bands: what would they say ────────────────

/**
 * Fade at the tails, mute in the middle — the convention 9.0.0 settled on,
 * moved from an absolute threshold to a rank. High funding relative to its own
 * history means longs are paying up, which reads bearish.
 */
type RankKind = "shipped" | "midrank";
const rankOfRow = (r: Row, kind: RankKind): number | null =>
  kind === "shipped" ? r.fundingPercentile : (r.midrank ?? null);

const candidateVerdict = (r: Row, lo: number, hi: number, kind: RankKind): Verdict => {
  const p = rankOfRow(r, kind);
  if (p === null) return "neutral";
  if (p >= hi) return "bearish";
  if (p <= lo) return "bullish";
  return "neutral";
};

const CANDIDATES: Array<[number, number]> = [
  [45, 55],
  [40, 60],
  [30, 70],
  [25, 75],
  [20, 80],
  [10, 90],
  [5, 95],
];

for (const kind of ["shipped", "midrank"] as RankKind[]) {
  console.log(`\n--- 4${kind === "shipped" ? "a" : "b"}. WHAT PERCENTILE BANDS WOULD VOTE (${kind} rank) ---\n`);
  console.log(`  band       speaks   bullish  bearish   bull leg negative   dup(squeeze)  dup(basis)`);
  for (const [lo, hi] of CANDIDATES) {
    const v = rows.map((r) => ({ r, v: candidateVerdict(r, lo, hi, kind) }));
    const speaks = v.filter((x) => x.v !== "neutral");
    const bull = v.filter((x) => x.v === "bullish");
    const bear = v.filter((x) => x.v === "bearish");
    const bullNeg = bull.filter((x) => (x.r.weightedFundingRatePct ?? 0) < 0).length;
    const bothSq = speaks.filter((x) => metricVerdict(x.r, "squeezeRisk") !== "neutral");
    const agreeSq = bothSq.filter((x) => metricVerdict(x.r, "squeezeRisk") === x.v).length;
    const bothBa = speaks.filter((x) => metricVerdict(x.r, "basis") !== "neutral");
    const agreeBa = bothBa.filter((x) => metricVerdict(x.r, "basis") === x.v).length;
    console.log(
      `  p${String(lo).padStart(2)}/p${String(hi).padStart(2)}  ${((speaks.length / rows.length) * 100).toFixed(1).padStart(6)}%  ${String(bull.length).padStart(7)}  ${String(bear.length).padStart(7)}   ${((bullNeg / Math.max(bull.length, 1)) * 100).toFixed(1).padStart(12)}%   ${((agreeSq / Math.max(bothSq.length, 1)) * 100).toFixed(1).padStart(11)}%  ${((agreeBa / Math.max(bothBa.length, 1)) * 100).toFixed(1).padStart(9)}%`
    );
  }
}
console.log(`\n  "bull leg negative" is the share of the BULLISH arm where funding is actually negative. Below 100%,`);
console.log(`  the band is calling "shorts are paying" on days when longs still are, just less than usual.`);
console.log(`  dup() are agreement rates on days where BOTH metrics speak — 100% is a duplicate vote, 0% a perfect inverse.`);

// ── 5. Standalone separation, with the refusal attached ───────────────

const spreadFor = (lo: number, hi: number, kind: RankKind) => (sample: Row[]) => {
  const bull = sample.filter((r) => r.forwardReturn7d !== null && candidateVerdict(r, lo, hi, kind) === "bullish");
  const bear = sample.filter((r) => r.forwardReturn7d !== null && candidateVerdict(r, lo, hi, kind) === "bearish");
  if (bull.length < MIN_ARM || bear.length < MIN_ARM) return null;
  return mean(bull.map((r) => r.forwardReturn7d as number)) - mean(bear.map((r) => r.forwardReturn7d as number));
};

/**
 * Stratified on the two voters funding was measured to duplicate. If funding's
 * separation survives inside cells where squeezeRisk and basis are held fixed,
 * it carries information they do not. If it collapses, the composite is being
 * handed the same vote twice at 24% of the weight.
 *
 * A cell contributes only when BOTH arms clear MIN_ARM. Without that guard a
 * cell with one bullish row reported a +19.6% spread and dominated the pooled
 * average — the one-slice failure, in miniature.
 */
const withinCellSpread = (lo: number, hi: number, kind: RankKind) => (sample: Row[]) => {
  const cells = new Map<string, Row[]>();
  for (const r of sample) {
    if (r.forwardReturn7d === null) continue;
    const k = `${metricVerdict(r, "squeezeRisk")}|${metricVerdict(r, "basis")}`;
    const list = cells.get(k) ?? [];
    list.push(r);
    cells.set(k, list);
  }
  let num = 0;
  let den = 0;
  for (const list of cells.values()) {
    const bull = list.filter((r) => candidateVerdict(r, lo, hi, kind) === "bullish");
    const bear = list.filter((r) => candidateVerdict(r, lo, hi, kind) === "bearish");
    if (bull.length < MIN_ARM || bear.length < MIN_ARM) continue;
    const d =
      mean(bull.map((r) => r.forwardReturn7d as number)) - mean(bear.map((r) => r.forwardReturn7d as number));
    const w = bull.length + bear.length;
    num += w * d;
    den += w;
  }
  return den ? num / den : null;
};

for (const kind of ["shipped", "midrank"] as RankKind[]) {
  console.log(`\n--- 5${kind === "shipped" ? "a" : "b"}. SEPARATION, STANDALONE AND CONDITIONAL (${kind} rank) ---\n`);
  console.log(`  bullish-minus-bearish forward 7d. Positive = the fade convention is right.`);
  console.log(`  conditional holds squeezeRisk and basis fixed across their 9 verdict cells; arms below ${MIN_ARM} drop.\n`);
  console.log(`  band      n_bull  n_bear      standalone            conditional        cells used`);
  for (const [lo, hi] of CANDIDATES) {
    const nb = evaluable.filter((r) => candidateVerdict(r, lo, hi, kind) === "bullish").length;
    const nr = evaluable.filter((r) => candidateVerdict(r, lo, hi, kind) === "bearish").length;
    const s = bootstrap(evaluable, spreadFor(lo, hi, kind), SEED);
    const c = bootstrap(evaluable, withinCellSpread(lo, hi, kind), SEED + 1);
    const cellsUsed = (() => {
      const m = new Map<string, Row[]>();
      for (const r of evaluable) {
        const k = `${metricVerdict(r, "squeezeRisk")}|${metricVerdict(r, "basis")}`;
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return [...m.values()].filter(
        (l) =>
          l.filter((r) => candidateVerdict(r, lo, hi, kind) === "bullish").length >= MIN_ARM &&
          l.filter((r) => candidateVerdict(r, lo, hi, kind) === "bearish").length >= MIN_ARM
      ).length;
    })();
    const fmt = (x: { point: number; se: number; t: number }) =>
      Number.isFinite(x.point) ? `${pct(x.point).padStart(8)} SE ${x.se.toFixed(2).padStart(5)} t ${x.t.toFixed(2).padStart(5)}` : `${"--".padStart(8)}                `;
    console.log(
      `  p${String(lo).padStart(2)}/p${String(hi).padStart(2)} ${String(nb).padStart(7)} ${String(nr).padStart(7)}   ${fmt(s)}   ${fmt(c)}     ${cellsUsed}/9`
    );
  }
  console.log(`\n  *** These columns do not choose the edge. ***`);
  console.log(`  Seven candidates on one sample is seven chances at a t of 2. The edge has to come from what the`);
  console.log(`  band LABELS assert and be measured after, not read off the argmax here.`);
}

// ── 6. Cell detail ────────────────────────────────────────────────────

console.log(`\n--- 6. CELL DETAIL, p30/p70, BOTH RANKS ---\n`);
for (const kind of ["shipped", "midrank"] as RankKind[]) {
  console.log(`  ${kind} rank:`);
  const cells = new Map<string, Row[]>();
  for (const r of evaluable) {
    const k = `${metricVerdict(r, "squeezeRisk")}|${metricVerdict(r, "basis")}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  for (const [k, list] of [...cells.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bull = list.filter((r) => candidateVerdict(r, 30, 70, kind) === "bullish");
    const bear = list.filter((r) => candidateVerdict(r, 30, 70, kind) === "bearish");
    const usable = bull.length >= MIN_ARM && bear.length >= MIN_ARM;
    const d = usable
      ? pct(mean(bull.map((r) => r.forwardReturn7d as number)) - mean(bear.map((r) => r.forwardReturn7d as number)))
      : "dropped";
    const [sq, ba] = k.split("|");
    console.log(
      `    squeeze ${sq.padEnd(8)} basis ${ba.padEnd(8)} n=${String(list.length).padStart(4)}  bull ${String(bull.length).padStart(4)} bear ${String(bear.length).padStart(4)}  spread ${d.padStart(9)}`
    );
  }
  console.log();
}

// ── 7. Breadth, and the one-slice check ───────────────────────────────

console.log(`--- 7. HOW MANY INDEPENDENT OBSERVATIONS IS THIS ---\n`);
const byDate = new Map<string, Row[]>();
for (const r of evaluable) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
const btcF: number[] = [];
const ethF: number[] = [];
for (const list of byDate.values()) {
  const b = list.find((r) => r.asset === "BTC");
  const e = list.find((r) => r.asset === "ETH");
  if (b?.forwardReturn7d != null && e?.forwardReturn7d != null) {
    btcF.push(b.forwardReturn7d);
    ethF.push(e.forwardReturn7d);
  }
}
const rho = pearson(btcF, ethF);
const nDates = byDate.size;
/*
 * N_eff applies WITHIN a date, across the 2 assets — not across all 2,892 rows.
 * BTC today and BTC eighteen months ago are not correlated at rho; feeding the
 * whole row count into n/(1+(n-1)rho) collapses the panel to ~1 and is wrong.
 */
const perDate = 2 / (1 + (2 - 1) * rho);
const nBlocks = Math.floor(nDates / BLOCK_DAYS);
console.log(`  rho(BTC fwd7d, ETH fwd7d) same-date = ${rho.toFixed(3)} over ${btcF.length} paired dates`);
console.log(`  within a date, N_eff = 2/(1+${rho.toFixed(3)}) = ${perDate.toFixed(2)} assets, so ${nDates} dates carry ~${(nDates * perDate).toFixed(0)} effective observations`);
console.log(`  the 7d horizon then binds harder: ${nBlocks} independent ${BLOCK_DAYS}-day blocks. That is the real ceiling, and`);
console.log(`  it is what the bootstrap above already resamples over.`);

console.log(`\n  per-asset p30/p70 standalone spread (a headline one asset owns is not a finding):`);
for (const kind of ["shipped", "midrank"] as RankKind[]) {
  for (const asset of [...new Set(evaluable.map((r) => r.asset))].sort()) {
    const only = evaluable.filter((r) => r.asset === asset);
    const s = bootstrap(only, spreadFor(30, 70, kind), SEED + 2);
    console.log(`    ${kind.padEnd(8)} ${asset}  ${pct(s.point).padStart(9)}  SE ${s.se.toFixed(3)}  t ${s.t.toFixed(2)}`);
  }
}

// ── 8. The replay's rank is not production's rank ─────────────────────

/**
 * *** THIS SECTION FOUND THE DEFECT 9.2.0 FIXED. Two of its four rows are now
 * closed; the other two are open and are the reason this section stays. ***
 *
 * Everything above measures the replay. Production computes the same field
 * from a different series, and when this section was first written the
 * difference was large enough that the two were not the same statistic:
 *
 *                        replay (pre-9.2.0)         production
 *   window               expanding, up to ~4y       rolling 30d (readHistory)
 *   tie rule             ties counted BELOW         (no ties to break)
 *   venue                Binance only               OI-weighted, ~20 venues
 *   points ranked        8-hourly, thousands        ~8-30
 *   ties at the 0.01     26.8% of the sample        none observed (102/109
 *   Binance baseline                                 distinct in .data)
 *
 * MEASURED AGAINST PRODUCTION on 2026-09-13, GET /api/market-data?asset=BTC:
 *
 *   weightedFundingRatePct  0.006713 %/8h
 *   fundingPercentile       65
 *   historyHours            715.2
 *   squeezeRisk "Funding crowding"  score 30 of 100, weight 0.35,
 *     "Funding at 0.67 bps/8h sits in the 65th percentile of its recorded range"
 *
 * Against that, the replay's MODAL day — 26.8% of it, the Binance baseline —
 * ranked p94 and scored |94-50|*2 = 88 of 100 on the same component, where
 * production's ordinary day scored 30. squeezeRisk is 0.14 of METRIC_WEIGHTS,
 * the second-largest entry, and that percentile is its largest component at
 * 0.35. So every squeezeRisk statistic in this file, and in the roster audit
 * that motivated it, was measured on a crowding input production does not
 * reproduce.
 *
 * ── WHAT 9.2.0 CLOSED, AND WHAT IT DID NOT ─────────────────────────────
 *
 * CLOSED: the window (`run.ts` now slices to `HISTORY_RETENTION_MS`, imported
 * rather than restated) and the tie rule (`computeFundingPercentile` uses the
 * midrank, a no-op on production's tie-free series). The rank went from
 * quartiles 24/43/91 — which is not a percentile — to 24/50/75.
 *
 * STILL OPEN, and not fixable by arithmetic: VENUE and POINT DENSITY. The
 * replay ranks ~90 8-hourly Binance prints; production ranks tens of
 * OI-weighted multi-venue readings. The two are now the same statistic over
 * the same window, which is what makes the comparison legitimate — they are
 * still not the same number. Closing the rest needs a multi-venue historical
 * funding source, which the corpus does not have.
 *
 * The printout below is regenerated every run, so the header row it prints
 * reflects the CURRENT replay, not the pre-9.2.0 one tabulated above.
 *
 * ── A LOCAL READING THAT LOOKED LIKE A PRODUCTION DEFECT, AND WAS NOT ──
 *
 * The table below reads .data/, which is gitignored DEV state written only
 * when the dev server runs. Locally every asset sits at 8 points on a ~94h
 * write cadence and therefore returns null against MIN_HISTORY_POINTS = 12.
 * That is a property of a laptop that rarely serves requests. Production
 * writes to Upstash KV on real traffic and had 715 hours of history when
 * probed. The table is kept because the arithmetic is a genuine fragility —
 * retention divided by write cadence has to exceed 12 or the gate never opens
 * — but it is NOT the deployed condition, and reporting it as one would have
 * been the local-store equivalent of a stale baseline.
 */
console.log(`\n--- 8. THE REPLAY'S RANK IS NOT PRODUCTION'S RANK ---\n`);
console.log(`  Production, GET /api/market-data?asset=BTC, probed 2026-09-13:`);
console.log(`    weightedFundingRatePct 0.006713 %/8h   fundingPercentile 65   historyHours 715.2`);
console.log(`    squeezeRisk "Funding crowding": score 30 of 100 at 0.35 weight`);
console.log(`  This replay's modal day (${((modal[1] / fundingValues.length) * 100).toFixed(1)}% of it, the Binance baseline) ranks p${quantile(atModal, 0.5).toFixed(0)} and scores ${(Math.abs(quantile(atModal, 0.5) - 50) * 2).toFixed(0)} of 100.`);
console.log(`\n                    replay                      production                  status`);
console.log(`    window          rolling 30d                 rolling 30d (readHistory)   CLOSED by 9.2.0`);
console.log(`    tie rule        midrank                     (no ties to break)          CLOSED by 9.2.0`);
console.log(`    venue           Binance only                OI-weighted multi-venue     OPEN`);
console.log(`    points ranked   ~90 8-hourly prints         tens of readings            OPEN`);
console.log(`    ties at 0.01    ${((modal[1] / fundingValues.length) * 100).toFixed(1)}% of the sample          none observed             handled by midrank`);
console.log(`\n  squeezeRisk is 0.14 of METRIC_WEIGHTS, second-largest. Its largest component reads this rank.`);
console.log(`  The window and tie rule now agree, so the replay measures the same STATISTIC production does.`);
console.log(`  Venue and density still differ, so it is not the same NUMBER. Treat replayed squeezeRisk as`);
console.log(`  evidence about the deployed engine's behaviour, not as a forecast of its exact readings.`);
console.log(`\n  The .data/ table below is DEV state, not production — see this section's doc comment.\n`);
const MIN_HISTORY_POINTS = 12;
const DATA_DIR = resolve(".data");
let liveRows: Array<{ asset: string; live: number; liveSpanH: number; daily: number; dailySpanD: number; distinct: number }> = [];
try {
  const files = readdirSync(DATA_DIR);
  const assets = files.filter((f) => /^[A-Z]+\.json$/.test(f)).map((f) => f.replace(".json", ""));
  for (const asset of assets.sort()) {
    const readPoints = (f: string) => {
      try {
        const parsed = JSON.parse(readFileSync(`${DATA_DIR}/${f}`, "utf8"));
        const arr = Array.isArray(parsed) ? parsed : [];
        return arr.filter((p: { weightedFundingRatePct?: unknown }) => typeof p.weightedFundingRatePct === "number");
      } catch {
        return [] as Array<{ t: number; weightedFundingRatePct: number }>;
      }
    };
    const live = readPoints(`${asset}.json`);
    const daily = readPoints(`${asset}-daily.json`);
    const spanH = live.length > 1 ? (live[live.length - 1].t - live[0].t) / 3_600_000 : 0;
    const spanD = daily.length > 1 ? (daily[daily.length - 1].t - daily[0].t) / 86_400_000 : 0;
    liveRows.push({
      asset,
      live: live.length,
      liveSpanH: spanH,
      daily: daily.length,
      dailySpanD: spanD,
      distinct: new Set(live.map((p) => p.weightedFundingRatePct)).size,
    });
  }
} catch {
  liveRows = [];
}

if (!liveRows.length) {
  console.log(`  .data/ not present — skipped. Run locally against a populated store to reproduce.`);
} else {
  console.log(`  computeFundingPercentile is fed readHistory(), the 30-DAY store, and needs ${MIN_HISTORY_POINTS} points.\n`);
  console.log(`  asset    30d pts  spanH  cadenceH  percentile?     3yr daily pts  spanDays`);
  for (const r of liveRows) {
    const cadence = r.live > 1 ? r.liveSpanH / (r.live - 1) : NaN;
    const verdictStr = r.live >= MIN_HISTORY_POINTS ? "computed" : `NULL (${r.live}<${MIN_HISTORY_POINTS})`;
    console.log(
      `  ${r.asset.padEnd(8)} ${String(r.live).padStart(7)} ${r.liveSpanH.toFixed(0).padStart(6)} ${cadence.toFixed(1).padStart(9)}  ${verdictStr.padEnd(14)} ${String(r.daily).padStart(13)} ${r.dailySpanD.toFixed(1).padStart(9)}`
    );
  }
  const nulls = liveRows.filter((r) => r.live < MIN_HISTORY_POINTS).length;
  const cadences = liveRows.map((r) => (r.live > 1 ? r.liveSpanH / (r.live - 1) : NaN)).filter(Number.isFinite);
  const medCad = quantile([...cadences].sort((a, b) => a - b), 0.5);
  const steady = (30 * 24) / medCad;
  console.log(`\n  ${nulls}/${liveRows.length} assets return NULL on this laptop.`);
  console.log(
    `  Write cadence ${medCad.toFixed(1)}h into a 30-day window is a steady state of ${steady.toFixed(1)} points, and ${steady.toFixed(1)} < ${MIN_HISTORY_POINTS}.`
  );
  console.log(
    `  PRODUCTION IS NOT IN THIS STATE — it had 715 hours of history and returned p65 when probed. The dev`
  );
  console.log(
    `  server simply does not serve enough requests to fill a 30-day store. Do not report this as a defect.`
  );
  console.log(`\n  What IS worth carrying forward is the arithmetic: retention / write-cadence must exceed`);
  console.log(`  ${MIN_HISTORY_POINTS} or the gate never opens, and nothing in the code asserts that. A traffic drop on a`);
  console.log(`  low-volume asset would silently mute squeezeRisk's largest component rather than warn.`);
  const totalDaily = liveRows.filter((r) => r.daily >= MIN_HISTORY_POINTS).length;
  console.log(
    `\n  dailyStore.ts holds the same weightedFundingRatePct field at 3-year retention and says it exists`
  );
  console.log(
    `  "purely to outlive that ceiling". computeFundingPercentile does not read it. ${totalDaily}/${liveRows.length} assets clear ${MIN_HISTORY_POINTS} in it`
  );
  console.log(`  even here, and it gains a point per UTC day against a 1,095-day window rather than a 30-day one.`);
}

console.log();
